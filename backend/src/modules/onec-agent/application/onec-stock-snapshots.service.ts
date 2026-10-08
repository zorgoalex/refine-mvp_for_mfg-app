import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgOnecRepository } from '../adapters/pg-onec-repository';
import { PgOnecStockSnapshotStore, STOCK_SNAPSHOT_ACTOR, type StockSnapshotRecord } from '../adapters/pg-onec-stock-snapshot-store';
import { STOCK_SNAPSHOT_ENTITY_CODE } from '../domain/onec-managed-entities';
import {
  COMMAND_DELIVERY_TIMEOUT_MS, CONFIG_APPLY_TIMEOUT_MS, SLOT_STUCK_MS, STALE_ACTIVITY_MS, SYNC_DEADLINE_MS,
  agentSupportsStockSnapshots, isLocalMoment, startWindowReason, type StockSnapshotWaitReason,
} from '../domain/onec-stock-snapshot-rules';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';
import {
  STOCK_SNAPSHOT_MAX_ROWS,
  type OnecStockSnapshotsPort, type StockSnapshotCapabilities, type StockSnapshotListFilter, type StockSnapshotRequest, type StockSnapshotRow,
  type StockSnapshotStatus, type StockSnapshotView, type StockSnapshotWarehouseSummary,
} from '../onec-stock-snapshots.port';
import { OnecAdminService } from './onec-admin.service';
import { OnecAlertsPort } from './onec-alerts-port';
import { OnecCommandsService } from './onec-commands.service';
import { OnecEtlEvents } from './onec-etl-events';

const TICK_MS = 15_000;
const SOURCE_MODULE = 'onec_stock_snapshots';
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
/** A 1C key of the mirror row as a uuid, or NULL for «not set» (empty, the zero guid) or a malformed value. */
const keyOf = (field: string) =>
  `CASE WHEN lower(m.data->>'${field}') ~ '${UUID}' AND lower(m.data->>'${field}') <> '${ZERO_GUID}' THEN lower(m.data->>'${field}')::uuid END`;
const NUMERIC = `'^-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?$'`;

const VIEW_SELECT = `
  SELECT sn.snapshot_id, sn.source_id, sn.generation_ref::text AS generation_ref, (s.generation_ref = sn.generation_ref) AS current_source,
         to_char(sn.moment_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS moment_local, sn.moment_utc, sn.time_zone, sn.status, sn.wait_reason, sn.error_code,
         sn.requested_by, sn.requested_by_name, sn.requested_at, sn.updated_at, sn.read_at, sn.ready_at, sn.rows_count, sn.deleted_at,
         (SELECT count(*)::int FROM onec_stock_snapshots e
           WHERE e.source_id = sn.source_id AND e.deleted_at IS NULL AND e.status = 'requested'
             AND (e.requested_at, e.snapshot_id) < (sn.requested_at, sn.snapshot_id)) AS waiting_ahead,
         EXISTS (SELECT 1 FROM onec_stock_snapshots e
                  WHERE e.source_id = sn.source_id AND e.deleted_at IS NULL AND e.snapshot_id <> sn.snapshot_id
                    AND (e.status IN ('config_published', 'syncing')
                         OR (e.status = 'requested' AND (e.requested_at, e.snapshot_id) < (sn.requested_at, sn.snapshot_id)))) AS active_ahead
    FROM onec_stock_snapshots sn JOIN onec_sources s ON s.source_id = sn.source_id`;

function toView(row: Record<string, unknown>): StockSnapshotView {
  const status = row.status as StockSnapshotStatus;
  const final = status === 'ready' || status === 'failed';
  const reading = status === 'config_published' || status === 'syncing';
  const iso = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string | Date).toISOString());
  return {
    id: Number(row.snapshot_id), sourceId: Number(row.source_id), currentSource: row.current_source === true, baseRef: String(row.generation_ref),
    momentLocal: String(row.moment_local), momentUtc: iso(row.moment_utc)!, timeZone: String(row.time_zone), status,
    waitReason: (row.wait_reason as string | null) ?? null, errorCode: (row.error_code as string | null) ?? null,
    requestedBy: row.requested_by === null ? null : { id: Number(row.requested_by), name: (row.requested_by_name as string | null) ?? null },
    requestedAt: iso(row.requested_at)!, updatedAt: iso(row.updated_at)!, readAt: iso(row.read_at), readyAt: iso(row.ready_at),
    rowsCount: row.rows_count === null ? null : Number(row.rows_count),
    queuePosition: final ? null : reading ? 0 : Number(row.waiting_ahead) + 1, activeAhead: !final && !reading && row.active_ahead === true, deletedAt: iso(row.deleted_at),
  };
}

interface SourceState {
  sourceId: number; agentId: string; generationRef: string; generation: number; databaseId: string | null; timeZone: string;
  agentStatus: string; publishBlocked: boolean; expectedSilenceUtc: string | null;
  agentVersion: string | null; receivedAt: Date | null; activeConfigVersion: number | null; rejectedConfigVersion: number | null;
  hasPublishedConfig: boolean;
}

/**
 * Stock snapshots at a date: the port for the inventory module and the queue that drives the agent
 * (plan 2026-10-08-onec-stock-snapshots, §3).
 *
 * Integrity: rows of a snapshot are taken ONLY from the ETL run linked to the command of THIS snapshot, and only
 * if, under the lock of the entity state, the mirror is exactly that run. The command is queued after the agent
 * confirmed the version with the snapshot's period, and the period of the slot never changes while its owner is
 * not final. A stray command of an earlier snapshot may still run later and read the set with another period —
 * its rows go nowhere; at worst the next snapshot fails with SNAPSHOT_REPLACED and is requested again.
 *
 * Lock order (shared with operator publications, revocation and rebaseline): agent → source → slot → snapshot →
 * entity state. Agent and source rows are locked FOR NO KEY UPDATE in every step.
 */
@Injectable()
export class OnecStockSnapshotsService implements OnecStockSnapshotsPort, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnecStockSnapshotsService.name);
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private running = false;

  constructor(
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PgOnecRepository) private readonly repository: PgOnecRepository,
    @Inject(PgOnecStockSnapshotStore) private readonly store: PgOnecStockSnapshotStore,
    @Inject(OnecAdminService) private readonly admin: OnecAdminService,
    @Inject(OnecCommandsService) private readonly commands: OnecCommandsService,
    @Inject(OnecAlertsPort) private readonly alerts: OnecAlertsPort,
    @Inject(OnecEtlEvents) private readonly events: OnecEtlEvents,
  ) {}

  // ------------------------------------------------------------------ lifecycle

  onModuleInit(): void {
    const config = this.runtime.get();
    // The queue also runs with the flag off: it finishes what was started and switches the service set off.
    if (!config.enabled || config.monitorOwner !== 'in_process') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    this.unsubscribe = this.events.onEntitiesPublished((event) => {
      if (event.entities.includes(STOCK_SNAPSHOT_ENTITY_CODE)) void this.tick();
    });
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.database.withAdvisoryLock('onec-stock-snapshots', () => this.advanceAll(now));
    } catch (error) {
      this.logger.error(`1C stock snapshots queue failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  // ------------------------------------------------------------------ port: reading

  async capabilities(sourceId?: number, tx: DatabaseClient = this.database): Promise<StockSnapshotCapabilities> {
    const config = this.runtime.get();
    const installed = config.enabled && (await this.store.installed(tx));
    if (!installed) return { readAvailable: false, commandsAvailable: false, reason: 'MODULE_DISABLED' };
    if (!config.stockSnapshots) return { readAvailable: true, commandsAvailable: false, reason: 'MODULE_DISABLED' };
    const source = await this.resolveSource(tx, sourceId, false);
    if (!source || source.agentStatus !== 'active' || !source.hasPublishedConfig) return { readAvailable: true, commandsAvailable: false, reason: 'SOURCE_NOT_CONFIGURED' };
    if (agentSupportsStockSnapshots(source.agentVersion) === false) return { readAvailable: true, commandsAvailable: false, reason: 'AGENT_TOO_OLD' };
    return { readAvailable: true, commandsAvailable: true, reason: null };
  }

  async list(filter: StockSnapshotListFilter = {}, tx: DatabaseClient = this.database): Promise<{ items: StockSnapshotView[]; total: number }> {
    await this.requireReadable(tx);
    const where = `sn.deleted_at IS NULL AND ($1::bigint IS NULL OR sn.source_id = $1) AND ($2::text IS NULL OR sn.status = $2)
      AND (NOT $3::boolean OR s.generation_ref = sn.generation_ref)`;
    const params = [filter.sourceId ?? null, filter.status ?? null, filter.currentSourceOnly === true];
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const { rows } = await tx.query(`${VIEW_SELECT} WHERE ${where} ORDER BY sn.requested_at DESC, sn.snapshot_id DESC LIMIT $4 OFFSET $5`, [...params, limit, offset]);
    const total = (await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM onec_stock_snapshots sn JOIN onec_sources s ON s.source_id = sn.source_id WHERE ${where}`, params)).rows[0]!.n;
    return { items: rows.map(toView), total };
  }

  async get(id: number, options: { includeDeleted?: boolean } = {}, tx: DatabaseClient = this.database): Promise<StockSnapshotView> {
    await this.requireReadable(tx);
    const row = (await tx.query(`${VIEW_SELECT} WHERE sn.snapshot_id = $1`, [id])).rows[0];
    if (!row || (row.deleted_at !== null && options.includeDeleted !== true)) throw notFound();
    return toView(row);
  }

  async rows(id: number, filter: { warehouseRefKeys?: readonly string[] } = {}, tx: DatabaseClient = this.database): Promise<StockSnapshotRow[]> {
    await this.requireReady(id, tx);
    const keys = filter.warehouseRefKeys === undefined ? null : [...new Set(filter.warehouseRefKeys.map((key) => key.toLowerCase()))];
    if (keys && (keys.length === 0 || keys.some((key) => !new RegExp(UUID).test(key)))) {
      if (keys.length === 0) return [];
      throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный ключ склада 1С');
    }
    const { rows } = await tx.query<{
      organization_ref_key: string | null; item_ref_key: string; characteristic_ref_key: string | null; batch_ref_key: string | null;
      warehouse_ref_key: string | null; cell_ref_key: string | null; quantity: string;
    }>(
      `SELECT organization_ref_key::text, item_ref_key::text, characteristic_ref_key::text, batch_ref_key::text, warehouse_ref_key::text,
              cell_ref_key::text, quantity::text
         FROM onec_stock_snapshot_rows
        WHERE snapshot_id = $1 AND ($2::uuid[] IS NULL OR warehouse_ref_key = ANY($2::uuid[]))
        ORDER BY row_no`, [id, keys]);
    return rows.map((row) => ({
      organizationRefKey: row.organization_ref_key, itemRefKey: row.item_ref_key, characteristicRefKey: row.characteristic_ref_key,
      batchRefKey: row.batch_ref_key, warehouseRefKey: row.warehouse_ref_key, cellRefKey: row.cell_ref_key, quantity: Number(row.quantity),
    }));
  }

  async summary(id: number, tx: DatabaseClient = this.database): Promise<StockSnapshotWarehouseSummary[]> {
    await this.requireReady(id, tx);
    const { rows } = await tx.query<{ warehouse_ref_key: string | null; rows: number; quantity_total: string }>(
      `SELECT warehouse_ref_key::text, count(*)::int AS rows, sum(quantity)::text AS quantity_total
         FROM onec_stock_snapshot_rows WHERE snapshot_id = $1 GROUP BY warehouse_ref_key ORDER BY warehouse_ref_key NULLS LAST`, [id]);
    return rows.map((row) => ({ warehouseRefKey: row.warehouse_ref_key, rows: row.rows, quantityTotal: Number(row.quantity_total) }));
  }

  // ------------------------------------------------------------------ port: commands

  async request(input: StockSnapshotRequest, actor: CurrentUser, requestId: string, tx?: DatabaseClient): Promise<StockSnapshotView> {
    if (!isLocalMoment(input.momentLocal)) throw new ApiError(422, 'VALIDATION_ERROR', 'Момент среза: ГГГГ-ММ-ДДTЧЧ:ММ:СС (местное время базы 1С)');
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Ключ запроса: 8–200 символов');
    }
    const run = async (client: DatabaseClient): Promise<StockSnapshotView> => {
      const capabilities = await this.capabilities(input.sourceId, client);
      // An unknown or ambiguous source is a mistake of the request (422), not «unavailable»: checked before readiness.
      const source = capabilities.reason === 'MODULE_DISABLED' ? null : (await this.resolveSource(client, input.sourceId, true))!;
      if (!capabilities.commandsAvailable || !source) {
        throw new ApiError(409, 'ONEC_STOCK_SNAPSHOTS_UNAVAILABLE', 'Запросить срез остатков 1С сейчас нельзя', { reason: capabilities.reason });
      }
      // Requests of one source are serialized: «the same moment» is decided on a stable picture.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`onec-stock-snapshot-request:${source.sourceId}`]);
      // A key that was accepted once is answered with the same snapshot for ever — also when that request was
      // answered with an existing snapshot, and whatever happened to the snapshot or to the moment since.
      const repeated = (await client.query<{ snapshot_id: string }>(`SELECT snapshot_id FROM onec_stock_snapshot_requests WHERE idempotency_key = $1`, [input.idempotencyKey])).rows[0];
      if (repeated) return this.get(Number(repeated.snapshot_id), { includeDeleted: true }, client);
      const remember = (snapshotId: number) => client.query(
        `INSERT INTO onec_stock_snapshot_requests (idempotency_key, snapshot_id, requested_by, request_id) VALUES ($1, $2, $3, $4)`,
        [input.idempotencyKey, snapshotId, Number(actor.id), requestId]);
      const moment = (await client.query<{ moment_utc: Date; future: boolean }>(
        `SELECT ($1::timestamp AT TIME ZONE $2) AS moment_utc, ($1::timestamp AT TIME ZONE $2) > now() AS future`, [input.momentLocal, source.timeZone])).rows[0]!;
      if (moment.future) throw new ApiError(422, 'VALIDATION_ERROR', 'Момент среза не может быть в будущем');
      if (input.force !== true) {
        const same = (await client.query<{ snapshot_id: string }>(
          `SELECT snapshot_id FROM onec_stock_snapshots
            WHERE source_id = $1 AND generation_ref = $2::uuid AND moment_local = $3::timestamp AND deleted_at IS NULL AND status <> 'failed'
            ORDER BY snapshot_id DESC LIMIT 1`, [source.sourceId, source.generationRef, input.momentLocal])).rows[0];
        if (same) {
          await remember(Number(same.snapshot_id));
          return this.get(Number(same.snapshot_id), {}, client);
        }
      }
      const id = Number((await client.query<{ snapshot_id: string }>(
        `INSERT INTO onec_stock_snapshots (source_id, agent_id, generation_ref, source_generation, source_database_id, moment_local, moment_utc, time_zone,
                                           forced, idempotency_key, requested_by, requested_by_name, request_id, correlation_id, wait_reason)
         VALUES ($1, $2, $3::uuid, $4, $5, $6::timestamp, $7, $8, $9, $10, $11, $12, $13, $14, 'QUEUED')
         RETURNING snapshot_id`,
        [source.sourceId, source.agentId, source.generationRef, source.generation, source.databaseId, input.momentLocal, moment.moment_utc, source.timeZone,
          // One correlation id (a uuid: commands of the agent carry it) ties the request, the publications, the command and the run.
          input.force === true, input.idempotencyKey, Number(actor.id), actor.username, requestId, randomUUID()])).rows[0]!.snapshot_id);
      await remember(id);
      const record = (await this.store.lock(client, id))!;
      await this.store.event(client, record, 'requested', { forced: input.force === true, timeZone: source.timeZone }, { kind: 'user', user: actor, requestId });
      return this.get(id, {}, client);
    };
    const view = await (tx ? run(tx) : this.database.transaction((client) => run(client)));
    if (!tx) void this.tick();
    return view;
  }

  async delete(id: number, actor: CurrentUser, requestId: string, tx?: DatabaseClient): Promise<void> {
    const run = async (client: DatabaseClient): Promise<void> => {
      if (!this.runtime.get().enabled || !(await this.store.installed(client))) throw notFound();
      const snapshot = await this.store.lock(client, id);
      if (!snapshot || snapshot.deletedAt !== null) throw notFound();
      if (snapshot.status === 'config_published' || snapshot.status === 'syncing') {
        throw new ApiError(409, 'ONEC_STOCK_SNAPSHOT_IN_PROGRESS', 'Срез сейчас читается из 1С — удалить можно после завершения');
      }
      const user = { kind: 'user' as const, user: actor, requestId };
      if (snapshot.status === 'requested') await this.store.fail(client, snapshot, 'CANCELLED', 'Запрос отменён до начала чтения', user);
      const removed = (await client.query(`DELETE FROM onec_stock_snapshot_rows WHERE snapshot_id = $1`, [id])).rowCount ?? 0;
      await client.query(`UPDATE onec_stock_snapshots SET deleted_at = now(), deleted_by = $2, updated_at = now() WHERE snapshot_id = $1`, [id, Number(actor.id)]);
      await this.store.event(client, snapshot, 'deleted', { previousStatus: snapshot.status, rowsRemoved: removed }, user);
    };
    await (tx ? run(tx) : this.database.transaction((client) => run(client)));
  }

  /**
   * Takes the service set out of the published configuration (before a rollback of the backend image: an older
   * validator does not accept its path). Only with the flag off and the slot idle.
   */
  async removeManagedSet(sourceId: number, actor: CurrentUser, requestId: string): Promise<{ configVersion: number | null; changed: boolean }> {
    if (this.runtime.get().stockSnapshots) throw new ApiError(409, 'ONEC_STOCK_SNAPSHOTS_ENABLED', 'Сначала выключите срезы остатков (BACKEND_ONEC_STOCK_SNAPSHOTS=false)');
    return this.database.transaction(async (tx) => {
      const { agent } = await this.repository.lockForRebaseline(tx, sourceId);
      if (!agent) throw new ApiError(404, 'ONEC_AGENT_NOT_FOUND', 'У источника нет агента');
      const slot = await this.repository.getStockSnapshotSlot(tx, sourceId, 'update');
      if (!slot || slot.state === 'removed') return { configVersion: null, changed: false };
      if (slot.state !== 'idle') throw new ApiError(409, 'ONEC_STOCK_SNAPSHOT_SLOT_BUSY', 'Служебный набор ещё используется или выключается — повторите позже', { state: slot.state });
      await tx.query(`UPDATE onec_stock_snapshot_slot SET state = 'removed', owner_snapshot_id = NULL, state_since = now(), updated_at = now() WHERE source_id = $1`, [sourceId]);
      const published = await this.admin.publishManaged(tx, agent.agentId, {
        requestId, correlationId: requestId, snapshotId: null, requestedByUserId: Number(actor.id), action: 'remove',
      });
      await tx.query(`UPDATE onec_stock_snapshot_slot SET config_version = $2 WHERE source_id = $1`, [sourceId, published.configVersion]);
      return { configVersion: published.configVersion, changed: published.changed };
    });
  }

  // ------------------------------------------------------------------ the queue

  /** One pass over every source that has a slot or an unfinished snapshot. */
  async advanceAll(now: Date): Promise<void> {
    if (!this.runtime.get().enabled || !(await this.store.installed(this.database))) return;
    const { rows } = await this.database.query<{ source_id: string }>(
      `SELECT source_id FROM onec_stock_snapshot_slot WHERE state IN ('active', 'disabling')
       UNION SELECT source_id FROM onec_stock_snapshots WHERE status IN ('requested', 'config_published', 'syncing') ORDER BY 1`);
    for (const row of rows) {
      const sourceId = Number(row.source_id);
      try {
        // A step that made progress may enable the next one (hand-over, an immediate result).
        for (let step = 0; step < 6 && (await this.advance(sourceId, now)); step += 1);
      } catch (error) {
        this.logger.error(`1C stock snapshots of source ${sourceId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** One transition of a source; returns true when something changed. */
  async advance(sourceId: number, now: Date): Promise<boolean> {
    const reading = (await this.database.query<{ snapshot_id: string; status: StockSnapshotStatus }>(
      `SELECT snapshot_id, status FROM onec_stock_snapshots WHERE source_id = $1 AND status IN ('config_published', 'syncing')`, [sourceId])).rows[0];
    if (reading?.status === 'config_published') return this.sendCommand(sourceId, Number(reading.snapshot_id), now);
    if (reading?.status === 'syncing') return this.collect(sourceId, Number(reading.snapshot_id), now);
    return this.startOrRelease(sourceId, now);
  }

  /** Steps 1 and 4: start the next waiting snapshot (taking the slot over), or switch the slot off. */
  private async startOrRelease(sourceId: number, now: Date): Promise<boolean> {
    const tickId = `onec-stock-snapshots:${randomUUID()}`;
    return this.database.transaction(async (tx) => {
      await this.repository.lockForRebaseline(tx, sourceId);
      const source = await this.resolveSource(tx, sourceId, false);
      if (!source) return false;
      const slot = await this.repository.getStockSnapshotSlot(tx, sourceId, 'update');
      const owner = slot?.ownerSnapshotId ? await this.store.lock(tx, slot.ownerSnapshotId) : null;
      const ownerDone = !owner || owner.status === 'ready' || owner.status === 'failed';
      if (slot?.state === 'active' && !ownerDone) return false;
      let changed = false;

      // Snapshots of a replaced base never start; with the flag off nothing new starts.
      const waiting = (await this.store.lockUnfinished(tx, sourceId)).filter((snapshot) => snapshot.status === 'requested' && snapshot.deletedAt === null);
      let next: StockSnapshotRecord | null = null;
      for (const snapshot of waiting) {
        if (snapshot.generationRef !== source.generationRef) {
          changed = (await this.store.fail(tx, snapshot, 'SOURCE_GENERATION_CHANGED', 'База 1С источника заменена до начала чтения', { kind: 'system', requestId: tickId })) || changed;
        } else if (!this.runtime.get().stockSnapshots) {
          changed = (await this.store.fail(tx, snapshot, 'MODULE_DISABLED', 'Срезы остатков 1С выключены', { kind: 'system', requestId: tickId })) || changed;
        } else if (!next) {
          next = snapshot;
        } else {
          await this.store.setWaitReason(tx, snapshot, 'QUEUED');
        }
      }

      const waitReason = next ? await this.cannotStart(tx, source, now) : null;
      if (next && waitReason === null) {
        await tx.query(
          `INSERT INTO onec_stock_snapshot_slot (source_id, state, period_local, owner_snapshot_id, config_version, command_id, state_since, updated_at)
           VALUES ($1, 'active', $2::timestamp, $3, NULL, NULL, $4, now())
           ON CONFLICT (source_id) DO UPDATE SET state = 'active', period_local = EXCLUDED.period_local, owner_snapshot_id = EXCLUDED.owner_snapshot_id,
             config_version = NULL, command_id = NULL, state_since = EXCLUDED.state_since, updated_at = now()`,
          [sourceId, next.momentLocal, next.id, now]);
        const published = await this.admin.publishManaged(tx, source.agentId, {
          requestId: next.requestId, correlationId: next.correlationId, snapshotId: next.id, requestedByUserId: next.requestedBy, action: 'enable',
        });
        await tx.query(`UPDATE onec_stock_snapshot_slot SET config_version = $2 WHERE source_id = $1`, [sourceId, published.configVersion]);
        await tx.query(
          `UPDATE onec_stock_snapshots SET status = 'config_published', config_version = $2, config_published_at = $3, wait_reason = NULL, updated_at = now()
            WHERE snapshot_id = $1 AND status = 'requested'`, [next.id, published.configVersion, now]);
        await this.alerts.resolve(tx, slotAlertKey(sourceId));
        return true;
      }
      if (next) await this.store.setWaitReason(tx, next, waitReason);

      // Nothing can start now: a slot that is still switched on (its owner is final) goes off.
      if (slot?.state === 'active') {
        await tx.query(`UPDATE onec_stock_snapshot_slot SET state = 'disabling', config_version = NULL, state_since = $2, updated_at = now() WHERE source_id = $1`, [sourceId, now]);
        changed = true;
      }
      if (slot && (slot.state === 'active' || slot.state === 'disabling')) {
        const pendingVersion = slot.state === 'disabling' ? slot.configVersion : null;
        if (pendingVersion === null) {
          if (source.publishBlocked) {
            await this.raiseStuck(tx, sourceId, slot.state === 'disabling' ? slot.stateSince : now, now, 'CONFIG_PUBLISH_BLOCKED');
            return changed;
          }
          const published = await this.admin.publishManaged(tx, source.agentId, {
            requestId: tickId, correlationId: owner?.correlationId ?? tickId, snapshotId: owner?.id ?? null, requestedByUserId: owner?.requestedBy ?? null, action: 'disable',
          });
          await tx.query(`UPDATE onec_stock_snapshot_slot SET config_version = $2, updated_at = now() WHERE source_id = $1`, [sourceId, published.configVersion]);
          return true;
        }
        if (source.activeConfigVersion !== null && source.activeConfigVersion >= pendingVersion) {
          await tx.query(`UPDATE onec_stock_snapshot_slot SET state = 'idle', owner_snapshot_id = NULL, command_id = NULL, state_since = $2, updated_at = now() WHERE source_id = $1`, [sourceId, now]);
          await this.alerts.resolve(tx, slotAlertKey(sourceId));
          return true;
        }
        await this.raiseStuck(tx, sourceId, slot.stateSince, now, source.rejectedConfigVersion === pendingVersion ? 'CONFIG_REJECTED' : 'CONFIG_NOT_APPLIED');
      }
      return changed;
    });
  }

  /** Step 2: the agent took the version → queue the read command. */
  private async sendCommand(sourceId: number, snapshotId: number, now: Date): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      await this.repository.lockForRebaseline(tx, sourceId);
      const source = await this.resolveSource(tx, sourceId, false);
      if (!source) return false;
      await this.repository.getStockSnapshotSlot(tx, sourceId, 'update');
      const snapshot = await this.store.lock(tx, snapshotId);
      if (!snapshot || snapshot.status !== 'config_published' || snapshot.configVersion === null) return false;
      if (snapshot.generationRef !== source.generationRef) return this.store.fail(tx, snapshot, 'SOURCE_GENERATION_CHANGED', 'База 1С источника заменена, пока срез не был готов');
      if (source.rejectedConfigVersion === snapshot.configVersion) return this.store.fail(tx, snapshot, 'CONFIG_REJECTED', 'Агент отклонил конфигурацию со срезом');
      if (source.activeConfigVersion === null || source.activeConfigVersion < snapshot.configVersion) {
        const since = snapshot.configPublishedAt?.getTime() ?? now.getTime();
        if (now.getTime() - since > CONFIG_APPLY_TIMEOUT_MS) return this.store.fail(tx, snapshot, 'CONFIG_NOT_APPLIED', 'Агент не применил конфигурацию со срезом за отведённое время');
        return false;
      }
      const { command } = await this.commands.enqueue(tx, {
        agentId: snapshot.agentId, commandType: 'start_full_sync', payload: { entities: [STOCK_SNAPSHOT_ENTITY_CODE] },
        sourceModule: SOURCE_MODULE, sourceEntityType: 'onec_stock_snapshot', sourceEntityId: String(snapshot.id),
        idempotencyKey: `stock-snapshot:${snapshot.id}`, correlationId: snapshot.correlationId,
        // The delivery deadline counts from the moment the command is really queued — the queue may resume long after
        // the version was applied (a restart). The command and the status change commit together, so a repeated step
        // never queues the same key with another deadline.
        expiresAtUtc: new Date(now.getTime() + COMMAND_DELIVERY_TIMEOUT_MS).toISOString(),
        requestedBy: snapshot.requestedBy === null ? null : { userId: String(snapshot.requestedBy) },
      });
      await tx.query(`UPDATE onec_stock_snapshots SET status = 'syncing', command_id = $2::uuid, syncing_at = $3, updated_at = now() WHERE snapshot_id = $1 AND status = 'config_published'`,
        [snapshot.id, command.commandId, now]);
      await tx.query(`UPDATE onec_stock_snapshot_slot SET command_id = $2::uuid, updated_at = now() WHERE source_id = $1`, [sourceId, command.commandId]);
      return true;
    });
  }

  /** Step 3: the result of the command and of its run → copy the rows, or fail. */
  private async collect(sourceId: number, snapshotId: number, now: Date): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      // The full lock order here too: agent → source (FOR NO KEY UPDATE) before the slot, the snapshot and the entity
      // state. With only the source locked, a late completion (holds the entity state, needs KEY SHARE on the agent for
      // its incident) and a session start of the agent (holds the agent, waits for the source) would close a cycle.
      const { source: lockedSource } = await this.repository.lockForRebaseline(tx, sourceId);
      const sourceRow = lockedSource ? { generation_ref: lockedSource.generationRef } : undefined;
      const slot = await this.repository.getStockSnapshotSlot(tx, sourceId, 'update');
      const locked = await this.store.lock(tx, snapshotId);
      if (!locked || locked.status !== 'syncing' || !locked.commandId) return false;
      // Becomes the snapshot with its run as soon as the run is known: every later failure keeps the link.
      let snapshot = locked;
      if (!sourceRow || snapshot.generationRef !== sourceRow.generation_ref) return this.store.fail(tx, snapshot, 'SOURCE_GENERATION_CHANGED', 'База 1С источника заменена, пока срез не был готов');
      if (!slot || slot.state !== 'active' || slot.ownerSnapshotId !== snapshot.id || slot.periodLocal !== snapshot.momentLocal) {
        return this.store.fail(tx, snapshot, 'SLOT_LOST', 'Служебный набор больше не принадлежит этому срезу');
      }
      const command = (await tx.query<{ status: string; result_error_code: string | null }>(
        `SELECT status, result_error_code FROM onec_agent_commands WHERE command_id = $1::uuid`, [snapshot.commandId])).rows[0];
      const overdue = now.getTime() - (snapshot.syncingAt?.getTime() ?? now.getTime()) > SYNC_DEADLINE_MS;
      const timedOut = async (): Promise<boolean> => {
        // Cancel what can still be cancelled; a command the agent may hold keeps an unknown outcome (see the invariant).
        const cancelled = await this.commands.cancelBySystem(tx, snapshot.commandId!, STOCK_SNAPSHOT_ACTOR, {
          requestId: snapshot.requestId, correlationId: snapshot.correlationId, reason: 'stock_snapshot_sync_timeout',
        });
        await this.alerts.raise(tx, {
          kind: 'onec_stock_snapshot_command_unknown', sourceId, dedupeKey: `onec_stock_snapshot_command_unknown:${snapshot.id}`, severity: 'warning',
          details: { snapshotId: snapshot.id, commandId: snapshot.commandId, commandStatus: cancelled ? 'cancelled' : command?.status ?? null, commandCancelled: cancelled, momentLocal: snapshot.momentLocal },
        });
        return this.store.fail(tx, snapshot, 'SYNC_TIMEOUT', 'Чтение среза не завершилось за отведённое время');
      };
      if (!command) return this.store.fail(tx, snapshot, 'COMMAND_LOST', 'Команда чтения среза не найдена');
      if (['business_error', 'dead_letter', 'expired', 'expired_undelivered', 'cancelled'].includes(command.status)) {
        return this.store.fail(tx, snapshot, `COMMAND_${command.status.toUpperCase()}${command.result_error_code ? `:${command.result_error_code}` : ''}`, 'Агент не выполнил команду чтения среза');
      }
      if (command.status !== 'succeeded') return overdue ? timedOut() : false;
      const run = (await tx.query<{ run_id: string; status: string; generation_ref: string; completion: { entities?: Array<Record<string, unknown>> } | null }>(
        `SELECT run_id::text AS run_id, status, generation_ref::text AS generation_ref, completion FROM onec_etl_runs WHERE command_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
        [snapshot.commandId])).rows[0];
      if (run) snapshot = { ...snapshot, runId: run.run_id };
      if (!run || run.status === 'receiving') return overdue ? timedOut() : false;
      if (run.status !== 'completed') return this.store.fail(tx, snapshot, 'RUN_ABANDONED', 'Выгрузка среза не была завершена агентом');
      if (run.generation_ref !== snapshot.generationRef) return this.store.fail(tx, snapshot, 'SOURCE_GENERATION_CHANGED', 'Выгрузка среза относится к другой базе 1С');

      // From here on the mirror of the set cannot be replaced: the completion of any run takes this lock first.
      const state = (await tx.query<{ last_run_id: string | null; snapshot_version: Date | null; snapshot_rejected_reason: string | null }>(
        `SELECT last_run_id::text AS last_run_id, snapshot_version, snapshot_rejected_reason FROM onec_etl_entity_state
          WHERE source_id = $1 AND entity_code = $2 FOR UPDATE`, [sourceId, STOCK_SNAPSHOT_ENTITY_CODE])).rows[0];
      const entry = (run.completion?.entities ?? []).find((entity) => entity.entity === STOCK_SNAPSHOT_ENTITY_CODE) as
        | { status?: string; readScope?: string; completeness?: string; rows?: number; errorCode?: string | null; snapshot?: { applied?: boolean; reason?: string | null } }
        | undefined;
      if (!entry) return this.store.fail(tx, snapshot, 'SNAPSHOT_MISSING', 'В выгрузке нет набора среза');
      if (entry.status !== 'done') return this.store.fail(tx, snapshot, `SNAPSHOT_FAILED${entry.errorCode ? `:${entry.errorCode}` : ''}`, 'Агент не смог прочитать срез в 1С');
      if (entry.snapshot?.applied !== true) return this.store.fail(tx, snapshot, `SNAPSHOT_REJECTED:${entry.snapshot?.reason ?? 'UNKNOWN'}`, 'Срез не принят как полный проверенный снимок');
      if (entry.readScope !== 'full' || entry.completeness !== 'verified') return this.store.fail(tx, snapshot, 'SNAPSHOT_REJECTED:NOT_VERIFIED', 'Срез не подтверждён как полный');
      const expected = Number(entry.rows ?? -1);
      if (expected > STOCK_SNAPSHOT_MAX_ROWS) return this.store.fail(tx, snapshot, 'TOO_MANY_ROWS', `В срезе больше ${STOCK_SNAPSHOT_MAX_ROWS} строк`);
      // The mirror must be exactly this run. A snapshot applied later replaces the copy (its rows carry another run);
      // a later REJECTED completion (stale, unverified) leaves the copy alone and only moves `last_run_id` of the
      // state, so the rows themselves are asked. An empty copy cannot tell whose it is: then the state must still
      // point at this run.
      const counted = (await tx.query<{ total: number; valid: number; foreign_rows: number }>(
        `SELECT count(*) FILTER (WHERE m.last_run_id = $3::uuid AND NOT m.deleted)::int AS total,
                count(*) FILTER (WHERE m.last_run_id = $3::uuid AND NOT m.deleted
                                   AND ${keyOf('Номенклатура_Key')} IS NOT NULL AND m.data->>'КоличествоBalance' ~ ${NUMERIC})::int AS valid,
                count(*) FILTER (WHERE m.last_run_id IS DISTINCT FROM $3::uuid)::int AS foreign_rows
           FROM onec_etl_mirror_rows m
          WHERE m.source_id = $1 AND m.entity_code = $2`, [sourceId, STOCK_SNAPSHOT_ENTITY_CODE, run.run_id])).rows[0]!;
      if (!state || state.snapshot_version === null || counted.foreign_rows > 0 || (expected === 0 && state.last_run_id !== run.run_id)
        || (counted.total === 0 && expected > 0)) {
        return this.store.fail(tx, snapshot, 'SNAPSHOT_REPLACED', 'Копию среза успела заменить другая выгрузка — запросите срез ещё раз');
      }
      if (counted.total !== expected) return this.store.fail(tx, snapshot, 'COPY_MISMATCH', `Агент сообщил ${expected} строк, в копии ${counted.total}`);
      if (counted.valid !== counted.total) return this.store.fail(tx, snapshot, 'INVALID_ROWS', `Строк без позиции или количества: ${counted.total - counted.valid}`);
      await tx.query(`DELETE FROM onec_stock_snapshot_rows WHERE snapshot_id = $1`, [snapshot.id]);
      const copied = (await tx.query(
        `INSERT INTO onec_stock_snapshot_rows (snapshot_id, row_no, organization_ref_key, item_ref_key, characteristic_ref_key, batch_ref_key,
                                               warehouse_ref_key, cell_ref_key, quantity)
         SELECT $4, row_number() OVER (ORDER BY m.source_key), ${keyOf('Организация_Key')}, ${keyOf('Номенклатура_Key')}, ${keyOf('Характеристика_Key')},
                ${keyOf('Партия_Key')}, ${keyOf('СтруктурнаяЕдиница_Key')}, ${keyOf('Ячейка_Key')}, (m.data->>'КоличествоBalance')::numeric
           FROM onec_etl_mirror_rows m
          WHERE m.source_id = $1 AND m.entity_code = $2 AND m.last_run_id = $3::uuid AND NOT m.deleted`,
        [sourceId, STOCK_SNAPSHOT_ENTITY_CODE, run.run_id, snapshot.id])).rowCount ?? 0;
      if (copied !== expected) throw new Error(`stock snapshot ${snapshot.id}: copied ${copied} of ${expected} rows`);
      await tx.query(
        `UPDATE onec_stock_snapshots SET status = 'ready', run_id = $2::uuid, rows_count = $3, read_at = $4, ready_at = now(), updated_at = now(), wait_reason = NULL
          WHERE snapshot_id = $1 AND status = 'syncing'`, [snapshot.id, run.run_id, copied, state.snapshot_version]);
      await this.store.event(tx, snapshot, 'ready', { rowsCount: copied, runId: run.run_id, readAt: state.snapshot_version.toISOString() }, { kind: 'system', requestId: snapshot.requestId });
      return true;
    });
  }

  // ------------------------------------------------------------------ helpers

  /** Why the next snapshot of the source cannot start now (null — it can). The state of the slot is not part of it. */
  private async cannotStart(tx: DatabaseClient, source: SourceState, now: Date): Promise<StockSnapshotWaitReason | null> {
    const config = this.runtime.get();
    const silentAfterMs = config.heartbeatIntervalMs * 3;
    if (source.agentStatus !== 'active' || !source.receivedAt || now.getTime() - source.receivedAt.getTime() > silentAfterMs) return 'AGENT_OFFLINE';
    if (agentSupportsStockSnapshots(source.agentVersion) !== true) return 'AGENT_TOO_OLD';
    if (source.publishBlocked) return 'CONFIG_PUBLISH_BLOCKED';
    const window = startWindowReason(now, { expectedSilenceUtc: source.expectedSilenceUtc, nightlyFullSyncHourUtc: config.nightlyFullSyncHourUtc });
    if (window) return window;
    // ETL commands and runs younger than the stale threshold: the agent reads one thing at a time.
    const busy = (await tx.query<{ busy: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM onec_agent_commands
                       WHERE agent_id = $1 AND command_type IN ('start_full_sync', 'reload_entity') AND status IN ('queued', 'leased', 'received')
                         AND created_at > now() - ($2::bigint * interval '1 millisecond'))
           OR EXISTS (SELECT 1 FROM onec_etl_runs WHERE agent_id = $1 AND status = 'receiving' AND created_at > now() - ($2::bigint * interval '1 millisecond')) AS busy`,
      [source.agentId, STALE_ACTIVITY_MS])).rows[0]!.busy;
    return busy ? 'AGENT_BUSY' : null;
  }

  private async raiseStuck(tx: DatabaseClient, sourceId: number, since: Date, now: Date, reason: string): Promise<void> {
    if (now.getTime() - since.getTime() < SLOT_STUCK_MS) return;
    await this.alerts.raise(tx, {
      kind: 'onec_stock_snapshot_slot_stuck', sourceId, dedupeKey: slotAlertKey(sourceId), severity: 'warning',
      details: { reason, since: since.toISOString(), actor: STOCK_SNAPSHOT_ACTOR },
    });
  }

  /** The source with its agent and what the agent reported last. `sourceId` omitted — the only source. */
  private async resolveSource(tx: DatabaseClient, sourceId: number | undefined, strict: boolean): Promise<SourceState | null> {
    const { rows } = await tx.query(
      `SELECT s.source_id, s.generation_ref::text AS generation_ref, s.generation, s.identity->>'databaseId' AS database_id, s.time_zone,
              a.agent_id, a.status AS agent_status, a.config_publish_blocked, a.expected_silence_utc,
              st.agent_version, st.received_at, st.active_config_version, st.rejected_config_version,
              EXISTS (SELECT 1 FROM onec_agent_config_versions v WHERE v.agent_id = a.agent_id AND v.status = 'published') AS has_published
         FROM onec_sources s JOIN onec_agents a ON a.source_id = s.source_id LEFT JOIN onec_agent_status st ON st.agent_id = a.agent_id
        WHERE $1::bigint IS NULL OR s.source_id = $1 ORDER BY s.source_id LIMIT 2`, [sourceId ?? null]);
    if (rows.length !== 1) {
      if (strict) throw new ApiError(422, 'VALIDATION_ERROR', rows.length === 0 ? 'Источник 1С не найден' : 'Источников 1С несколько — укажите источник');
      return null;
    }
    const row = rows[0]!;
    return {
      sourceId: Number(row.source_id), agentId: String(row.agent_id), generationRef: String(row.generation_ref), generation: Number(row.generation),
      databaseId: (row.database_id as string | null) ?? null, timeZone: String(row.time_zone), agentStatus: String(row.agent_status),
      publishBlocked: row.config_publish_blocked === true, expectedSilenceUtc: (row.expected_silence_utc as string | null) ?? null,
      agentVersion: (row.agent_version as string | null) ?? null, receivedAt: (row.received_at as Date | null) ?? null,
      activeConfigVersion: row.active_config_version === null || row.active_config_version === undefined ? null : Number(row.active_config_version),
      rejectedConfigVersion: row.rejected_config_version === null || row.rejected_config_version === undefined ? null : Number(row.rejected_config_version),
      hasPublishedConfig: row.has_published === true,
    };
  }

  private async requireReadable(tx: DatabaseClient): Promise<void> {
    if (!this.runtime.get().enabled || !(await this.store.installed(tx))) {
      throw new ApiError(409, 'ONEC_STOCK_SNAPSHOTS_UNAVAILABLE', 'Срезы остатков 1С недоступны', { reason: 'MODULE_DISABLED' });
    }
  }

  private async requireReady(id: number, tx: DatabaseClient): Promise<void> {
    await this.requireReadable(tx);
    const row = (await tx.query<{ status: string; deleted_at: Date | null }>(`SELECT status, deleted_at FROM onec_stock_snapshots WHERE snapshot_id = $1`, [id])).rows[0];
    if (!row || row.deleted_at !== null) throw notFound();
    if (row.status !== 'ready') throw new ApiError(409, 'ONEC_STOCK_SNAPSHOT_NOT_READY', 'Срез ещё не готов');
  }
}

const notFound = () => new ApiError(404, 'ONEC_STOCK_SNAPSHOT_NOT_FOUND', 'Срез не найден');
const slotAlertKey = (sourceId: number) => `onec_stock_snapshot_slot_stuck:${sourceId}`;
