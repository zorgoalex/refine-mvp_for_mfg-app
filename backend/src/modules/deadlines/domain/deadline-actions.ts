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

export const DEADLINE_AUDIT_SOURCES = ['admin-ui', 'backend-command', 'deadline-engine'] as const;

export type DeadlineAuditSource = (typeof DEADLINE_AUDIT_SOURCES)[number];

export const DEADLINE_AUDIT_EVENTS = [
  'deadline.timer_rule_created',
  'deadline.timer_rule_updated',
  'deadline.timer_rule_enabled',
  'deadline.timer_rule_disabled',
  'deadline.action_rule_created',
  'deadline.action_rule_updated',
  'deadline.action_rule_enabled',
  'deadline.action_rule_disabled',
  'deadline.order_override_created',
  'deadline.order_override_updated',
  'deadline.order_override_removed',
] as const;

export type DeadlineAuditEvent = (typeof DEADLINE_AUDIT_EVENTS)[number];

export type DeadlineAuditState = Record<string, unknown>;

export interface DeadlineExecutionSnapshotEvidence {
  actionExecutionId?: string | null;
  deadlineEventId?: string | null;
  actionRuleVersionId?: string | null;
  ruleConfigSnapshot: DeadlineAuditState;
  snapshotHash: string;
}

export interface DeadlineAuditContract {
  event: DeadlineAuditEvent;
  source: DeadlineAuditSource;
  actorUserId: number | string | null;
  requestId: string | null;
  timerRuleId: string | null;
  actionRuleId: string | null;
  orderId: number | null;
  before: DeadlineAuditState;
  after: DeadlineAuditState;
  diff: DeadlineAuditState;
  reason: string | null;
  comment: string | null;
  executionEvidence: DeadlineExecutionSnapshotEvidence | null;
}

export type DeadlineOrderOverrideAuditEvent = Extract<
  DeadlineAuditEvent,
  | 'deadline.order_override_created'
  | 'deadline.order_override_updated'
  | 'deadline.order_override_removed'
>;

export interface DeadlineOrderOverrideAuditContract extends DeadlineAuditContract {
  event: DeadlineOrderOverrideAuditEvent;
  orderId: number;
  reason: string;
}

export const DEADLINE_ORDER_OVERRIDE_TARGET_TYPES = ['policy', 'action_rule'] as const;

export type DeadlineOrderOverrideTargetType = (typeof DEADLINE_ORDER_OVERRIDE_TARGET_TYPES)[number];

export const CHANGE_PRODUCTION_STATUS_ACTION_CONFIG_CONTRACT = {
  actionType: 'change_production_status',
  supportedEventTypes: ['DEADLINE_EXPIRED'],
  requiredActionConfig: ['targetProductionStatusId', 'productionStatusScope'],
  supportedProductionStatusScopes: ['order'],
  idempotencyMaterial: [
    'deadlineEventId',
    'actionType',
    'actionRuleId',
    'orderId',
    'targetProductionStatusId',
    'snapshotHash',
  ],
} as const;

export function isDeadlineActionType(value: unknown): value is DeadlineActionType {
  return typeof value === 'string' && DEADLINE_ACTION_TYPES.includes(value as DeadlineActionType);
}

export function isDeadlineAuditEvent(value: unknown): value is DeadlineAuditEvent {
  return typeof value === 'string' && DEADLINE_AUDIT_EVENTS.includes(value as DeadlineAuditEvent);
}

export function isDeadlineOrderOverrideTargetType(
  value: unknown,
): value is DeadlineOrderOverrideTargetType {
  return (
    typeof value === 'string' &&
    DEADLINE_ORDER_OVERRIDE_TARGET_TYPES.includes(value as DeadlineOrderOverrideTargetType)
  );
}

export function isNotificationAction(actionType: DeadlineActionType): boolean {
  return (
    actionType === 'notify_assignee' ||
    actionType === 'notify_manager' ||
    actionType === 'notify_department_head'
  );
}
