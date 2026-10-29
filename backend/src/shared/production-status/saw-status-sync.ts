import { ApiError } from '../../common/errors/api-error';
import { auditService } from '../../common/audit/audit.service';
import type { TransactionClient } from '../../database/database.types';

/**
 * Status «Базис» (code `saw`, migration 282): a detail in a card of the machine file «Базис раскрой» (saw centre) goes
 * from «Новый» to «Базис»; a «Базис» detail no longer in any such card goes back to «Новый» (the only earlier status on
 * that step, so no history of previous statuses is needed). A detail also reserved by a CNC cut job is never moved:
 * the command goes on with a warning and an audit row (the two machines exclude each other — a person decides).
 * Details further on are never touched. The Bazis route of a detail is written by the DB trigger on its status.
 *
 * Lock order (plan §4.2): the orders of the details FOR NO KEY UPDATE by id, then the details FOR UPDATE by id — the
 * same order as every detail-status command (order → details). Callers take `lockOrdersOfDetails` before their own
 * card/set locks; `syncSawStatusForDetails` re-takes them (a no-op within the transaction).
 */
export interface SawSyncContext {
  actorUserId: number | null;
  actorUsername: string | null;
  actorRole?: string | null;
  requestId: string;
  /** What changed the cards: the «Базис раскрой» screen or the MDF engine composition. */
  cause: 'bazis_cut' | 'mdf_engine';
  setId?: number | null;
  /** The command's idempotency key: the outbox keys derive from it (a replay writes nothing twice). */
  idempotencyKey: string;
}

export interface SawSyncWarning {
  code: 'DETAIL_ALSO_IN_CNC' | 'DETAIL_ALSO_IN_BAZIS';
  detailId: number;
  orderId: number;
  cutJobIds: number[];
  bazisCutSetIds: number[];
}

export interface SawSyncResult {
  changedDetailIds: number[];
  warnings: SawSyncWarning[];
}

interface DetailRouteRow {
  detail_id: string;
  order_id: string;
  code: string | null;
  bazis_set_ids: string[] | null;
  cut_job_ids: string[] | null;
}

export async function lockOrdersOfDetails(tx: TransactionClient, detailIds: readonly number[]): Promise<number[]> {
  const ids = uniqueIds(detailIds);
  if (ids.length === 0) return [];
  const rows = (await tx.query<{ order_id: string }>(
    `SELECT o.order_id FROM orders o
      WHERE o.order_id IN (SELECT od.order_id FROM order_details od WHERE od.detail_id = ANY($1::bigint[]))
      ORDER BY o.order_id FOR NO KEY UPDATE`,
    [ids],
  )).rows;
  return rows.map((row) => Number(row.order_id));
}

/**
 * The orders of a «Базис раскрой» set (its rows) and of the details about to join it, locked before the set itself:
 * every set command then takes orders → set — the order the legacy MDF automation (orders after the set rows change)
 * and the detail-status commands also follow. `assertSetOrdersLocked` re-checks them under the set lock.
 */
export async function lockOrdersOfSet(
  tx: TransactionClient,
  setId: number,
  extraDetailIds: readonly number[] = [],
  extraHdfDetailIds: readonly number[] = [],
): Promise<number[]> {
  return lockOrderOwners(tx, { setId, detailIds: extraDetailIds, hdfDetailIds: extraHdfDetailIds });
}

/**
 * The single owner lock of every «Базис раскрой» command (create, create from the picker, add, update, delete): the
 * orders of the set's rows (HDF rows by source_order_id), of the details / HDF details / orders the command brings, and
 * every order sharing a bath with them — the legacy MDF automation's owner set — in one `ORDER BY order_id FOR UPDATE`
 * before any other lock. Later locks of the command (picker scope, the automation) then only re-take held rows.
 */
export async function lockOrderOwners(
  tx: TransactionClient,
  input: { setId?: number | null; detailIds?: readonly number[]; hdfDetailIds?: readonly number[]; orderIds?: readonly number[] },
): Promise<number[]> {
  const rows = (await tx.query<{ order_id: string }>(
    `WITH source_orders AS (
       -- both owners of a row: the one recorded on the card (source_order_id) and the detail's current order (a detail
       -- transferred to another order keeps the old source_order_id; the status sync locks the current one)
       SELECT COALESCE(i.source_order_id, d.order_id) AS order_id
         FROM bazis_cut_set_details i LEFT JOIN order_details d ON d.detail_id = i.source_order_detail_id
        WHERE i.bazis_cut_set_id = $1::bigint
       UNION SELECT d.order_id
         FROM bazis_cut_set_details i JOIN order_details d ON d.detail_id = i.source_order_detail_id
        WHERE i.bazis_cut_set_id = $1::bigint
       UNION SELECT od.order_id FROM order_details od WHERE od.detail_id = ANY($2::bigint[])
       -- the owners of HDF details about to join (their rows carry source_order_id: the FK insert needs the order)
       UNION SELECT hd.order_id FROM order_hdf_details hd WHERE hd.order_hdf_detail_id = ANY($3::bigint[])
       UNION SELECT x FROM unnest($4::bigint[]) x
     ), related_orders AS (
       SELECT order_id FROM source_orders
       UNION SELECT sibling.order_id FROM cut_result_placement sibling
         JOIN cut_result_placement member ON member.cut_result_id = sibling.cut_result_id
         JOIN source_orders owner ON owner.order_id = member.order_id
     )
     SELECT o.order_id FROM orders o JOIN related_orders r ON r.order_id = o.order_id
      ORDER BY o.order_id FOR UPDATE OF o`,
    [input.setId ?? null, uniqueIds(input.detailIds ?? []), uniqueIds(input.hdfDetailIds ?? []), uniqueIds(input.orderIds ?? [])],
  )).rows;
  return rows.map((row) => Number(row.order_id));
}

/** Under the set lock: a set whose owners changed since `lockOrdersOfSet` is refused (retry) instead of locking out of order. */
export async function assertSetOrdersLocked(tx: TransactionClient, setId: number, locked: readonly number[]): Promise<void> {
  // The same owner query as lockOrderOwners (existing orders only), without locking: anything new means a retry.
  const current = (await tx.query<{ order_id: string }>(
    `WITH source_orders AS (
       SELECT COALESCE(i.source_order_id, d.order_id) AS order_id
         FROM bazis_cut_set_details i LEFT JOIN order_details d ON d.detail_id = i.source_order_detail_id
        WHERE i.bazis_cut_set_id = $1::bigint
       UNION SELECT d.order_id
         FROM bazis_cut_set_details i JOIN order_details d ON d.detail_id = i.source_order_detail_id
        WHERE i.bazis_cut_set_id = $1::bigint
     ), related_orders AS (
       SELECT order_id FROM source_orders
       UNION SELECT sibling.order_id FROM cut_result_placement sibling
         JOIN cut_result_placement member ON member.cut_result_id = sibling.cut_result_id
         JOIN source_orders owner ON owner.order_id = member.order_id
     )
     SELECT o.order_id FROM orders o JOIN related_orders r ON r.order_id = o.order_id`,
    [setId],
  )).rows.map((row) => Number(row.order_id));
  const lockedSet = new Set(locked);
  if (current.some((orderId) => !lockedSet.has(orderId))) {
    throw new ApiError(409, 'BAZIS_CUT_SET_CHANGED', 'Набор изменился — обновите его и повторите');
  }
}

/** Detail ids of the order details in the given «Базис раскрой» set rows (before the rows change). */
export async function sourceDetailIdsOfSetRows(tx: TransactionClient, rowIds: readonly number[]): Promise<number[]> {
  const ids = uniqueIds(rowIds);
  if (ids.length === 0) return [];
  const rows = (await tx.query<{ detail_id: string }>(
    `SELECT DISTINCT source_order_detail_id AS detail_id FROM bazis_cut_set_details
      WHERE bazis_cut_set_detail_id = ANY($1::bigint[]) AND source_order_detail_id IS NOT NULL`,
    [ids],
  )).rows;
  return rows.map((row) => Number(row.detail_id));
}

export async function syncSawStatusForDetails(
  tx: TransactionClient,
  detailIds: readonly number[],
  context: SawSyncContext,
): Promise<SawSyncResult> {
  const ids = uniqueIds(detailIds);
  if (ids.length === 0) return { changedDetailIds: [], warnings: [] };
  // A database without the «Базис» status (before migration 282) is left untouched: a status is never set to NULL.
  const statusIds = (await tx.query<{ code: string; id: number }>(
    "SELECT production_status_code AS code, production_status_id AS id FROM production_statuses WHERE production_status_code IN ('saw', 'new')",
  )).rows;
  if (!statusIds.some((row) => row.code === 'saw') || !statusIds.some((row) => row.code === 'new')) {
    return { changedDetailIds: [], warnings: [] };
  }
  await lockOrdersOfDetails(tx, ids);
  const rows = (await tx.query<DetailRouteRow>(
    `SELECT od.detail_id, od.order_id, ps.production_status_code AS code,
            (SELECT array_agg(DISTINCT bsd.bazis_cut_set_id::text) FROM bazis_cut_set_details bsd
              WHERE bsd.source_order_detail_id = od.detail_id) AS bazis_set_ids,
            (SELECT array_agg(DISTINCT cji.cut_job_id::text) FROM cut_job_item cji
              WHERE cji.order_detail_id = od.detail_id AND cji.is_active) AS cut_job_ids
       FROM order_details od
       LEFT JOIN production_statuses ps ON ps.production_status_id = od.production_status_id
      WHERE od.detail_id = ANY($1::bigint[]) AND NOT COALESCE(od.delete_flag, false)
      ORDER BY od.detail_id
      FOR UPDATE OF od`,
    [ids],
  )).rows;

  const toSaw: DetailRouteRow[] = [];
  const toNew: DetailRouteRow[] = [];
  const warnings: SawSyncWarning[] = [];
  for (const row of rows) {
    const inBazis = (row.bazis_set_ids ?? []).length > 0;
    const inCnc = (row.cut_job_ids ?? []).length > 0;
    if (inBazis && inCnc) {
      warnings.push({
        code: 'DETAIL_ALSO_IN_CNC', detailId: Number(row.detail_id), orderId: Number(row.order_id),
        cutJobIds: (row.cut_job_ids ?? []).map(Number), bazisCutSetIds: (row.bazis_set_ids ?? []).map(Number),
      });
    }
    if (row.code === 'new' && inBazis && !inCnc) toSaw.push(row);
    else if (row.code === 'saw' && !inBazis) toNew.push(row);
  }

  const changed: Array<{ row: DetailRouteRow; from: string; to: string }> = [];
  if (toSaw.length > 0) {
    await tx.query(
      `UPDATE order_details SET production_status_id = (SELECT production_status_id FROM production_statuses WHERE production_status_code = 'saw')
        WHERE detail_id = ANY($1::bigint[])`,
      [toSaw.map((row) => Number(row.detail_id))],
    );
    for (const row of toSaw) changed.push({ row, from: 'new', to: 'saw' });
  }
  if (toNew.length > 0) {
    await tx.query(
      `UPDATE order_details SET production_status_id = (SELECT production_status_id FROM production_statuses WHERE production_status_code = 'new')
        WHERE detail_id = ANY($1::bigint[])`,
      [toNew.map((row) => Number(row.detail_id))],
    );
    for (const row of toNew) changed.push({ row, from: 'saw', to: 'new' });
  }

  const byOrder = new Map<number, Array<{ detailId: number; from: string; to: string }>>();
  for (const item of changed) {
    const orderId = Number(item.row.order_id);
    const list = byOrder.get(orderId) ?? [];
    list.push({ detailId: Number(item.row.detail_id), from: item.from, to: item.to });
    byOrder.set(orderId, list);
  }
  for (const [orderId, items] of [...byOrder.entries()].sort((a, b) => a[0] - b[0])) {
    // A stale client of the order (its version) must not overwrite the new statuses (as the batch command does).
    const order = (await tx.query<{ version: number; client_id: string | null }>(
      'UPDATE orders SET version = version + 1 WHERE order_id = $1 RETURNING version, client_id',
      [orderId],
    )).rows[0];
    const metadata = {
      cause: context.cause, setId: context.setId ?? null, detailIds: items.map((item) => item.detailId),
      transitions: items, orderVersion: order?.version ?? null, requestId: context.requestId,
    };
    await auditService.record(tx, {
      event: 'orders.detail_production_status_auto_change',
      entityType: 'order', entityId: orderId,
      actorUserId: context.actorUserId, actorUsername: context.actorUsername, actorRole: context.actorRole ?? null,
      requestId: context.requestId, source: context.cause === 'mdf_engine' ? 'mdf-engine' : 'bazis-cut',
      relatedOrderId: orderId, relatedClientId: order?.client_id ? Number(order.client_id) : null,
      statusField: 'productionDetailStatus',
      metadata,
      relatedEntities: items.map((item) => ({ entityType: 'order_detail', entityId: item.detailId })),
    });
    await tx.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
       VALUES ('order.detail_production_status_auto_changed', 'order', $1, $2::jsonb, $3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [String(orderId), JSON.stringify({ eventType: 'order.detail_production_status_auto_changed', orderId,
        actorUserId: context.actorUserId, ...metadata }),
      `saw-sync:${context.idempotencyKey}:${orderId}`],
    );
  }

  for (const warning of warnings) {
    await auditService.record(tx, {
      event: 'bazis_cut.detail_route_conflict',
      entityType: 'order_detail', entityId: warning.detailId,
      actorUserId: context.actorUserId, actorUsername: context.actorUsername, actorRole: context.actorRole ?? null,
      requestId: context.requestId, source: context.cause === 'mdf_engine' ? 'mdf-engine' : 'bazis-cut',
      relatedOrderId: warning.orderId,
      metadata: { cause: context.cause, setId: context.setId ?? null, cutJobIds: warning.cutJobIds,
        bazisCutSetIds: warning.bazisCutSetIds, code: warning.code },
    });
  }
  return { changedDetailIds: changed.map((item) => Number(item.row.detail_id)), warnings };
}

/** The CNC side (plan §10.4): adding details to a cut job warns (and audits) when they are in a «Базис раскрой» card. */
export async function cncRouteConflicts(
  tx: TransactionClient,
  detailIds: readonly number[],
  context: Omit<SawSyncContext, 'cause' | 'setId'> & { cutJobId: number },
): Promise<SawSyncWarning[]> {
  const ids = uniqueIds(detailIds);
  if (ids.length === 0) return [];
  const rows = (await tx.query<{ detail_id: string; order_id: string; bazis_set_ids: string[] }>(
    `SELECT od.detail_id, od.order_id, array_agg(DISTINCT bsd.bazis_cut_set_id::text) AS bazis_set_ids
       FROM order_details od
       JOIN bazis_cut_set_details bsd ON bsd.source_order_detail_id = od.detail_id
      WHERE od.detail_id = ANY($1::bigint[])
      GROUP BY od.detail_id, od.order_id
      ORDER BY od.detail_id`,
    [ids],
  )).rows;
  const warnings = rows.map((row) => ({
    code: 'DETAIL_ALSO_IN_BAZIS' as const, detailId: Number(row.detail_id), orderId: Number(row.order_id),
    cutJobIds: [context.cutJobId], bazisCutSetIds: row.bazis_set_ids.map(Number),
  }));
  for (const warning of warnings) {
    await auditService.record(tx, {
      event: 'cut.detail_route_conflict',
      entityType: 'order_detail', entityId: warning.detailId,
      actorUserId: context.actorUserId, actorUsername: context.actorUsername, actorRole: context.actorRole ?? null,
      requestId: context.requestId, source: 'cut',
      relatedOrderId: warning.orderId,
      metadata: { cutJobId: context.cutJobId, bazisCutSetIds: warning.bazisCutSetIds, code: warning.code },
    });
  }
  return warnings;
}

function uniqueIds(ids: readonly number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
}
