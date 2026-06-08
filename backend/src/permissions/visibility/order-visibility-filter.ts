import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../database/database.types';
import type { CurrentUser } from '../current-user';
import { ROLE_ID_TO_ROLE, ROLE_PERMISSIONS, type KnownRoleId, type UserRole } from '../permissions';
import { OrderAccessPolicy } from '../policies/order-access.policy';

interface OrderVisibilityUserRow extends QueryResultRow {
  user_id: string | number;
  username: string | null;
  role_id: string | number;
  order_id: string | number;
  created_by: string | number | null;
  manager_id: string | number | null;
}

const orderAccessPolicy = new OrderAccessPolicy();

/** Maps a (user_id, username, role_id) row to a CurrentUser, or null for unknown roles. */
export function mapUserRow(row: { user_id: string | number; username: string | null; role_id: string | number }): CurrentUser | null {
  const roleId = Number(row.role_id);
  const role = ROLE_ID_TO_ROLE[roleId as KnownRoleId] as UserRole | undefined;
  if (!role) return null;
  return {
    id: String(row.user_id),
    username: row.username ?? String(row.user_id),
    role,
    roleId,
    permissions: ROLE_PERMISSIONS[role],
  };
}

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
  const allowed = new Set<string>();
  for (const row of rows.rows) {
    const currentUser = mapUserRow(row);
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
