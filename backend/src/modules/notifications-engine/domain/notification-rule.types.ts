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
  orderStatusId: number | null;
  isOrderCompleted: boolean;
  payload: Record<string, unknown>;
}
