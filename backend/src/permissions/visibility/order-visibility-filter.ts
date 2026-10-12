import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../database/database.types';
import { OrderAccessPolicy } from '../policies/order-access.policy';
import { loadEvaluationUsersWith } from '../user-authorization-snapshot';

interface OrderVisibilityUserRow extends QueryResultRow {
  user_id: string | number;
  username: string | null;
  role_id: string | number;
  order_id: string | number;
  created_by: string | number | null;
  manager_id: string | number | null;
}

const orderAccessPolicy = new OrderAccessPolicy();

/** Returns the subset of userIds (as string) that can base-view the given order. Reuses OrderAccessPolicy.canView. */
export async function filterUserIdsByOrderVisibility(
  client: DatabaseClient,
  userIds: string[],
  orderId: string,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await client.query<OrderVisibilityUserRow>(
    `
    SELECT u.user_id::text AS user_id, u.username, u.role_id, o.order_id, o.created_by, o.manager_id
    FROM public.users u
    CROSS JOIN public.orders o
    WHERE u.user_id = ANY($1::bigint[]) AND o.order_id = $2::bigint AND o.delete_flag = false
    `,
    [userIds, orderId],
  );
  // Effective authorization (same snapshot as the token), not the static role matrix.
  const users = await loadEvaluationUsersWith(client, rows.rows.map((row) => row.user_id));
  const allowed = new Set<string>();
  for (const row of rows.rows) {
    const currentUser = users.get(String(row.user_id)) ?? null;
    if (currentUser && orderAccessPolicy.canView(currentUser, {
      orderId: row.order_id,
      createdByUserId: nullableString(row.created_by),
      managerUserId: nullableString(row.manager_id),
      ownerUserId: nullableString(row.manager_id),
    })) {
      allowed.add(String(row.user_id));
    }
  }
  return allowed;
}

function nullableString(value: string | number | null): string | null {
  return value == null ? null : String(value);
}
