import { ApiError } from '../common/errors/api-error';
import type { DatabaseClient } from '../database/database.types';
import type { PermissionName } from './permissions';

/**
 * Permissions whose Hasura paths stay open after access groups 0Б (plan report 2026-10-13 §5): every other Hasura
 * permission requires the user's effective permission (ops/hasura/access-predicates.json), but the financial columns
 * of orders_view / order_details / doweling orders are still read by every role that reads the row. Taking such a
 * permission away from a role would leave GraphQL serving what the backend refuses, so the roles matrix refuses it
 * until the path is closed (the «finances» stage removes the entry).
 */
export const HASURA_UNCLOSED_PERMISSIONS: Readonly<Partial<Record<PermissionName, string>>> = {
  'orders.view_financials': 'суммы заказов, деталей и присадки ещё читаются напрямую через Hasura',
};

const NOT_FOLLOWING_REASON = 'прямые запросы к базе (Hasura) сейчас не проверяют права пользователя';

interface MatrixGrants {
  roles: ReadonlyArray<{ roleId: number | string; roleCode: string }>;
  rolePermissions: Record<string, Record<string, boolean> | undefined>;
  roleScopes?: Record<string, Record<string, string> | undefined>;
}

/**
 * Whether Hasura follows the effective permissions: permissions_state.hasura_access_predicates (migration 253), set by
 * the metadata step B and cleared by its revert. Read through to_jsonb so a database without the column answers false.
 */
export async function hasuraFollowsPermissions(client: DatabaseClient): Promise<boolean> {
  const result = await client.query<{ value: boolean | null }>(
    "SELECT (to_jsonb(ps) ->> 'hasura_access_predicates')::boolean AS value FROM permissions_state ps WHERE ps.id = true",
  );
  return result.rows[0]?.value === true;
}

/**
 * Refuses a matrix change that Hasura would not enforce (PERMISSION_NARROWING_BLOCKED): while Hasura does not follow
 * the effective permissions (before the metadata step B, after its revert) — every permission taken away and every
 * scope narrowed; once it does — the permissions whose Hasura paths are still open.
 */
export function assertNoUnclosedHasuraNarrowing(before: MatrixGrants, next: MatrixGrants, followsPermissions: boolean): void {
  const blocked: Array<{ roleId: string; roleCode: string; permission?: string; scope?: string; reason: string }> = [];
  for (const role of next.roles) {
    const roleId = String(role.roleId);
    const permissions = new Set([
      ...Object.keys(before.rolePermissions[roleId] ?? {}),
      ...Object.keys(next.rolePermissions[roleId] ?? {}),
    ]);
    for (const permission of permissions) {
      const was = before.rolePermissions[roleId]?.[permission] === true;
      const now = next.rolePermissions[roleId]?.[permission] === true;
      if (!was || now) continue;
      const unclosed = HASURA_UNCLOSED_PERMISSIONS[permission as PermissionName];
      if (!followsPermissions) blocked.push({ roleId, roleCode: role.roleCode, permission, reason: NOT_FOLLOWING_REASON });
      else if (unclosed) blocked.push({ roleId, roleCode: role.roleCode, permission, reason: unclosed });
    }
    if (!followsPermissions) {
      const beforeScopes = before.roleScopes?.[roleId] ?? {};
      const nextScopes = next.roleScopes?.[roleId] ?? {};
      for (const [scope, value] of Object.entries(beforeScopes)) {
        const changed = nextScopes[scope] ?? 'none';
        // Widening is fine: to `all`, or from `none` to anything. Every other change loses records (own ↔ assigned too).
        if (changed !== value && changed !== 'all' && value !== 'none') {
          blocked.push({ roleId, roleCode: role.roleCode, scope, reason: NOT_FOLLOWING_REASON });
        }
      }
    }
  }
  if (blocked.length > 0) {
    throw new ApiError(
      422,
      'PERMISSION_NARROWING_BLOCKED',
      `Это право пока нельзя снять у роли: ${blocked[0].reason}`,
      { blocked, hasuraFollowsPermissions: followsPermissions },
    );
  }
}
