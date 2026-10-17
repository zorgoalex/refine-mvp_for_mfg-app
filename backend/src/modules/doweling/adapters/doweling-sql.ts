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
} from '../errors/doweling.errors';
import { ApiError } from '../../../common/errors/api-error';

export const SOURCE = 'backend-doweling-command';

export type DowelingWriteAction = 'doweling_create' | 'doweling_update' | 'order_save' | 'order_snapshot_import';

const DENIED_EVENTS: Record<DowelingWriteAction, string> = {
  doweling_create: 'doweling.create_denied',
  doweling_update: 'doweling.update_denied',
  order_save: 'doweling.link_change_denied',
  order_snapshot_import: 'doweling.link_change_denied',
};

interface LockedOrderRow extends QueryResultRow {
  order_id: string | number;
  created_by: string | number | null;
  manager_id: string | number | null;
  delete_flag: boolean;
  order_kind: string | null;
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
    SELECT order_id, created_by, manager_id, delete_flag, order_kind
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
  throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для изменения присадки этого заказа', {
    requiredPermissions: ['orders.update'],
    orderIds: decision.orderIds,
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
      if (constraint === 'chk_order_child_production_only') {
        return new ApiError(422, 'ORDER_NOT_PRODUCTION', 'Присадку можно связать только с производственным заказом', {});
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
