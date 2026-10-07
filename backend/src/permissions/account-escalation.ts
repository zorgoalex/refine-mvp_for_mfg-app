import { ApiError } from '../common/errors/api-error';
import type { DatabaseClient } from '../database/database.types';
import type { RolePolicyScopeSets, ScopeGrant } from './policies/scope-sets';
import {
  parseAuthorizationSnapshot,
  type RawAuthorizationSnapshot,
  type UserAuthorizationSnapshot,
} from './user-authorization-snapshot';

export const ACCOUNT_ESCALATION_DENIED = 'USER_ESCALATION_DENIED';

/**
 * «Target ≼ actor» (access groups plan, stage 0A.4): an administrator without `system.superadmin` may create,
 * change, re-enable, reset the password of or manage the identities of an account only if that account (as it is
 * after the change) has no permission the administrator lacks, and for every scope key where the account has any
 * grant the administrator has `all`: «own»/«assigned» records of another person are another set of records, so
 * they are not comparable by name. Self-service (actor = target) is not compared here.
 */
export function accountEscalationViolations(
  actor: Pick<UserAuthorizationSnapshot, 'permissions' | 'scopeSets'>,
  target: Pick<UserAuthorizationSnapshot, 'permissions' | 'scopeSets'>,
): { missingPermissions: string[]; scopeKeys: string[] } {
  if (actor.permissions.includes('system.superadmin')) return { missingPermissions: [], scopeKeys: [] };
  const held = new Set<string>(actor.permissions);
  const missingPermissions = [...new Set(target.permissions.filter((permission) => !held.has(permission)))].sort();
  const scopeKeys: string[] = [];
  const targetHolds = new Set<string>(target.permissions);
  for (const [key, targetSet, actorSet] of scopeEntries(target.scopeSets, actor.scopeSets)) {
    // A scope without its permission grants nothing (§3.2): compare only scopes the target can use.
    if (!targetHolds.has(SCOPE_PERMISSION[key] ?? key)) continue;
    if (targetSet.length > 0 && !actorSet.includes('all')) scopeKeys.push(key);
  }
  return { missingPermissions, scopeKeys };
}

/** Permission behind each scope key (the key name, except production tasks). */
const SCOPE_PERMISSION: Record<string, string> = {
  'productionTasks.view': 'production.tasks.view',
  'productionTasks.update': 'production.tasks.update',
};

function scopeEntries(target: RolePolicyScopeSets, actor: RolePolicyScopeSets): Array<[string, readonly ScopeGrant[], readonly ScopeGrant[]]> {
  const entries: Array<[string, readonly ScopeGrant[], readonly ScopeGrant[]]> = [];
  for (const domain of ['orders', 'payments', 'productionTasks'] as const) {
    const targetDomain = target[domain] as Record<string, ScopeGrant[]>;
    const actorDomain = actor[domain] as Record<string, ScopeGrant[]>;
    for (const action of Object.keys(targetDomain)) {
      entries.push([`${domain}.${action}`, targetDomain[action] ?? [], actorDomain[action] ?? []]);
    }
  }
  return entries;
}

async function snapshotWith(client: DatabaseClient, userId: string | number): Promise<UserAuthorizationSnapshot | null> {
  const result = await client.query<{ snapshot: RawAuthorizationSnapshot | null }>(
    'SELECT public.user_authorization_snapshot($1::bigint) AS snapshot',
    [String(userId)],
  );
  const raw = result.rows[0]?.snapshot;
  return raw ? parseAuthorizationSnapshot(raw) : null;
}

/**
 * Called inside the command transaction AFTER the change (the target as it will be committed: new role, new user,
 * re-enabled account) and with the actor read in the same transaction. Throws 403 USER_ESCALATION_DENIED, which
 * rolls the command back; the service records the denial.
 */
export async function assertNoAccountEscalation(
  client: DatabaseClient,
  actorUserId: string | number,
  targetUserId: string | number,
): Promise<void> {
  if (String(actorUserId) === String(targetUserId)) return;
  const [actor, target] = await Promise.all([snapshotWith(client, actorUserId), snapshotWith(client, targetUserId)]);
  if (!actor || !actor.isActive) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Administrator is no longer active');
  }
  if (!target) return;
  const violations = accountEscalationViolations(actor, target);
  if (violations.missingPermissions.length > 0 || violations.scopeKeys.length > 0) {
    throw new ApiError(403, ACCOUNT_ESCALATION_DENIED,
      'The account would have permissions or scopes the administrator does not have', violations);
  }
}
