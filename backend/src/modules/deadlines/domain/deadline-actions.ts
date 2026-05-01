export const DEADLINE_ACTION_TYPES = [
  'notify_assignee',
  'notify_manager',
  'notify_department_head',
  'set_overdue_flag',
  'change_order_status',
  'change_production_status',
  'create_task',
  'escalate',
  'write_audit',
  'webhook',
] as const;

export type DeadlineActionType = (typeof DEADLINE_ACTION_TYPES)[number];

export type DeadlineActionExecutionStatus = 'executed' | 'skipped' | 'failed';

export function isDeadlineActionType(value: unknown): value is DeadlineActionType {
  return typeof value === 'string' && DEADLINE_ACTION_TYPES.includes(value as DeadlineActionType);
}

export function isNotificationAction(actionType: DeadlineActionType): boolean {
  return (
    actionType === 'notify_assignee' ||
    actionType === 'notify_manager' ||
    actionType === 'notify_department_head'
  );
}
