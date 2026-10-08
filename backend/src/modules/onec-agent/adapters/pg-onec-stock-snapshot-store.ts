import { Inject, Injectable } from '@nestjs/common';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { OnecAuditWriter } from '../application/onec-audit';
import { buildOnecEvent } from '../domain/onec-events';
import type { StockSnapshotStatus } from '../onec-stock-snapshots.port';
import { PgOnecRepository } from './pg-onec-repository';

export const STOCK_SNAPSHOT_ACTOR = 'onec_stock_snapshots';
/** Who performs a transition: the queue (system) or a user (request, delete). */
export type StockSnapshotActor = { kind: 'system'; requestId: string } | { kind: 'user'; user: CurrentUser; requestId: string };

export interface StockSnapshotRecord {
  id: number;
  sourceId: number;
  agentId: string;
  generationRef: string;
  sourceGeneration: number;
  momentLocal: string;
  status: StockSnapshotStatus;
  waitReason: string | null;
  requestedBy: number | null;
  requestId: string;
  correlationId: string;
  configVersion: number | null;
  commandId: string | null;
  runId: string | null;
  configPublishedAt: Date | null;
  syncingAt: Date | null;
  deletedAt: Date | null;
}

const RECORD_COLUMNS = `snapshot_id, source_id, agent_id, generation_ref::text AS generation_ref, source_generation,
  to_char(moment_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS moment_local, status, wait_reason, requested_by, request_id, correlation_id,
  config_version, command_id::text AS command_id, run_id::text AS run_id, config_published_at, syncing_at, deleted_at`;

function toRecord(row: Record<string, unknown>): StockSnapshotRecord {
  return {
    id: Number(row.snapshot_id), sourceId: Number(row.source_id), agentId: String(row.agent_id), generationRef: String(row.generation_ref),
    sourceGeneration: Number(row.source_generation), momentLocal: String(row.moment_local), status: row.status as StockSnapshotStatus,
    waitReason: (row.wait_reason as string | null) ?? null, requestedBy: row.requested_by === null ? null : Number(row.requested_by),
    requestId: String(row.request_id), correlationId: String(row.correlation_id),
    configVersion: row.config_version === null ? null : Number(row.config_version), commandId: (row.command_id as string | null) ?? null,
    runId: (row.run_id as string | null) ?? null, configPublishedAt: (row.config_published_at as Date | null) ?? null,
    syncingAt: (row.syncing_at as Date | null) ?? null, deletedAt: (row.deleted_at as Date | null) ?? null,
  };
}

/**
 * Rows of stock snapshots and the transitions that more than one path performs (the queue, the delete command, a
 * rebaseline of the source): every transition goes from an expected status, and writes its audit row and its
 * outbox event in the caller's transaction.
 */
@Injectable()
export class PgOnecStockSnapshotStore {
  constructor(
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(OnecAuditWriter) private readonly audit: OnecAuditWriter,
  ) {}

  /** Migration 250 is applied (the backend may run ahead of it). */
  async installed(client: DatabaseClient): Promise<boolean> {
    return (await client.query<{ ok: boolean }>(`SELECT to_regclass('onec_stock_snapshots') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  }

  async lock(tx: DatabaseClient, snapshotId: number): Promise<StockSnapshotRecord | null> {
    const row = (await tx.query(`SELECT ${RECORD_COLUMNS} FROM onec_stock_snapshots WHERE snapshot_id = $1 FOR UPDATE`, [snapshotId])).rows[0];
    return row ? toRecord(row) : null;
  }

  /** The earliest waiting snapshot of a source, locked. */
  async lockNextRequested(tx: DatabaseClient, sourceId: number): Promise<StockSnapshotRecord | null> {
    const row = (await tx.query(
      `SELECT ${RECORD_COLUMNS} FROM onec_stock_snapshots
        WHERE source_id = $1 AND status = 'requested' AND deleted_at IS NULL
        ORDER BY requested_at, snapshot_id LIMIT 1 FOR UPDATE`, [sourceId])).rows[0];
    return row ? toRecord(row) : null;
  }

  /** Snapshots of a source that are not final, oldest first, locked. */
  async lockUnfinished(tx: DatabaseClient, sourceId: number): Promise<StockSnapshotRecord[]> {
    const { rows } = await tx.query(
      `SELECT ${RECORD_COLUMNS} FROM onec_stock_snapshots
        WHERE source_id = $1 AND status IN ('requested', 'config_published', 'syncing')
        ORDER BY requested_at, snapshot_id FOR UPDATE`, [sourceId]);
    return rows.map(toRecord);
  }

  async setWaitReason(tx: DatabaseClient, snapshot: StockSnapshotRecord, reason: string | null): Promise<void> {
    if (snapshot.waitReason === reason) return;
    await tx.query(`UPDATE onec_stock_snapshots SET wait_reason = $2, updated_at = now() WHERE snapshot_id = $1 AND status = 'requested'`, [snapshot.id, reason]);
  }

  /**
   * A snapshot that is not final becomes `failed`. Returns false when it is final already (a repeated step, a late
   * result): nothing is written then. The actor is the system; who requested the snapshot is linked.
   */
  async fail(
    tx: DatabaseClient, snapshot: StockSnapshotRecord, errorCode: string, errorMessage: string | null,
    actor: StockSnapshotActor = { kind: 'system', requestId: snapshot.requestId },
  ): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE onec_stock_snapshots
          SET status = 'failed', failed_at = now(), updated_at = now(), wait_reason = NULL, error_code = $2, error_message = $3,
              run_id = COALESCE($4::uuid, run_id)
        WHERE snapshot_id = $1 AND status IN ('requested', 'config_published', 'syncing')`,
      // The run the failure was found in (when there is one) stays with the snapshot, its audit link and its event.
      [snapshot.id, errorCode.slice(0, 128), errorMessage === null ? null : errorMessage.slice(0, 500), snapshot.runId]);
    if ((rowCount ?? 0) === 0) return false;
    await this.event(tx, snapshot, 'failed', { errorCode, previousStatus: snapshot.status }, actor);
    return true;
  }

  /**
   * The audit row and the outbox event of a transition, in the caller's transaction. The outbox key is stable
   * per snapshot and event: a repeated step does not duplicate it.
   */
  async event(
    tx: DatabaseClient, snapshot: StockSnapshotRecord, event: 'requested' | 'ready' | 'failed' | 'deleted', details: Record<string, unknown>,
    actor: StockSnapshotActor,
  ): Promise<void> {
    const after = {
      status: event === 'requested' ? 'requested' : event === 'deleted' ? 'deleted' : event, momentLocal: snapshot.momentLocal, sourceId: snapshot.sourceId,
      generationRef: snapshot.generationRef, configVersion: snapshot.configVersion, commandId: snapshot.commandId, runId: snapshot.runId, ...details,
    };
    const link = {
      agentId: snapshot.agentId, sourceId: snapshot.sourceId, sourceGeneration: snapshot.sourceGeneration, configVersion: snapshot.configVersion,
      commandId: snapshot.commandId, runId: (details.runId as string | undefined) ?? snapshot.runId, correlationId: snapshot.correlationId,
    };
    const audited = {
      event: `onec.stock_snapshot.${event}`, entityType: 'onec_stock_snapshot', entityId: snapshot.id,
      relatedUserId: snapshot.requestedBy, relatedEntities: [{ entityType: 'onec_stock_snapshot', entityId: snapshot.id }],
      before: {}, after,
      // Normalized status dimensions: `deleted` is recorded as its own status code of the same field.
      statusField: 'status', statusCode: after.status,
    };
    if (actor.kind === 'user') {
      await this.audit.byUser(tx, actor.user, { requestId: actor.requestId, correlationId: snapshot.correlationId }, audited, link);
    } else {
      await this.audit.bySystem(tx, STOCK_SNAPSHOT_ACTOR, actor.requestId, audited, link);
    }
    // The common envelope of module events: a subscriber reads the actor, the subject and the data the same way
    // as for every other event of the module. The key is stable per snapshot and event.
    await this.repository.insertOutboxEvent(tx, buildOnecEvent({
      eventType: `onec.stock_snapshot.${event}`,
      severity: event === 'failed' && details.errorCode !== 'CANCELLED' ? 'warning' : 'info',
      actor: actor.kind === 'user' ? { kind: 'user', id: String(actor.user.id) } : { kind: 'system', id: STOCK_SNAPSHOT_ACTOR },
      agentId: snapshot.agentId,
      sourceId: snapshot.sourceId,
      subject: { type: 'onec_stock_snapshot', id: String(snapshot.id) },
      requestId: actor.requestId,
      correlationId: snapshot.correlationId,
      data: { requestedBy: snapshot.requestedBy, ...after },
      idempotencyKey: `onec.stock_snapshot.${event}:${snapshot.id}`,
    }));
  }

  /**
   * The 1C base of a source is being replaced (rebaseline): every unfinished snapshot of the source fails now,
   * before the mirror is cleared. Lock order of the caller: agent → source → (here) slot → snapshots.
   */
  async failOnGenerationChange(tx: DatabaseClient, sourceId: number, requestId: string): Promise<number> {
    if (!(await this.installed(tx))) return 0;
    await tx.query(`SELECT 1 FROM onec_stock_snapshot_slot WHERE source_id = $1 FOR UPDATE`, [sourceId]);
    let failed = 0;
    for (const snapshot of await this.lockUnfinished(tx, sourceId)) {
      if (await this.fail(tx, snapshot, 'SOURCE_GENERATION_CHANGED', 'База 1С источника заменена, пока срез не был готов', { kind: 'system', requestId })) failed += 1;
    }
    return failed;
  }
}
