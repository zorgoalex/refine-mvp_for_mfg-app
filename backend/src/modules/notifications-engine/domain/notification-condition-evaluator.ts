import type { NotificationRuleConditions, NotificationEventContext } from './notification-rule.types';

export interface ConditionResult { matched: boolean; skipReason?: string; }

export function evaluateRuleConditions(
  conditions: NotificationRuleConditions,
  ctx: Pick<NotificationEventContext, 'orderStatusId' | 'isOrderCompleted' | 'deadlineEntityType' | 'isCurrentDeadlineEvent'>
    & Partial<Pick<NotificationEventContext, 'payload'>>,
): ConditionResult {
  // Закуп (§5.7): отсутствие поля в правиле — без ограничения; событие без changeType/role при заданном условии — нет.
  if (conditions.procurementChangeTypes?.length) {
    const changeType = ctx.payload?.changeType;
    if (typeof changeType !== 'string' || !(conditions.procurementChangeTypes as readonly string[]).includes(changeType)) {
      return { matched: false, skipReason: 'procurement_change_type_not_allowed' };
    }
  }
  if (conditions.allocationRoles?.length) {
    const role = ctx.payload?.role;
    if (typeof role !== 'string' || !(conditions.allocationRoles as readonly string[]).includes(role)) {
      return { matched: false, skipReason: 'allocation_role_not_allowed' };
    }
  }
  if (conditions.excludeCompletedOrders && ctx.isOrderCompleted) {
    return { matched: false, skipReason: 'order_completed' };
  }
  if (conditions.deadlineEntityTypes?.length) {
    if (ctx.deadlineEntityType == null) {
      return { matched: false, skipReason: 'deadline_entity_type_unavailable' };
    }
    if (!conditions.deadlineEntityTypes.includes(ctx.deadlineEntityType)) {
      return { matched: false, skipReason: 'deadline_entity_type_not_allowed' };
    }
  }
  if (conditions.excludeOrderStatusIds?.length && ctx.orderStatusId != null
      && conditions.excludeOrderStatusIds.includes(ctx.orderStatusId)) {
    return { matched: false, skipReason: 'status_excluded' };
  }
  if (conditions.allowedFromOrderStatusIds?.length) {
    if (ctx.orderStatusId == null || !conditions.allowedFromOrderStatusIds.includes(ctx.orderStatusId)) {
      return { matched: false, skipReason: 'status_not_allowed' };
    }
  }
  const requireCurrentDeadlineEvent = conditions.requireCurrentDeadlineEvent ?? true;
  if (requireCurrentDeadlineEvent && !ctx.isCurrentDeadlineEvent) {
    return { matched: false, skipReason: 'stale_deadline_event' };
  }
  return { matched: true };
}
