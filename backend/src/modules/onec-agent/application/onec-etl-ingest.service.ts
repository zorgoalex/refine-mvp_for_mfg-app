import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import { PgOnecEtlRepository, type BatchRow, type RunRow } from '../adapters/pg-onec-etl-repository';
import { PgOnecRepository, type SourceRecord } from '../adapters/pg-onec-repository';
import { batchHeadersSchema, ONEC_ETL_LIMITS, sourceNamespaceOf, type BatchHeaders } from '../domain/onec-etl';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';
import type { OnecAgentContext } from './onec-audit';
import { OnecEtlParserService } from './onec-etl-parser.service';
import {
  countLines,
  drain,
  ensureSpoolDir,
  EtlLimitError,
  finalPath,
  freeBytes,
  partPath,
  persist,
  receiveToFile,
  removeQuietly,
  type EtlLimits,
} from './onec-etl-spool';

export interface BatchAck {
  batchId: string;
  status: 'acknowledged';
  rowsAccepted: number;
  checksumValid: true;
  acknowledgedAtUtc: string;
}

/** 503 that attests nothing was stored; the agent resends the same batch (agent to-erp/0002 §5.1). */
function notStored(message: string): ApiError {
  return new ApiError(503, 'BATCH_NOT_STORED_RETRYABLE', message, { retryAfterSeconds: 30 });
}

type Admission = { kind: 'ack'; ack: BatchAck } | { kind: 'owner'; owner: string; run: RunRow };

/**
 * `POST etl/batches` (spec §7.1, plan §6.5). The batch is durable (fsynced
 * spool file + stored row) before the ACK; parsing happens later.
 */
@Injectable()
export class OnecEtlIngestService {
  private readonly logger = new Logger(OnecEtlIngestService.name);
  /** Intake limits (agent to-erp/0003); a property so boundary tests can lower them. */
  limits: EtlLimits = { ...ONEC_ETL_LIMITS };
  private readonly activeByAgent = new Map<string, number>();
  private activeTotal = 0;
  private reservedBytes = 0;

  constructor(
    @Inject(PgOnecEtlRepository) private readonly etl: PgOnecEtlRepository,
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
    @Inject(OnecEtlParserService) private readonly parser: OnecEtlParserService,
  ) {}

  async upload(agent: OnecAgentContext, rawHeaders: Record<string, string | string[] | undefined>, body: Readable): Promise<BatchAck> {
    // A declared oversize body is refused before reading (plan §6.5: stop reading on a limit).
    const declared = Number(rawHeaders['content-length']);
    if (Number.isFinite(declared) && declared > this.limits.maxCompressedBytes) {
      throw new ApiError(413, 'BATCH_LIMIT_EXCEEDED', `compressed body exceeds ${this.limits.maxCompressedBytes} bytes`);
    }
    const headers = this.parseHeaders(rawHeaders);
    if (!headers) {
      await drain(body);
      throw new ApiError(400, 'INVALID_REQUEST', 'Invalid batch headers');
    }
    if (headers['idempotency-key'] !== headers['x-batch-id']) {
      await drain(body);
      throw new ApiError(400, 'INVALID_REQUEST', 'Idempotency-Key must equal X-Batch-Id');
    }

    // Stored batch: lock-free answer (original ACK or conflict), whatever the run state.
    const stored = await this.etl.getBatch(this.etl.db, headers['x-batch-id']);
    if (stored && stored.status !== 'receiving') {
      await drain(body);
      return this.answerStored(agent, stored, headers);
    }

    const admission = await this.admit(agent, headers);
    if (admission.kind === 'ack') {
      await drain(body);
      return admission.ack;
    }
    return this.receive(agent, headers, body, admission.owner, admission.run);
  }

  /** `GET etl/batches/{batchId}`: the original ACK, or 404 (also for another agent's batch). */
  async lookup(agent: OnecAgentContext, batchId: string): Promise<BatchAck> {
    const batch = await this.etl.getBatch(this.etl.db, batchId);
    if (!batch || batch.agentId !== agent.agentId || !batch.ack) throw new ApiError(404, 'BATCH_NOT_FOUND', 'Batch not stored');
    return batch.ack as unknown as BatchAck;
  }

  private parseHeaders(raw: Record<string, string | string[] | undefined>): BatchHeaders | null {
    const flat: Record<string, string> = {};
    for (const key of Object.keys(batchHeadersSchema.shape)) {
      const value = raw[key];
      if (Array.isArray(value)) return null;
      if (value !== undefined) flat[key] = value;
    }
    const parsed = batchHeadersSchema.safeParse(flat);
    return parsed.success ? parsed.data : null;
  }

  private answerStored(agent: OnecAgentContext, batch: BatchRow, headers: BatchHeaders): BatchAck {
    if (batch.agentId !== agent.agentId) throw new ApiError(404, 'BATCH_NOT_FOUND', 'Batch not found');
    if (batch.contentSha256 !== headers['x-content-sha256'] || batch.runId !== headers['x-run-id'] || batch.entityCode !== headers['x-entity']) {
      throw new ApiError(409, 'BATCH_CONFLICT', 'A different batch was stored under this batchId');
    }
    if (!batch.ack) throw new ApiError(409, 'BATCH_CONFLICT', 'The batch was not acknowledged');
    return batch.ack as unknown as BatchAck;
  }

  /**
   * One short transaction before any resource admission (plan §6.5 step 3):
   * run lock/create → batch lock → take over an unfinished attempt or reserve.
   */
  private async admit(agent: OnecAgentContext, headers: BatchHeaders): Promise<Admission> {
    const owner = randomUUID();
    return this.etl.transaction(async (tx): Promise<Admission> => {
      const source = await this.repository.getSource(tx, agent.sourceId);
      if (!source) throw new ApiError(403, 'SOURCE_UNKNOWN', 'Source is not registered');
      this.checkSource(source, headers);
      const run = await this.etl.lockOrCreateRun(tx, {
        runId: headers['x-run-id'],
        agentId: agent.agentId,
        sourceId: source.sourceId,
        generation: source.generation,
        generationRef: source.generationRef,
        namespace: headers['x-source-namespace'] ?? null,
      });
      checkRun(run, agent, source, headers);
      const batch = await this.etl.getBatch(tx, headers['x-batch-id'], true);
      if (batch && batch.status !== 'receiving') return { kind: 'ack', ack: this.answerStored(agent, batch, headers) };
      if (run.status !== 'receiving') throw new ApiError(409, 'RUN_CLOSED', 'The run is already closed');
      if (headers['x-source-namespace'] && !run.sourceNamespace) await this.etl.setRunNamespace(tx, run.runId, headers['x-source-namespace']);
      if (batch) {
        if (batch.agentId !== agent.agentId) throw new ApiError(404, 'BATCH_NOT_FOUND', 'Batch not found');
        if (batch.contentSha256 !== headers['x-content-sha256'] || batch.runId !== run.runId || batch.entityCode !== headers['x-entity']) {
          throw new ApiError(409, 'BATCH_CONFLICT', 'A different batch is being received under this batchId');
        }
        // The agent never sends one batch in parallel with itself: an unfinished attempt is abandoned work.
        await this.etl.supersedeReservation(tx, batch.batchId, owner);
      } else {
        await this.etl.insertReservation(tx, {
          batchId: headers['x-batch-id'],
          runId: run.runId,
          agentId: agent.agentId,
          entityCode: headers['x-entity'],
          schemaVersion: headers['x-schema-version'],
          rowCount: headers['x-row-count'],
          sha256: headers['x-content-sha256'],
          owner,
        });
      }
      return { kind: 'owner', owner, run };
    });
  }

  private checkSource(source: SourceRecord, headers: BatchHeaders): void {
    if (source.identityStatus === 'identity_changed') {
      throw new ApiError(409, 'SOURCE_IDENTITY_MISMATCH', 'The 1C database identity changed; an operator must resolve it');
    }
    const namespace = headers['x-source-namespace'];
    if (namespace && source.identityStatus === 'bound' && source.identity && namespace !== sourceNamespaceOf(source.identity)) {
      throw new ApiError(409, 'SOURCE_IDENTITY_MISMATCH', 'X-Source-Namespace differs from the bound 1C database');
    }
    const generation = headers['x-source-generation'];
    if (generation && generation !== source.generationRef) {
      throw new ApiError(409, 'RUN_GENERATION_CLOSED', 'The run belongs to a closed source generation');
    }
  }

  /** Resource admission, streaming, checks, durable publication; only this attempt's resources are touched. */
  private async receive(agent: OnecAgentContext, headers: BatchHeaders, body: Readable, owner: string, run: RunRow): Promise<BatchAck> {
    const batchId = headers['x-batch-id'];
    const expected = headers['content-length'] ?? this.limits.maxCompressedBytes;
    const slot = await this.acquireSlot(agent.agentId, expected);
    if (!slot.ok) {
      await this.etl.deleteReservation(this.etl.db, batchId, owner);
      await drain(body);
      throw notStored(slot.reason);
    }
    const config = this.runtime.get();
    const part = partPath(config.etlSpoolDir, batchId, owner);
    const target = finalPath(config.etlSpoolDir, batchId, owner);
    const abort = new AbortController();
    let superseded = false;
    const heartbeat = setInterval(() => {
      void this.etl.heartbeatReservation(this.etl.db, batchId, owner).then(
        (alive) => {
          if (!alive) {
            superseded = true;
            abort.abort();
          }
        },
        () => undefined,
      );
    }, ONEC_ETL_LIMITS.reservationHeartbeatMs);
    let published = false;
    let storeAttempted = false;
    try {
      let received: { sha256: string; bytes: number };
      try {
        received = await receiveToFile(body, part, abort.signal, this.limits.maxCompressedBytes);
      } catch (error) {
        if (superseded) throw new ApiError(409, 'BATCH_SUPERSEDED', 'A newer attempt of this batch took over');
        if (error instanceof EtlLimitError) {
          await drain(body);
          throw new ApiError(413, error.code, error.message);
        }
        throw error;
      }
      if (received.sha256 !== headers['x-content-sha256']) {
        throw new ApiError(422, 'BATCH_CHECKSUM_MISMATCH', 'X-Content-SHA256 does not match the body', { checksumValid: false });
      }
      let rows: number;
      let uncompressedBytes: number;
      try {
        ({ rows, uncompressedBytes } = await countLines(part, this.limits));
      } catch (error) {
        if (error instanceof EtlLimitError) {
          throw error.code === 'BATCH_GZIP_INVALID'
            ? new ApiError(422, 'BATCH_GZIP_INVALID', error.message)
            : new ApiError(413, 'BATCH_LIMIT_EXCEEDED', error.message);
        }
        throw error;
      }
      if (rows !== headers['x-row-count']) {
        throw new ApiError(422, 'BATCH_ROW_COUNT_MISMATCH', `X-Row-Count ${headers['x-row-count']} but the body has ${rows} rows`);
      }
      await persist(part, target);
      const ack: BatchAck = {
        batchId,
        status: 'acknowledged',
        rowsAccepted: rows,
        checksumValid: true,
        acknowledgedAtUtc: new Date().toISOString(),
      };
      storeAttempted = true;
      await this.etl.transaction(async (tx) => {
        const current = await this.etl.getRun(tx, run.runId, true);
        const source = await this.repository.getSource(tx, agent.sourceId);
        if (!current || current.status !== 'receiving') throw new ApiError(409, 'RUN_CLOSED', 'The run closed during the upload');
        if (!source || current.generationRef !== source.generationRef) {
          throw new ApiError(409, 'RUN_GENERATION_CLOSED', 'The source generation changed during the upload');
        }
        const ok = await this.etl.markStored(tx, {
          batchId,
          owner,
          spoolPath: target,
          ack: ack as unknown as Record<string, unknown>,
          compressedBytes: received.bytes,
          uncompressedBytes,
        });
        if (!ok) throw new ApiError(409, 'BATCH_SUPERSEDED', 'A newer attempt of this batch took over');
        await this.etl.touchFirstBatch(tx, run.runId);
      });
      published = true;
      this.parser.wake();
      return ack;
    } finally {
      clearInterval(heartbeat);
      this.releaseSlot(agent.agentId, expected);
      if (!published) {
        await this.cleanupAttempt(batchId, owner, part, target, storeAttempted);
      }
    }
  }

  /**
   * Removes only this attempt's resources. After the store transaction was
   * attempted its COMMIT may have succeeded even if we saw an error: the final
   * file is deleted only when the database provably does not reference it;
   * otherwise it stays (the orphan sweep removes unreferenced files later).
   */
  private async cleanupAttempt(batchId: string, owner: string, part: string, target: string, storeAttempted: boolean): Promise<void> {
    try {
      await this.etl.deleteReservation(this.etl.db, batchId, owner);
      await removeQuietly(part);
      if (storeAttempted) {
        const batch = await this.etl.getBatch(this.etl.db, batchId);
        if (batch?.spoolPath === target) return;
      }
      await removeQuietly(target);
    } catch (error) {
      // The monitor removes stale reservations and orphan files later.
      this.logger.warn(`1C batch attempt cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async acquireSlot(agentId: string, bytes: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const config = this.runtime.get();
    if ((this.activeByAgent.get(agentId) ?? 0) >= ONEC_ETL_LIMITS.uploadsPerAgent) return { ok: false, reason: 'Another upload of this agent is in progress' };
    if (this.activeTotal >= ONEC_ETL_LIMITS.uploadsPerBackend) return { ok: false, reason: 'Upload capacity is busy' };
    this.activeByAgent.set(agentId, (this.activeByAgent.get(agentId) ?? 0) + 1);
    this.activeTotal += 1;
    this.reservedBytes += bytes;
    try {
      await ensureSpoolDir(config.etlSpoolDir);
      const free = await freeBytes(config.etlSpoolDir);
      if (free - this.reservedBytes < config.etlSpoolMinFreeBytes) {
        this.releaseSlot(agentId, bytes);
        return { ok: false, reason: 'Not enough spool space' };
      }
      return { ok: true };
    } catch (error) {
      this.releaseSlot(agentId, bytes);
      this.logger.warn(`1C spool unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, reason: 'Spool unavailable' };
    }
  }

  private releaseSlot(agentId: string, bytes: number): void {
    const count = (this.activeByAgent.get(agentId) ?? 0) - 1;
    if (count <= 0) this.activeByAgent.delete(agentId);
    else this.activeByAgent.set(agentId, count);
    this.activeTotal = Math.max(0, this.activeTotal - 1);
    this.reservedBytes = Math.max(0, this.reservedBytes - bytes);
  }
}

/** Run checks under the run lock (plan §6.5 step 3). */
function checkRun(run: RunRow, agent: OnecAgentContext, source: SourceRecord, headers: BatchHeaders): void {
  if (run.agentId !== agent.agentId) throw new ApiError(404, 'RUN_NOT_FOUND', 'Run not found');
  if (run.generationRef !== source.generationRef) throw new ApiError(409, 'RUN_GENERATION_CLOSED', 'The run belongs to a closed source generation');
  const namespace = headers['x-source-namespace'];
  if (namespace && run.sourceNamespace && namespace !== run.sourceNamespace) {
    throw new ApiError(409, 'SOURCE_IDENTITY_MISMATCH', 'X-Source-Namespace differs within the run');
  }
}

