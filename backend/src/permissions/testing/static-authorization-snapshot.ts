import { getPermissionsForRole, mapRoleIdToRole } from '../permissions';
import { ROLE_POLICIES } from '../policies/role-policies';
import { scopeSetsFromPolicy } from '../policies/scope-sets';
import type { RawAuthorizationSnapshot, UserAuthorizationSnapshot } from '../user-authorization-snapshot';

/** Test fixture: the snapshot a user of the given base role would get from the static matrix (no groups). */
export function staticAuthorizationSnapshot(input: {
  userId: string | number;
  username?: string;
  roleId: number;
  version?: number;
  isActive?: boolean;
}): UserAuthorizationSnapshot {
  const role = mapRoleIdToRole(input.roleId);
  const scopes = role ? ROLE_POLICIES[role] : ROLE_POLICIES.viewer;
  return {
    userId: String(input.userId),
    username: input.username ?? `user-${input.userId}`,
    isActive: input.isActive ?? true,
    isServiceAccount: false,
    roleId: input.roleId,
    role,
    roleCode: role ?? 'unknown',
    roleIsActive: true,
    rowVersion: 1,
    accessGroupsEnabled: false,
    permissions: role ? getPermissionsForRole(role) : [],
    scopes,
    scopeSets: scopeSetsFromPolicy(scopes),
    version: input.version ?? 1,
  };
}

/** Test fixture: the row `user_authorization_snapshot(user_id)` would return for the static matrix of a role. */
export function staticRawAuthorizationSnapshot(input: {
  userId: string | number;
  username?: string;
  roleId: number;
  version?: number;
  isActive?: boolean;
}): RawAuthorizationSnapshot {
  const parsed = staticAuthorizationSnapshot(input);
  const scopes: Record<string, string[]> = {};
  for (const [domain, actions] of Object.entries(parsed.scopeSets)) {
    for (const [action, set] of Object.entries(actions as Record<string, string[]>)) scopes[`${domain}.${action}`] = [...set];
  }
  return {
    userId: parsed.userId, username: parsed.username, isActive: parsed.isActive, isServiceAccount: false,
    roleId: parsed.roleId, roleCode: parsed.roleCode, roleIsActive: true, rowVersion: 1,
    accessGroupsEnabled: false, version: parsed.version, permissions: [...parsed.permissions], scopes,
  };
}

/** Answers `SELECT public.user_authorization_snapshot(id) ... unnest($1)` / `($1::bigint)` in fake databases. */
export function fakeSnapshotRows(params: readonly unknown[], roleOf: (userId: string) => number | undefined): Array<{ snapshot: RawAuthorizationSnapshot | null }> {
  const first = params[0];
  const ids = Array.isArray(first) ? first.map(String) : [String(first)];
  return ids.map((id) => {
    const roleId = roleOf(id);
    return { snapshot: roleId === undefined ? null : staticRawAuthorizationSnapshot({ userId: id, roleId }) };
  });
}
