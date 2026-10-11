import { ApiError } from '../../common/errors/api-error';
import type { DatabaseClient } from '../../database/database.types';
import type { CurrentUser } from '../current-user';
import { appendOrderReadVisibilitySql, orderReadVisibilityIsRestricted } from './order-read-scope-sql';

/** Whether the user may read this order (access groups 0A.4); no query when the user's reads are unrestricted. */
export async function isOrderReadable(client: DatabaseClient, currentUser: CurrentUser, orderId: number | string): Promise<boolean> {
  if (!orderReadVisibilityIsRestricted(currentUser)) return true;
  const params: unknown[] = [orderId];
  const visibility = appendOrderReadVisibilitySql(params, currentUser, 'o');
  const result = await client.query(`SELECT 1 FROM orders o WHERE o.order_id = $1::bigint AND ${visibility}`, params);
  return (result.rowCount ?? result.rows.length) > 0;
}

/** 404 ORDER_NOT_FOUND for an order outside the user's read visibility — its existence is not disclosed. */
export async function assertOrderReadable(client: DatabaseClient, currentUser: CurrentUser, orderId: number | string): Promise<void> {
  if (!(await isOrderReadable(client, currentUser, orderId))) {
    throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден', { orderId: Number(orderId) });
  }
}

/**
 * Predicate for rows that reference an order by `orderIdSql` (nullable): rows without an order stay, rows of an
 * order outside the read visibility are dropped. `TRUE` when the user's reads are unrestricted.
 */
export function appendReferencedOrderVisibilitySql(params: unknown[], currentUser: CurrentUser, orderIdSql: string, nullable = true): string {
  if (!orderReadVisibilityIsRestricted(currentUser)) return 'TRUE';
  const visibility = appendOrderReadVisibilitySql(params, currentUser, 'vis_o');
  const exists = `EXISTS (SELECT 1 FROM orders vis_o WHERE vis_o.order_id = ${orderIdSql} AND ${visibility})`;
  return nullable ? `(${orderIdSql} IS NULL OR ${exists})` : exists;
}

/**
 * Of `orderIds`, the ones the user may read; `null` when his order reads are unrestricted (no query). For responses
 * that embed references to orders (names, ids) next to non-order data: the references outside are dropped.
 */
export async function readableOrderIds(
  client: DatabaseClient,
  currentUser: CurrentUser,
  orderIds: Iterable<number | string>,
): Promise<Set<number> | null> {
  if (!orderReadVisibilityIsRestricted(currentUser)) return null;
  const ids = [...new Set([...orderIds].map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (ids.length === 0) return new Set();
  const params: unknown[] = [ids];
  const visibility = appendOrderReadVisibilitySql(params, currentUser, 'o');
  const result = await client.query<{ order_id: string | number }>(
    `SELECT o.order_id FROM orders o WHERE o.order_id = ANY($1::bigint[]) AND ${visibility}`,
    params,
  );
  return new Set(result.rows.map((row) => Number(row.order_id)));
}
