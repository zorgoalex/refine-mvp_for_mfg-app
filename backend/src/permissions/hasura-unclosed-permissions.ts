import { ApiError } from '../common/errors/api-error';
import type { DatabaseClient } from '../database/database.types';
import type { PermissionName } from './permissions';

/**
 * Permissions whose Hasura paths stay open after access groups 0Б (plan report 2026-10-13 §5): every other Hasura
 * permission requires the user's effective permission (ops/hasura/access-predicates.json), but the financial columns
 * of orders_view / order_details / doweling orders are read by every role that reads the row until the metadata step
 * F2 of the «finances» stage (plan 2026-10-17 §2) moves them behind orders.view_financials. Taking such a permission
 * away from a role while its path is open would leave GraphQL serving what the backend refuses, so the roles matrix
 * refuses it; `closedBy` names the permissions_state.hasura_financials_state value that closes the path.
 */
export const HASURA_UNCLOSED_PERMISSIONS: Readonly<Partial<Record<PermissionName, { reason: string; closedBy: HasuraFinancialsState }>>> = {
  'orders.view_financials': { reason: 'суммы заказов, деталей и присадки ещё читаются напрямую через Hasura', closedBy: 'closed' },
};

/** permissions_state.hasura_financials_state (migration 258): open → closed by step F2; reverting during its revert. */
export type HasuraFinancialsState = 'open' | 'closed' | 'reverting';

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

/** The financials state; a database without migration 258 answers `open` (to_jsonb, like hasuraFollowsPermissions). */
export async function hasuraFinancialsState(client: DatabaseClient): Promise<HasuraFinancialsState> {
  const result = await client.query<{ value: string | null }>(
    "SELECT to_jsonb(ps) ->> 'hasura_financials_state' AS value FROM permissions_state ps WHERE ps.id = true",
  );
  const value = result.rows[0]?.value;
  return value === 'closed' || value === 'reverting' ? value : 'open';
}

/**
 * Refuses a matrix change that Hasura would not enforce (PERMISSION_NARROWING_BLOCKED): while Hasura does not follow
 * the effective permissions (before the metadata step B, after its revert) — every permission taken away and every
 * scope narrowed; once it does — the permissions whose Hasura paths are still open.
 */
export function assertNoUnclosedHasuraNarrowing(
  before: MatrixGrants,
  next: MatrixGrants,
  followsPermissions: boolean,
  financialsState: HasuraFinancialsState = 'open',
): void {
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
      else if (unclosed && financialsState !== unclosed.closedBy) blocked.push({ roleId, roleCode: role.roleCode, permission, reason: unclosed.reason });
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
      { blocked, hasuraFollowsPermissions: followsPermissions, hasuraFinancialsState: financialsState },
    );
  }
}
