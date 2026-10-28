import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { readableOrderIds } from '../../../permissions/policies/order-read-visibility';
import { decideDowelingWrite, type DowelingLinkedOrder } from '../application/doweling-access';
import {
  DowelingAmountsInvalidError,
  DowelingConcurrentChangeError,
  DowelingDuplicateError,
  DowelingLinkedOrderNotFoundError,
  DowelingOrderNotFoundError,
  DowelingReferenceNotFoundError,
  BazisProjectClientMismatchError,
  BazisProjectClientAmbiguousError,
} from '../errors/doweling.errors';
import { ApiError } from '../../../common/errors/api-error';

export const SOURCE = 'backend-doweling-command';

export type DowelingWriteAction = 'doweling_create' | 'doweling_update' | 'order_save' | 'order_snapshot_import' | 'bazis_xml';

const DENIED_EVENTS: Record<DowelingWriteAction, string> = {
  doweling_create: 'doweling.create_denied',
  doweling_update: 'doweling.update_denied',
  order_save: 'doweling.link_change_denied',
  order_snapshot_import: 'doweling.link_change_denied',
  bazis_xml: 'doweling.link_change_denied',
};

interface LockedOrderRow extends QueryResultRow {
  order_id: string | number;
  created_by: string | number | null;
  manager_id: string | number | null;
  delete_flag: boolean;
  order_kind: string | null;
  client_id: string | number | null;
}

export async function setSessionUser(tx: TransactionClient, userId: string): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [userId]);
}

export function requestIdOrFallback(requestId: string | undefined): string {
  return requestId && requestId.length > 0 ? requestId : 'doweling-command';
}

/**
 * Lock hierarchy of doweling writes (shared with the order save, which locks its order FOR UPDATE, then writes links,
 * then the doweling order — directly or through the version trigger of migration 256):
 *   1. orders FOR KEY SHARE in id order (doweling commands only — the rows they link to or check);
 *   2. the doweling order FOR UPDATE;
 *   3. its links FOR UPDATE.
 * Writers that already hold an order lock (order save, snapshot import) read the doweling order's OTHER orders without
 * a lock (`readOrders(..., { lock: false })`): two order saves of orders sharing a doweling order must not wait for
 * each other's order rows.
 */
export async function lockOrders(tx: TransactionClient, orderIds: Iterable<number>): Promise<Map<number, DowelingLinkedOrder>> {
  return readOrders(tx, orderIds, { lock: true });
}

export async function readOrders(
  tx: DatabaseClient,
  orderIds: Iterable<number>,
  options: { lock: boolean },
): Promise<Map<number, DowelingLinkedOrder>> {
  const ids = [...new Set(orderIds)].sort((a, b) => a - b);
  const orders = new Map<number, DowelingLinkedOrder>();
  if (ids.length === 0) return orders;
  const result = await tx.query<LockedOrderRow>(
    `
    SELECT order_id, created_by, manager_id, delete_flag, order_kind, client_id
    FROM orders
    WHERE order_id = ANY($1::bigint[])
    ORDER BY order_id
    ${options.lock ? 'FOR KEY SHARE' : ''}
    `,
    [ids],
  );
  for (const row of result.rows) {
    const orderId = Number(row.order_id);
    orders.set(orderId, {
      orderId,
      createdByUserId: row.created_by === null ? null : String(row.created_by),
      managerUserId: row.manager_id === null ? null : String(row.manager_id),
      deleted: row.delete_flag === true,
      productionOrder: row.order_kind === 'production_order',
      clientId: row.client_id === null ? null : Number(row.client_id),
    });
  }
  return orders;
}

export interface DowelingAccessInput {
  database: DatabaseClient;
  tx: DatabaseClient;
  currentUser: CurrentUser;
  requestId: string;
  action: DowelingWriteAction;
  dowelingOrderId: number | null;
  currentOrderIds: readonly number[];
  addedOrderIds: readonly number[];
  orders: ReadonlyMap<number, DowelingLinkedOrder>;
}

/** Throws the answer of `decideDowelingWrite`; a refusal on scope is audited (best effort, outside the transaction). */
export async function assertDowelingAccess(input: DowelingAccessInput): Promise<void> {
  const readable = await readableOrderIds(input.tx, input.currentUser, [...input.currentOrderIds, ...input.addedOrderIds]);
  const decision = decideDowelingWrite(input.currentUser, {
    currentOrderIds: input.currentOrderIds,
    addedOrderIds: input.addedOrderIds,
    orders: input.orders,
    readableOrderIds: readable,
  });
  if (decision.kind === 'allowed') return;

  await recordDeniedBestEffort(input, decision.kind === 'denied' ? 'ORDER_SCOPE_DENIED' : 'ORDER_NOT_VISIBLE', decision.orderIds);
  if (decision.kind === 'doweling_hidden') {
    throw new DowelingOrderNotFoundError(input.dowelingOrderId ?? 0);
  }
  if (decision.kind === 'order_not_found') {
    throw new DowelingLinkedOrderNotFoundError(decision.orderIds);
  }
  throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для изменения Базис-проекта этого заказа', {
    requiredPermissions: ['orders.update'],
    orderIds: decision.orderIds,
  });
}

/**
 * Money of a doweling order (payment status, amounts, payment date; access groups «финансы») is changed only with
 * orders.view_financials. Checked before the command transaction; a refusal is recorded like every other doweling
 * refusal (denied audit outside the transaction) and answered 403.
 */
export async function assertDowelingMoneyAllowed(
  input: Pick<DowelingAccessInput, 'database' | 'currentUser' | 'requestId' | 'action' | 'dowelingOrderId'>,
  carriesMoney: boolean,
): Promise<void> {
  if (!carriesMoney || input.currentUser.permissions.includes('orders.view_financials')) return;
  await recordDeniedBestEffort({ ...input, requiredPermission: 'orders.view_financials' }, 'FINANCIALS_PERMISSION_REQUIRED', []);
  throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для изменения сумм и оплаты Базис-проекта', {
    requiredPermissions: ['orders.view_financials'],
  });
}

export async function recordDeniedBestEffort(
  input: Pick<DowelingAccessInput, 'database' | 'currentUser' | 'requestId' | 'action' | 'dowelingOrderId'> & { requiredPermission?: string },
  reason: string,
  orderIds: number[],
): Promise<void> {
  try {
    // Pool-backed client, outside the command transaction: the refusal stays recorded although the command rolls back.
    await auditService.recordDenied(input.database, {
      event: DENIED_EVENTS[input.action],
      entityType: 'doweling_order',
      entityId: input.dowelingOrderId ?? 'create',
      actorUserId: input.currentUser.id,
      actorUsername: input.currentUser.username,
      actorRole: input.currentUser.role,
      requestId: input.requestId,
      source: SOURCE,
      relatedOrderId: orderIds.length === 1 ? orderIds[0] : null,
      reason,
      requiredPermissions: [input.requiredPermission ?? 'orders.update'],
      relatedEntities: [
        ...(input.dowelingOrderId ? [{ entityType: 'doweling_order', entityId: input.dowelingOrderId }] : []),
        ...orderIds.map((orderId) => ({ entityType: 'order', entityId: orderId })),
      ],
      metadata: { action: input.action, dowelingOrderId: input.dowelingOrderId, orderIds },
    });
  } catch {
    /* best effort: the refusal itself must not turn into a 500 */
  }
}

interface PgError {
  code?: unknown;
  constraint?: unknown;
}

function pgError(error: unknown): PgError | null {
  return typeof error === 'object' && error !== null && 'code' in error ? (error as PgError) : null;
}

/** Maps a Postgres error of a doweling write to the API answer; anything else is rethrown unchanged. */
export function mapDowelingWriteError(error: unknown, references: Record<string, unknown>, dowelingOrderId: number | null): unknown {
  const pg = pgError(error);
  if (!pg) return error;
  const constraint = typeof pg.constraint === 'string' ? pg.constraint : null;
  switch (pg.code) {
    case '23503':
      return new DowelingReferenceNotFoundError(references);
    case '23514':
      // The deferred link trigger reuses check_violation for «not a production order».
      // A client merged into another one (guard of 268 on doweling_orders): the global filter answers 409 CLIENT_MERGED.
      if (constraint === 'chk_client_not_merged') {
        return error;
      }
      // Read-only invariant triggers of migration 279: the card, its live orders and attached XML share one client.
      if (constraint === 'chk_bazis_project_client') {
        return new BazisProjectClientMismatchError(dowelingOrderId, []);
      }
      if (constraint === 'chk_order_child_production_only') {
        return new ApiError(422, 'ORDER_NOT_PRODUCTION', 'Базис-проект можно связать только с производственным заказом', {});
      }
      return new DowelingAmountsInvalidError(constraint);
    case '23505':
      return new DowelingDuplicateError(constraint);
    case '40P01':
    case '40001':
      return new DowelingConcurrentChangeError(dowelingOrderId ?? 0);
    default:
      return error;
  }
}

/**
 * A Bazis project (doweling card) links live orders of its own client only (migration 279). Answered 409 with the
 * orders of another client before anything is written; the deferred DB triggers are the backstop for other writers.
 */
export function assertOrdersOfClient(
  dowelingOrderId: number | null,
  clientId: number,
  orderIds: readonly number[],
  orders: ReadonlyMap<number, DowelingLinkedOrder>,
): void {
  const foreign = orderIds.filter((orderId) => {
    const order = orders.get(orderId);
    return order !== undefined && !order.deleted && order.clientId !== clientId;
  });
  if (foreign.length > 0) {
    throw new BazisProjectClientMismatchError(dowelingOrderId, foreign);
  }
}

/** Clients of the groups of the XML projects attached to the card (read inside the command transaction). */
export async function readAttachedXmlClients(
  tx: DatabaseClient,
  dowelingOrderId: number,
): Promise<Array<{ bazisProjectId: number; clientId: number }>> {
  const result = await tx.query<{ bazis_project_id: string | number; client_id: string | number }>(
    `
    SELECT bp.bazis_project_id, p.client_id
    FROM bazis_projects bp
    JOIN projects p ON p.project_id = bp.project_id
    WHERE bp.doweling_order_id = $1
    ORDER BY bp.bazis_project_id
    `,
    [dowelingOrderId],
  );
  return result.rows.map((row) => ({ bazisProjectId: Number(row.bazis_project_id), clientId: Number(row.client_id) }));
}

/**
 * A card of an unknown client (`client_source = 'default'`, written by the previous backend) takes the client of its
 * live orders as soon as a writer links one (R1 #3 of the code review): order save, snapshot import, an order created
 * from XML. Locked here in id order (after the caller's order locks: the doweling lock hierarchy); one client →
 * `client_source = 'order'` and the invariant of migration 279 applies from now on; several → 409 (the user picks the
 * client in the card). Audited, with the `doweling_order.updated` event of the new version.
 */
export async function refineDefaultCardClients(
  tx: TransactionClient,
  cardIds: Iterable<number>,
  actor: { currentUser: CurrentUser; requestId: string; source: string },
): Promise<void> {
  const ids = [...new Set(cardIds)].filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
  if (ids.length === 0) return;
  const defaults = await tx.query<{ doweling_order_id: string | number; client_id: string | number }>(
    `
    SELECT doweling_order_id, client_id
    FROM doweling_orders
    WHERE doweling_order_id = ANY($1::bigint[]) AND client_source = 'default'
    ORDER BY doweling_order_id
    FOR UPDATE
    `,
    [ids],
  );
  for (const row of defaults.rows) {
    const cardId = Number(row.doweling_order_id);
    const clients = (await tx.query<{ client_id: string | number }>(
      `
      SELECT DISTINCT o.client_id
      FROM order_doweling_links l
      JOIN orders o ON o.order_id = l.order_id AND o.delete_flag = false
      WHERE l.doweling_order_id = $1 AND l.delete_flag = false
      ORDER BY o.client_id
      `,
      [cardId],
    )).rows.map((client) => Number(client.client_id));
    if (clients.length === 0) continue;
    if (clients.length > 1) throw new BazisProjectClientAmbiguousError(cardId, clients);
    const before = Number(row.client_id);
    const updated = await tx.query<{ version: number }>(
      `UPDATE doweling_orders SET client_id = $2, client_source = 'order' WHERE doweling_order_id = $1 RETURNING version`,
      [cardId, clients[0]],
    );
    const version = Number(updated.rows[0].version);
    const auditId = await auditService.record(tx, {
      event: 'doweling.updated',
      entityType: 'doweling_order',
      entityId: String(cardId),
      actorUserId: actor.currentUser.id,
      actorUsername: actor.currentUser.username,
      actorRole: actor.currentUser.role,
      requestId: actor.requestId,
      source: actor.source,
      relatedClientId: clients[0],
      before: { clientId: before, clientSource: 'default' },
      after: { clientId: clients[0], clientSource: 'order' },
      diff: { clientId: { from: before, to: clients[0] }, clientSource: { from: 'default', to: 'order' } },
      metadata: { action: 'client_refined', dowelingOrderId: cardId, version, requestId: actor.requestId },
      relatedEntities: [{ entityType: 'doweling_order', entityId: cardId }, { entityType: 'client', entityId: clients[0] }],
    });
    const key = `doweling_order.updated:${cardId}:v${version}`;
    await tx.query(
      `
      INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
      VALUES ('doweling_order.updated', 'doweling_order', $1, $2::jsonb, $3)
      ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [String(cardId), JSON.stringify({
        eventType: 'doweling_order.updated', dowelingOrderId: cardId, action: 'client_refined', changedFields: ['clientId'],
        clientId: clients[0], version, auditId, actorUserId: actor.currentUser.id, requestId: actor.requestId, idempotencyKey: key,
      }), key],
    );
  }
}
