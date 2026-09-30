import type { QueryResultRow } from 'pg';
import type { DatabaseClient } from '../../database/database.types';
import type { CurrentUser } from '../current-user';
import { ROLE_ID_TO_ROLE, ROLE_PERMISSIONS, type KnownRoleId, type PermissionName, type UserRole } from '../permissions';
import { OrderAccessPolicy } from '../policies/order-access.policy';
import { scopesFromRows } from '../permissions.service';

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

/**
 * Same as {@link filterUserIdsByOrderVisibility}, but with the LIVE role matrix — the source
 * backend authorization uses (`role_permissions` of active catalog entries + `role_policy_scopes`),
 * not the static defaults. A role without matrix rows sees nothing (fail closed).
 */
export async function filterUserIdsByOrderVisibilityFromMatrix(
  client: DatabaseClient,
  userIds: string[],
  orderId: string,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = (await client.query<OrderVisibilityUserRow>(
    `
    SELECT u.user_id::text AS user_id, u.username, u.role_id, o.order_id, o.created_by, o.manager_id
    FROM public.users u
    CROSS JOIN public.orders o
    WHERE u.user_id = ANY($1::bigint[]) AND o.order_id = $2::bigint AND o.delete_flag = false
    `,
    [userIds, orderId],
  )).rows;
  if (rows.length === 0) return new Set();
  const roleIds = [...new Set(rows.map((row) => Number(row.role_id)))];
  const permissions = (await client.query<{ role_id: string | number; permission_name: PermissionName }>(
    `SELECT rp.role_id, rp.permission_name
     FROM public.role_permissions rp
     JOIN public.permissions_catalog pc ON pc.permission_name = rp.permission_name AND pc.is_active = true
     WHERE rp.role_id = ANY($1::int[]) AND rp.is_enabled = true`,
    [roleIds],
  )).rows;
  const scopes = (await client.query<{ role_id: string | number; scope_key: string; scope_value: string }>(
    'SELECT role_id, scope_key, scope_value FROM public.role_policy_scopes WHERE role_id = ANY($1::int[])',
    [roleIds],
  )).rows;
  // `assigned` scope: the backend predicate — responsible employee of a live order workshop
  // linked to an active user (pg-order-status-board-repository assignmentExistsSql).
  const assignedUserIds = (await client.query<{ user_id: string | number }>(
    `SELECT DISTINCT assigned_user.user_id
     FROM public.order_workshops assigned_ow
     JOIN public.users assigned_user ON assigned_user.employee_id = assigned_ow.responsible_employee_id
     WHERE assigned_ow.order_id = $1::bigint
       AND assigned_ow.delete_flag = false
       AND assigned_ow.responsible_employee_id IS NOT NULL
       AND assigned_user.is_active = true`,
    [orderId],
  )).rows.map((row) => String(row.user_id));
  const allowed = new Set<string>();
  for (const row of rows) {
    const roleId = Number(row.role_id);
    const role = ROLE_ID_TO_ROLE[roleId as KnownRoleId] as UserRole | undefined;
    if (!role) continue;
    const currentUser: CurrentUser = {
      id: String(row.user_id),
      username: row.username ?? String(row.user_id),
      role,
      roleId,
      permissions: permissions.filter((p) => Number(p.role_id) === roleId).map((p) => p.permission_name),
      policyScopes: scopesFromRows(scopes.filter((s) => Number(s.role_id) === roleId) as never),
    };
    if (orderAccessPolicy.canView(currentUser, {
      orderId: row.order_id,
      createdByUserId: nullableString(row.created_by),
      managerUserId: nullableString(row.manager_id),
      ownerUserId: nullableString(row.manager_id),
      assignedUserIds,
    })) {
      allowed.add(String(row.user_id));
    }
  }
  return allowed;
}

function nullableString(value: string | number | null): string | null {
  return value == null ? null : String(value);
}
