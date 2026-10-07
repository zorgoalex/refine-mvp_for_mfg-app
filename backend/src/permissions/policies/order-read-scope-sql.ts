import type { CurrentUser } from '../current-user';
import type { Scope } from './role-policies';
import { policyScopeSetsForUser } from './scope';
import { normalizeScopeSet, type ScopeGrant } from './scope-sets';

/** One scope value (legacy callers) or a scope set (access groups): both give the same SQL for one value. */
export type ScopeInput = Scope | readonly ScopeGrant[];

function toScopeSet(scope: ScopeInput): ScopeGrant[] {
  return normalizeScopeSet(typeof scope === 'string' ? [scope] : scope);
}

/** True when the predicate needs the actor parameter (own and/or assigned granted, without all). */
export function scopeNeedsActor(scope: ScopeInput): boolean {
  const set = toScopeSet(scope);
  return !set.includes('all') && (set.includes('own') || set.includes('assigned'));
}

export interface OrderReadScopeSql {
  predicate: string;
  actorIndex: number | null;
  assignedSql: string;
}

/** SQL equivalent of OrderAccessPolicy.canView for cross-domain order reads. */
export function appendOrderReadScopeSql(
  params: unknown[],
  currentUser: CurrentUser,
  orderAlias = 'o',
): OrderReadScopeSql {
  // The user's effective scope set (token), not the static role matrix (access groups stage 0A).
  const scope = policyScopeSetsForUser(currentUser).orders.view;
  const actorIndex = scopeNeedsActor(scope)
    ? params.push(normalizeActorUserId(currentUser.id))
    : null;
  const assignedSql = actorIndex === null ? 'FALSE' : orderAssignmentExistsSql(orderAlias, actorIndex);
  return {
    predicate: buildOrderReadScopePredicate(scope, actorIndex, assignedSql, orderAlias),
    actorIndex,
    assignedSql,
  };
}

export function buildOrderReadScopePredicate(
  scope: ScopeInput,
  actorIndex: number | null,
  assignedSql: string,
  orderAlias = 'o',
): string {
  const set = toScopeSet(scope);
  if (set.includes('all')) return 'TRUE';
  const parts: string[] = [];
  if (set.includes('own')) {
    const requiredActorIndex = requireActorIndex(actorIndex);
    parts.push(`(${orderAlias}.created_by = $${requiredActorIndex} OR ${orderAlias}.manager_id = $${requiredActorIndex})`);
  }
  if (set.includes('assigned')) parts.push(assignedSql);
  if (parts.length === 0) return 'FALSE';
  // own ∪ assigned (from different sources) = OR of both predicates; one value = the same SQL as before.
  return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

export function orderAssignmentExistsSql(orderAlias: string, actorIndex: number): string {
  return `EXISTS (
    SELECT 1
    FROM order_workshops assigned_ow
    JOIN users assigned_user
      ON assigned_user.employee_id = assigned_ow.responsible_employee_id
    WHERE assigned_ow.order_id = ${orderAlias}.order_id
      AND assigned_ow.delete_flag = false
      AND assigned_ow.responsible_employee_id IS NOT NULL
      AND assigned_user.is_active = true
      AND assigned_user.user_id = $${actorIndex}
  )`;
}

export function normalizeActorUserId(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : -1;
}

function requireActorIndex(actorIndex: number | null): number {
  if (actorIndex === null) throw new Error('Actor SQL parameter is required');
  return actorIndex;
}
