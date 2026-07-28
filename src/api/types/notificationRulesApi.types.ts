export type NotificationLevel = 'info' | 'warning' | 'error';
export type NotificationChannel = 'in_app' | 'telegram';
export type DeadlineNotificationEntityType = 'order' | 'order_stage';

export type RecipientResolverKind =
  | 'order_manager'
  | 'stage_assignee'
  | 'workshop_head'
  | 'direction_head'
  | 'group_participants';

export interface NotificationRuleConditions {
  allowedFromOrderStatusIds?: number[];
  deadlineEntityTypes?: DeadlineNotificationEntityType[];
  excludeOrderStatusIds?: number[];
  excludeCompletedOrders?: boolean;
  requireCurrentDeadlineEvent?: boolean;
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
  groupId: string | null;
  isEnabled: boolean;
  priority: number;
  level: NotificationLevel;
  channels: NotificationChannel[];
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
  supportsDeadlineConditions: boolean;
}

export interface CreateNotificationRuleRequest {
  ruleCode: string;
  eventType: string;
  groupId?: string | null;
  level: NotificationLevel;
  priority: number;
  isEnabled: boolean;
  channels: NotificationChannel[];
  conditions: NotificationRuleConditions;
  recipients: NotificationRuleRecipients;
  titleTemplate?: string | null;
  messageTemplate?: string | null;
}

export interface UpdateNotificationRuleRequest {
  groupId?: string | null;
  level?: NotificationLevel;
  priority?: number;
  isEnabled?: boolean;
  channels?: NotificationChannel[];
  conditions?: NotificationRuleConditions;
  recipients?: NotificationRuleRecipients;
  titleTemplate?: string | null;
  messageTemplate?: string | null;
  reason?: string;
  expectedUpdatedAt?: string;
}
