import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import { PgOnecEtlRepository, type BatchRow, type EntityOutcome, type RunRow } from '../adapters/pg-onec-etl-repository';
import { PgOnecRepository } from '../adapters/pg-onec-repository';
import { ONEC_ETL_LIMITS, parseCompletion, readInFull, sourceNamespaceOf, type Completion, type CompletionEntity, type EtlMode } from '../domain/onec-etl';
import { buildOnecEvent } from '../domain/onec-events';
import { OnecAuditWriter, type OnecAgentContext } from './onec-audit';
import { OnecEtlParserService } from './onec-etl-parser.service';

const sha256Hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const WAIT_STEP_MS = 500;

/** Outcome of the locked transaction; refusals that must keep their writes are thrown after commit. */
type Verdict = { kind: 'done' } | { kind: 'repeat' } | { kind: 'not_ready'; code: 'RUN_NOT_READY' | 'RUN_MODE_PENDING'; message: string };

/**
 * `POST etl/runs/{runId}/complete` (spec §7.2, plan §6.7, §20): staging of the
 * run's done entities becomes the mirror in one transaction; rows absent from
 * a full read are only marked missing.
 */
@Injectable()
export class OnecEtlCompletionService {
  constructor(
    @Inject(PgOnecEtlRepository) private readonly etl: PgOnecEtlRepository,
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(OnecAuditWriter) private readonly audit: OnecAuditWriter,
    @Inject(OnecEtlParserService) private readonly parser: OnecEtlParserService,
  ) {}

  async complete(agent: OnecAgentContext, runId: string, idempotencyKey: string | undefined, body: unknown, rawBody: Buffer | undefined, waitMs = ONEC_ETL_LIMITS.completeWaitMs): Promise<void> {
    if (!rawBody || rawBody.length === 0) throw new ApiError(400, 'INVALID_REQUEST', 'Empty completion body');
    const parsed = parseCompletion(body);
    if (!parsed.ok) throw new ApiError(400, 'INVALID_REQUEST', parsed.message);
    const completion = parsed.completion;
    if (completion.runId !== runId || (idempotencyKey ?? '').toLowerCase() !== runId) {
      throw new ApiError(400, 'INVALID_REQUEST', 'runId, path and Idempotency-Key must match');
    }
    const sha = sha256Hex(rawBody);
    await this.waitForParsing(agent, runId, waitMs);
    const verdict = await this.etl.transaction((tx) => this.finalize(tx, agent, completion, sha));
    if (verdict.kind === 'not_ready') throw new ApiError(503, verdict.code, verdict.message);
  }

  /** Outside any transaction: give the parser up to 25 s (the agent repeats complete on 503). */
  private async waitForParsing(agent: OnecAgentContext, runId: string, waitMs: number): Promise<void> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const run = await this.etl.getRun(this.etl.db, runId);
      if (!run || run.agentId !== agent.agentId || run.status !== 'receiving') return;
      const batches = await this.etl.listRunBatches(this.etl.db, runId);
      if (!batches.some((b) => b.status === 'receiving' || b.status === 'stored' || b.status === 'parsing')) return;
      if (Date.now() >= deadline) return;
      this.parser.wake();
      await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
    }
  }

  private async finalize(tx: DatabaseClient, agent: OnecAgentContext, completion: Completion, sha: string): Promise<Verdict> {
    const run = await this.etl.getRun(tx, completion.runId, true);
    if (!run || run.agentId !== agent.agentId) throw new ApiError(409, 'RUN_UNKNOWN', 'ERP has no batches of this run');
    const source = await this.repository.getSource(tx, run.sourceId);
    if (!source) throw new ApiError(409, 'RUN_UNKNOWN', 'Source is not registered');
    // Generation first: an old repeat must not confirm a watermark of a cleared mirror (plan §6.7 step 2).
    if (run.status === 'abandoned' || run.generationRef !== source.generationRef) {
      throw new ApiError(409, 'RUN_GENERATION_CLOSED', 'The run belongs to a closed source generation');
    }
    if (completion.sourceGeneration && completion.sourceGeneration !== source.generationRef) {
      throw new ApiError(409, 'RUN_GENERATION_CLOSED', 'sourceGeneration is not the current generation');
    }
    if (source.identityStatus === 'identity_changed') {
      throw new ApiError(409, 'SOURCE_IDENTITY_MISMATCH', 'The 1C database identity changed; an operator must resolve it');
    }
    if (completion.sourceIdentity) {
      const namespace = sourceNamespaceOf(completion.sourceIdentity);
      const bound = source.identityStatus === 'bound' && source.identity ? sourceNamespaceOf(source.identity) : null;
      if ((bound && namespace !== bound) || (run.sourceNamespace && namespace !== run.sourceNamespace)) {
        throw new ApiError(409, 'SOURCE_IDENTITY_MISMATCH', 'sourceIdentity differs from the bound 1C database');
      }
    }
    if (run.status === 'completed') {
      if (run.completionSha256 === sha) return { kind: 'repeat' };
      throw new ApiError(409, 'RUN_COMPLETION_CONFLICT', 'The run was completed with a different body');
    }

    const batches = await this.etl.listRunBatches(tx, run.runId, true);
    const acknowledged = batches.filter((b) => b.ack !== null);
    if (completion.batchesAcknowledged !== acknowledged.length) {
      throw new ApiError(409, 'RUN_BATCHES_MISMATCH', `ERP acknowledged ${acknowledged.length} batches of this run`, {
        erpAcknowledged: acknowledged.length,
      });
    }
    const invalid = batches.find((b) => b.status === 'invalid');
    if (invalid) {
      throw new ApiError(422, 'BATCH_PAYLOAD_INVALID', 'A batch of this run cannot be parsed', {
        batchId: invalid.batchId,
        reason: invalid.invalidReason,
      });
    }
    if (batches.some((b) => b.status !== 'parsed')) {
      return { kind: 'not_ready', code: 'RUN_NOT_READY', message: 'Batches of this run are still being parsed' };
    }
    // UNLOGGED staging is empty after a PostgreSQL restart: parse those batches again.
    let requeued = false;
    for (const batch of batches) {
      if ((await this.etl.stagingCount(tx, batch.batchId)) !== batch.rowCount) {
        await this.etl.requeueForParse(tx, batch.batchId);
        requeued = true;
      }
    }
    if (requeued) {
      this.parser.wake();
      return { kind: 'not_ready', code: 'RUN_NOT_READY', message: 'Batches of this run are being parsed again' };
    }

    checkEntities(completion, batches);
    const resolved = await this.resolveMode(tx, run, completion);
    if (!resolved) return { kind: 'not_ready', code: 'RUN_MODE_PENDING', message: 'The result of the ETL command has not arrived yet' };

    const outcomes: EntityOutcome[] = [];
    for (const entity of entitiesOf(completion, batches)) {
      const hasBatches = batches.some((b) => b.entityCode === entity.entity);
      const fullRead = entity.status === 'done' && hasBatches && readInFull(entity, resolved.mode);
      await this.etl.lockEntityState(tx, run.sourceId, entity.entity);
      if (entity.status === 'done' && hasBatches) {
        await this.etl.publishEntity(tx, run, entity.entity);
        if (fullRead) await this.etl.markMissing(tx, run, entity.entity);
      }
      const outcome: EntityOutcome = {
        entityCode: entity.entity,
        status: entity.status,
        readScope: entity.readScope,
        completeness: entity.completeness,
        completenessReason: entity.completenessReason,
        snapshotAt: entity.snapshotAtUtc,
        errorCode: entity.errorCode,
        errorMessage: entity.errorMessage,
        fullRead,
      };
      await this.etl.updateEntityState(tx, run, outcome);
      outcomes.push(outcome);
    }

    const summary = outcomes.map((o) => ({
      entity: o.entityCode,
      status: o.status,
      readScope: o.readScope,
      fullRead: o.fullRead,
      completeness: o.completeness,
      errorCode: o.errorCode,
      rows: batches.filter((b) => b.entityCode === o.entityCode).reduce((sum, b) => sum + b.rowCount, 0),
    }));
    await this.etl.completeRun(tx, {
      runId: run.runId,
      mode: resolved.mode,
      modeOrigin: resolved.origin,
      sha256: sha,
      completion: { version: completion.version, status: completion.status, entities: summary },
      entitiesFailed: outcomes.filter((o) => o.status === 'failed').length,
    });
    await this.audit.byAgent(
      tx,
      agent,
      {
        event: 'onec.etl.run_completed',
        entityType: 'onec_etl_run',
        entityId: run.runId,
        after: { mode: resolved.mode, modeOrigin: resolved.origin, status: completion.status, batches: batches.length, entities: summary },
        statusField: 'status',
        statusCode: 'completed',
      },
      { runId: run.runId, sourceGeneration: run.sourceGeneration },
    );
    await this.repository.insertOutboxEvent(
      tx,
      buildOnecEvent({
        eventType: 'onec.etl.run_completed',
        severity: outcomes.some((o) => o.status === 'failed') ? 'warning' : 'info',
        actor: { kind: 'onec_agent', id: agent.agentId },
        agentId: agent.agentId,
        sourceId: run.sourceId,
        subject: { type: 'onec_etl_run', id: run.runId },
        requestId: agent.requestId,
        correlationId: agent.correlationId,
        data: { runId: run.runId, mode: resolved.mode, sourceGeneration: run.sourceGeneration, entities: summary },
        idempotencyKey: `onec.etl.run_completed:${run.runId}`,
      }),
    );
    return { kind: 'done' };
  }

  /**
   * Mode (plan §6.7 step 3): from the body; else from the ETL command result;
   * else 503 while an ETL command is still in flight; else a scheduled incremental run.
   */
  private async resolveMode(tx: DatabaseClient, run: RunRow, completion: Completion): Promise<{ mode: EtlMode; origin: string } | null> {
    if (completion.mode) return { mode: completion.mode, origin: 'complete_body' };
    if (run.mode) return { mode: run.mode as EtlMode, origin: run.modeOrigin ?? 'command_result' };
    // Only needed when some entity has no readScope (plan §6.7 step 3).
    if (completion.entities && completion.entities.every((e) => e.readScope !== null)) return { mode: 'incremental', origin: 'no_pending_etl_command' };
    if (await this.etl.hasPendingEtlCommand(tx, run.agentId)) return null;
    return { mode: 'incremental', origin: 'no_pending_etl_command' };
  }
}

/**
 * The body must account for every entity that has batches (spec §7.2: each
 * entity of the run exactly once) and agree with its own totals; otherwise a
 * batch could be finalized without ever being published. Refused unchanged.
 */
function checkEntities(completion: Completion, batches: BatchRow[]): void {
  if (!completion.entities) return; // v1: every entity of the run is done
  const listed = completion.entities.map((e) => e.entity);
  const mismatch = (message: string) => new ApiError(409, 'RUN_ENTITIES_MISMATCH', message);
  if (new Set(listed).size !== listed.length) throw mismatch('An entity is listed more than once');
  const missing = [...new Set(batches.map((b) => b.entityCode))].filter((code) => !listed.includes(code));
  if (missing.length > 0) throw mismatch(`Entities with batches are missing from the body: ${missing.join(', ')}`);
  const failed = completion.entities.filter((e) => e.status === 'failed').length;
  if (completion.entitiesFailed !== failed) throw mismatch('entitiesFailed does not match the entities list');
  if ((completion.status === 'succeeded') !== (failed === 0)) throw mismatch('status does not match the failed entities');
}

/** Entities of the run: the body's list (v2/partial), else every entity that has batches (v1: all done). */
function entitiesOf(completion: Completion, batches: BatchRow[]): CompletionEntity[] {
  const list = completion.entities
    ? completion.entities
    : [...new Set(batches.map((b) => b.entityCode))].map((entity) => ({
        entity,
        status: 'done' as const,
        readScope: null,
        rowsRead: 0,
        errorCode: null,
        errorMessage: null,
        completeness: null,
        completenessReason: null,
        snapshotAtUtc: null,
      }));
  // Deterministic lock order across concurrent completions.
  return [...list].sort((a, b) => (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0));
}
