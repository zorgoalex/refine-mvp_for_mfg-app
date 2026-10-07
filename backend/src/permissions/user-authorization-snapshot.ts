import { ApiError } from '../common/errors/api-error';
import type { DatabaseClient } from '../database/database.types';
import type { CurrentUser } from './current-user';
import { mapRoleIdToRole, type PermissionName, type UserRole } from './permissions';
import type { RolePolicy } from './policies/role-policies';
import { scalarPolicyFromSets, scopeSetsFromRecord, type RolePolicyScopeSets } from './policies/scope-sets';

/**
 * Effective authorization of one user, read in ONE statement (`user_authorization_snapshot`, migration 248):
 * the version can never be newer than the grants. Access groups plan §3.1, stage 0A.
 */
export interface UserAuthorizationSnapshot {
  userId: string;
  username: string;
  isActive: boolean;
  isServiceAccount: boolean;
  roleId: number;
  /** Known backend role of the base role; null for a role the backend does not map (e.g. service roles). */
  role: UserRole | null;
  roleCode: string;
  roleIsActive: boolean;
  rowVersion: number;
  accessGroupsEnabled: boolean;
  permissions: readonly PermissionName[];
  /** Scalar view for clients that know one value per key (never wider than `scopeSets`). */
  scopes: RolePolicy;
  scopeSets: RolePolicyScopeSets;
  version: number;
}

export interface RawAuthorizationSnapshot {
  userId: string | number;
  username: string;
  isActive: boolean;
  isServiceAccount: boolean;
  roleId: string | number;
  roleCode: string;
  roleIsActive: boolean;
  rowVersion: string | number;
  accessGroupsEnabled: boolean;
  version: string | number;
  permissions: string[];
  scopes: Record<string, unknown>;
}

export function parseAuthorizationSnapshot(raw: RawAuthorizationSnapshot): UserAuthorizationSnapshot {
  const version = Number(raw.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ApiError(503, 'PERMISSIONS_NOT_READY', 'Permissions runtime state is not initialized');
  }
  const roleId = Number(raw.roleId);
  const scopeSets = scopeSetsFromRecord(raw.scopes);
  return {
    userId: String(raw.userId),
    username: raw.username,
    isActive: raw.isActive === true,
    isServiceAccount: raw.isServiceAccount === true,
    roleId,
    role: mapRoleIdToRole(roleId),
    roleCode: raw.roleCode,
    roleIsActive: raw.roleIsActive === true,
    rowVersion: Number(raw.rowVersion),
    accessGroupsEnabled: raw.accessGroupsEnabled === true,
    permissions: (raw.permissions ?? []) as PermissionName[],
    scopes: scalarPolicyFromSets(scopeSets),
    scopeSets,
    version,
  };
}

/** CurrentUser for server-side evaluation (recipients, jobs, realtime); null for unknown, inactive or unmapped. */
export function evaluationUserFromSnapshot(snapshot: UserAuthorizationSnapshot | null): CurrentUser | null {
  if (!snapshot || !snapshot.isActive || !snapshot.role) return null;
  return {
    id: snapshot.userId,
    username: snapshot.username,
    role: snapshot.role,
    roleId: snapshot.roleId,
    permissions: snapshot.permissions,
    policyScopes: snapshot.scopes,
    policyScopeSets: snapshot.scopeSets,
    permissionsVersion: snapshot.version,
  };
}

/**
 * Effective users for server-side evaluation, one query for the whole list (same snapshot function as the
 * token). Replaces the static role matrix (`mapUserRow`). Inactive and unknown users are absent.
 */
export async function loadEvaluationUsersWith(
  client: DatabaseClient,
  userIds: readonly (string | number)[],
  options: { requireActiveRole?: boolean } = {},
): Promise<Map<string, CurrentUser>> {
  const ids = [...new Set(userIds.map((id) => String(id)).filter((id) => /^\d+$/.test(id)))];
  const users = new Map<string, CurrentUser>();
  if (ids.length === 0) return users;
  const result = await client.query<{ snapshot: RawAuthorizationSnapshot | null }>(
    'SELECT public.user_authorization_snapshot(id) AS snapshot FROM unnest($1::bigint[]) AS id',
    [ids],
  );
  for (const row of result.rows) {
    if (!row.snapshot) continue;
    const snapshot = parseAuthorizationSnapshot(row.snapshot);
    if (options.requireActiveRole && !snapshot.roleIsActive) continue;
    const user = evaluationUserFromSnapshot(snapshot);
    if (user) users.set(user.id, user);
  }
  return users;
}

export async function loadEvaluationUserWith(
  client: DatabaseClient,
  userId: string | number,
): Promise<CurrentUser | null> {
  return (await loadEvaluationUsersWith(client, [userId])).get(String(userId)) ?? null;
}
