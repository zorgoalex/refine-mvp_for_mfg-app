export type NotificationLevel = 'info' | 'warning' | 'error';

export type RecipientResolverKind = 'order_manager' | 'stage_assignee' | 'project_participants';

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

export interface NotificationRuleDto {
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

export interface NotificationEventTypeDto {
  eventType: string;
  aggregateType: string;
  contextFields: string[];
  supportedResolvers: RecipientResolverKind[];
  supportsOrderConditions: boolean;
}

export interface CreateNotificationRuleRequest {
  ruleCode: string;
  eventType: string;
  level: NotificationLevel;
  priority: number;
  isEnabled: boolean;
  conditions: NotificationRuleConditions;
  recipients: NotificationRuleRecipients;
  titleTemplate?: string | null;
  messageTemplate?: string | null;
}

export interface UpdateNotificationRuleRequest {
  level?: NotificationLevel;
  priority?: number;
  isEnabled?: boolean;
  conditions?: NotificationRuleConditions;
  recipients?: NotificationRuleRecipients;
  titleTemplate?: string | null;
  messageTemplate?: string | null;
  reason?: string;
  expectedUpdatedAt?: string;
}
