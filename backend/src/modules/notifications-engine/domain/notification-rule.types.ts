import type { RecipientResolverKind } from './notification-event-registry';

export type NotificationLevel = 'info' | 'warning' | 'error';

export interface NotificationRuleConditions {
  allowedFromOrderStatusIds?: number[];
  excludeOrderStatusIds?: number[];
  excludeCompletedOrders?: boolean;
}

export interface NotificationRuleRecipients {
  resolvers?: RecipientResolverKind[];
  roleCodes?: string[];
  userIds?: number[];
}

export interface NotificationRule {
  notificationRuleId: string;
  ruleCode: string;
  eventType: string;
  isEnabled: boolean;
  priority: number;
  level: NotificationLevel;
  conditions: NotificationRuleConditions;
  recipients: NotificationRuleRecipients;
  titleTemplate: string | null;
  messageTemplate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationEventContext {
  eventType: string;
  outboxEventId: string;
  aggregateType: string;
  aggregateId: string;
  orderId: number | null;
  clientId: number | null;
  paymentId: number | null;
  deadlineId: number | null;
  /**
   * The deadline INSTANCE id (UUID string) for deadline-derived events, or
   * `null` for non-deadline events. This is the
   * `deadline.event.created` envelope's `aggregate_id` (= `event.deadlineId`
   * in the producer payload at `pg-deadline-repository.enqueueOutboxEvent`).
   * The numeric `deadlineId` field is kept for legacy consumers but is always
   * `null` for deadline events because the producer payload does not emit a
   * numeric `deadlineId`. Template authors should use `{orderId}` for the
   * parent order and resolve the deadline id via this field where needed.
   */
  deadlineInstanceId: string | null;
  orderStatusId: number | null;
  isOrderCompleted: boolean;
  payload: Record<string, unknown>;
}
