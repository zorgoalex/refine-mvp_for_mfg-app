import { ApiError } from '../common/errors/api-error';
import type { DatabaseClient } from '../database/database.types';
import { accountEscalationViolations } from './account-escalation';
import type { PermissionName } from './permissions';
import { UserAccessPolicy, type UserDenialReason } from './policies/user-access.policy';
import {
  loadEvaluationUserWith,
  parseAuthorizationSnapshot,
  type RawAuthorizationSnapshot,
} from './user-authorization-snapshot';

/** Permissions that together manage the authorization model (same set as the roles-matrix lockout check). */
export const ADMINISTRATION_PERMISSIONS: readonly PermissionName[] = [
  'system.superadmin',
  'roles.manage',
  'permissions.manage',
];

/**
 * Step 1 of the authorization command protocol (access groups plan §5.1): `permissions_state` is locked before any
 * user row. `update` for commands that change authorization (they serialize), `share` for commands that only depend
 * on it (an SSO invitation): a concurrent change waits for them and they wait for it. Returns the version.
 */
export async function lockAuthorizationState(client: DatabaseClient, mode: 'update' | 'share'): Promise<number> {
  const result = await client.query<{ version: string | number }>(
    `SELECT version FROM permissions_state WHERE id = true FOR ${mode === 'update' ? 'UPDATE' : 'SHARE'}`,
  );
  const version = Number(result.rows[0]?.version ?? 0);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ApiError(503, 'PERMISSIONS_NOT_READY', 'Permissions runtime state is not initialized');
  }
  return version;
}

/** Increments the authorization version under the lock of step 1 and returns the new value. */
export async function bumpAuthorizationVersion(client: DatabaseClient): Promise<number> {
  const result = await client.query<{ version: string | number }>(
    'UPDATE permissions_state SET version = version + 1, updated_at = now() WHERE id = true RETURNING version',
  );
  return Number(result.rows[0]?.version);
}

/**
 * Lockout protection (§5.2), checked on the state the command is about to commit: at least one active, non-service
 * user must keep every administration permission in his effective grants. Otherwise 409 and the command rolls back.
 */
export async function assertAdministrationRemains(client: DatabaseClient): Promise<void> {
  const result = await client.query<{ remains: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1
      FROM users u
      JOIN user_effective_permissions p ON p.user_id = u.user_id
      WHERE u.is_active AND NOT u.is_service_account
        AND p.permission_name = ANY($1::text[])
      GROUP BY u.user_id
      HAVING count(DISTINCT p.permission_name) = cardinality($1::text[])
    ) AS remains
    `,
    [ADMINISTRATION_PERMISSIONS],
  );
  if (result.rows[0]?.remains !== true) {
    throw new ApiError(409, 'PERMISSIONS_LOCKOUT_DENIED', 'Нельзя оставить систему без активного администратора', {
      requiredPermissions: ADMINISTRATION_PERMISSIONS,
    });
  }
}

const SSO_POLICY = new UserAccessPolicy();

/**
 * Administration of another user's SSO identities, decided inside the command transaction on fresh data (after
 * `lockAuthorizationState`): the actor still holds `users.manage_sso`, passes the role boundary, and the target has
 * no permission or scope the actor lacks (0A.4). Used when an invitation is created and again when it is used, so
 * an invitation never outlives the authority of its creator.
 */
export async function ssoManagementDenial(
  client: DatabaseClient,
  actorUserId: string | number,
  targetUserId: string | number,
): Promise<UserDenialReason | null> {
  const actor = await loadEvaluationUserWith(client, actorUserId);
  if (!actor || !actor.permissions.includes('users.manage_sso')) return 'missing_permission';
  const raw = await client.query<{ snapshot: RawAuthorizationSnapshot | null }>(
    'SELECT public.user_authorization_snapshot($1::bigint) AS snapshot',
    [String(targetUserId)],
  );
  const target = raw.rows[0]?.snapshot ? parseAuthorizationSnapshot(raw.rows[0].snapshot) : null;
  const roleDenial = SSO_POLICY.canManageSso(actor, target?.role ?? null);
  if (roleDenial || !target || String(actorUserId) === String(targetUserId)) return roleDenial;
  const actorSnapshot = { permissions: actor.permissions, scopeSets: actor.policyScopeSets! };
  const violations = accountEscalationViolations(actorSnapshot, target);
  return violations.missingPermissions.length > 0 || violations.scopeKeys.length > 0
    ? 'privilege_escalation_denied'
    : null;
}
