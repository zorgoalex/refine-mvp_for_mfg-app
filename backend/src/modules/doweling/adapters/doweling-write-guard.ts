import type { QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { readableOrderIds } from '../../../permissions/policies/order-read-visibility';
import { decideDowelingWrite } from '../application/doweling-access';
import { DowelingOrderNotFoundError } from '../errors/doweling.errors';
import { readOrders, recordDeniedBestEffort, type DowelingWriteAction } from './doweling-sql';

interface DowelingOrdersRow extends QueryResultRow {
  doweling_order_id: string | number;
  legacy_order_id: string | number | null;
  linked: Array<string | number>;
}

export interface DowelingWriteGuardInput {
  /** Pool-backed client for the denied-audit row (outside the caller's transaction). */
  database: DatabaseClient;
  tx: DatabaseClient;
  currentUser: CurrentUser;
  requestId: string;
  action: Extract<DowelingWriteAction, 'order_save' | 'order_snapshot_import' | 'bazis_xml'>;
  /** Doweling orders whose links or fields the caller changes. */
  dowelingOrderIds: Iterable<number>;
  /** The order the caller saves: its update scope is the caller's own check, its row is already locked (0 — none). */
  ownOrderId: number;
}

/**
 * The doweling rule for writers that change doweling orders as a side effect of another aggregate — the order save
 * (attach, detach, change of the design engineer) and the order snapshot import. Same rule as the doweling commands and
 * the Hasura predicate it replaces: `doweling.update`, and every OTHER order the doweling order is linked to (active
 * links and the legacy `order_id`) must be readable and updatable by the user. Those orders are read without a lock
 * (see the lock hierarchy in doweling-sql.ts).
 */
export async function assertDowelingOrdersWritable(input: DowelingWriteGuardInput): Promise<void> {
  const ids = [...new Set(input.dowelingOrderIds)].filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
  if (ids.length === 0) return;

  if (!input.currentUser.permissions.includes('doweling.update')) {
    await recordDeniedBestEffort(
      { ...input, dowelingOrderId: ids.length === 1 ? ids[0] : null, requiredPermission: 'doweling.update' },
      'PERMISSION_DENIED',
      input.ownOrderId > 0 ? [input.ownOrderId] : [],
    );
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для изменения Базис-проекта', {
      requiredPermissions: ['doweling.update'],
      dowelingOrderIds: ids,
    });
  }

  const rows = (
    await input.tx.query<DowelingOrdersRow>(
      `
      SELECT d.doweling_order_id, d.order_id AS legacy_order_id,
             ARRAY(SELECT l.order_id FROM order_doweling_links l
                   WHERE l.doweling_order_id = d.doweling_order_id AND l.delete_flag = false) AS linked
      FROM doweling_orders d
      WHERE d.doweling_order_id = ANY($1::bigint[])
      `,
      [ids],
    )
  ).rows;
  const found = new Map(rows.map((row) => [Number(row.doweling_order_id), row]));
  const missing = ids.find((id) => !found.has(id));
  if (missing !== undefined) {
    throw new DowelingOrderNotFoundError(missing);
  }

  const othersByDoweling = new Map<number, number[]>();
  for (const [dowelingOrderId, row] of found) {
    const orderIds = [...row.linked.map(Number), ...(row.legacy_order_id === null ? [] : [Number(row.legacy_order_id)])];
    othersByDoweling.set(dowelingOrderId, [...new Set(orderIds)].filter((orderId) => orderId !== input.ownOrderId));
  }
  const allOthers = [...new Set([...othersByDoweling.values()].flat())];
  if (allOthers.length === 0) return;

  const orders = await readOrders(input.tx, allOthers, { lock: false });
  const readable = await readableOrderIds(input.tx, input.currentUser, allOthers);
  for (const [dowelingOrderId, others] of othersByDoweling) {
    const decision = decideDowelingWrite(input.currentUser, {
      currentOrderIds: others,
      addedOrderIds: [],
      orders,
      readableOrderIds: readable,
    });
    if (decision.kind === 'allowed') continue;
    await recordDeniedBestEffort(
      { ...input, dowelingOrderId },
      decision.kind === 'denied' ? 'ORDER_SCOPE_DENIED' : 'ORDER_NOT_VISIBLE',
      decision.orderIds,
    );
    if (decision.kind === 'denied') {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Базис-проект связан с заказом, который вам нельзя менять', {
        requiredPermissions: ['orders.update'],
        dowelingOrderId,
        orderIds: decision.orderIds,
      });
    }
    throw new DowelingOrderNotFoundError(dowelingOrderId);
  }
}

/**
 * The same rule as `assertDowelingOrdersWritable`, answered as a boolean and without the denied audit — for previews
 * and obstacles of writers that change cards as a side effect (client merge and its undo): every order of each card
 * (active links ∪ legacy `order_id`), except the caller's own ones, must be readable and updatable by the user.
 */
export async function dowelingOrdersWritable(
  input: Pick<DowelingWriteGuardInput, 'tx' | 'currentUser' | 'dowelingOrderIds'> & { ownOrderIds?: readonly number[] },
): Promise<boolean> {
  const ids = [...new Set(input.dowelingOrderIds)].filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
  if (ids.length === 0) return true;
  if (!input.currentUser.permissions.includes('doweling.update')) return false;
  const own = new Set(input.ownOrderIds ?? []);
  const rows = (
    await input.tx.query<DowelingOrdersRow>(
      `
      SELECT d.doweling_order_id, d.order_id AS legacy_order_id,
             ARRAY(SELECT l.order_id FROM order_doweling_links l
                   WHERE l.doweling_order_id = d.doweling_order_id AND l.delete_flag = false) AS linked
      FROM doweling_orders d
      WHERE d.doweling_order_id = ANY($1::bigint[])
      `,
      [ids],
    )
  ).rows;
  const others = [...new Set(rows.flatMap((row) => [
    ...row.linked.map(Number), ...(row.legacy_order_id === null ? [] : [Number(row.legacy_order_id)]),
  ]))].filter((orderId) => !own.has(orderId));
  if (others.length === 0) return true;
  const orders = await readOrders(input.tx, others, { lock: false });
  const readable = await readableOrderIds(input.tx, input.currentUser, others);
  return decideDowelingWrite(input.currentUser, { currentOrderIds: others, addedOrderIds: [], orders, readableOrderIds: readable })
    .kind === 'allowed';
}

/** Cards of an unknown client (`client_source = 'default'`) among these: a writer that links them refines their client. */
export async function defaultCardIds(tx: DatabaseClient, ids: Iterable<number>): Promise<number[]> {
  const list = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (list.length === 0) return [];
  return (await tx.query<{ doweling_order_id: string | number }>(
    `SELECT doweling_order_id FROM doweling_orders WHERE doweling_order_id = ANY($1::bigint[]) AND client_source = 'default'`,
    [list],
  )).rows.map((row) => Number(row.doweling_order_id));
}
