import type { CurrentUser } from '../current-user';
import { ROLE_POLICIES, type Scope } from './role-policies';

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
  const scope = ROLE_POLICIES[currentUser.role].orders.view;
  const actorIndex = scope === 'own' || scope === 'assigned'
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
  scope: Scope,
  actorIndex: number | null,
  assignedSql: string,
  orderAlias = 'o',
): string {
  switch (scope) {
    case 'all':
      return 'TRUE';
    case 'own': {
      const requiredActorIndex = requireActorIndex(actorIndex);
      return `(${orderAlias}.created_by = $${requiredActorIndex} OR ${orderAlias}.manager_id = $${requiredActorIndex})`;
    }
    case 'assigned':
      return assignedSql;
    case 'none':
      return 'FALSE';
  }
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
