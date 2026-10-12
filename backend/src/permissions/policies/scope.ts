import type { CurrentUser } from '../current-user';
import { ROLE_POLICIES, type RolePolicy, type Scope } from './role-policies';
import { scopeSetsFromPolicy, type RolePolicyScopeSets, type ScopeGrant } from './scope-sets';

export interface ScopedEntity {
  createdByUserId?: string | null;
  ownerUserId?: string | null;
  managerUserId?: string | null;
  assignedUserIds?: readonly string[];
}

export function isOwn(user: CurrentUser, entity: ScopedEntity): boolean {
  return [entity.createdByUserId, entity.ownerUserId, entity.managerUserId].includes(user.id);
}

export function isAssigned(user: CurrentUser, entity: ScopedEntity): boolean {
  return entity.assignedUserIds?.includes(user.id) ?? false;
}

export function allowsScope(user: CurrentUser, scope: Scope, entity: ScopedEntity): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'own':
      return isOwn(user, entity);
    case 'assigned':
      return isAssigned(user, entity);
    case 'none':
      return false;
  }
}

export function rolePolicyForUser(user: CurrentUser): RolePolicy {
  return user.policyScopes ?? ROLE_POLICIES[user.role];
}

/**
 * Scopes as sets (access groups, plan §3.2). Tokens of older backends carry only the scalar `policyScopes`:
 * the set is then derived from it, so both formats give the same answer.
 */
export function policyScopeSetsForUser(user: CurrentUser): RolePolicyScopeSets {
  return user.policyScopeSets ?? scopeSetsFromPolicy(rolePolicyForUser(user));
}

/** True when any granted value of the set allows the entity (`own` ∪ `assigned` = OR of both). */
export function allowsScopeSet(user: CurrentUser, set: readonly ScopeGrant[], entity: ScopedEntity): boolean {
  return set.some((scope) => allowsScope(user, scope, entity));
}

/** Set membership helper for callers that need a specific grant (e.g. `all` for an unscoped list). */
export function scopeSetHas(set: readonly ScopeGrant[], scope: ScopeGrant): boolean {
  return set.includes(scope);
}
