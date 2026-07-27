import type {
  CreateNotificationRuleRequest,
  DeadlineNotificationEntityType,
  NotificationLevel,
  NotificationRuleDto,
  RecipientResolverKind,
  UpdateNotificationRuleRequest,
} from '../../../api/types/notificationRulesApi.types';
import { canAny, type PermissionCarrier } from '../../../utils/permissions';

export interface NotificationRuleDraft {
  ruleCode: string;
  eventType: string;
  groupId: string | null;
  level: NotificationLevel;
  priority: number;
  isEnabled: boolean;
  excludeCompletedOrders: boolean;
  deadlineEntityTypes: DeadlineNotificationEntityType[];
  requireCurrentDeadlineEvent: boolean;
  allowedFromOrderStatusIds: number[];
  excludeOrderStatusIds: number[];
  resolvers: RecipientResolverKind[];
  roleCodes: string[];
  userIds: number[];
  titleTemplate: string;
  messageTemplate: string;
}

export function emptyDraft(): NotificationRuleDraft {
  return {
    ruleCode: '',
    eventType: '',
    groupId: null,
    level: 'info',
    priority: 100,
    isEnabled: true,
    excludeCompletedOrders: false,
    deadlineEntityTypes: [],
    requireCurrentDeadlineEvent: true,
    allowedFromOrderStatusIds: [],
    excludeOrderStatusIds: [],
    resolvers: [],
    roleCodes: [],
    userIds: [],
    titleTemplate: '',
    messageTemplate: '',
  };
}

export function buildDraftFromRule(rule: NotificationRuleDto): NotificationRuleDraft {
  return {
    ruleCode: rule.ruleCode,
    eventType: rule.eventType,
    groupId: rule.groupId,
    level: rule.level,
    priority: rule.priority,
    isEnabled: rule.isEnabled,
    excludeCompletedOrders: rule.conditions.excludeCompletedOrders ?? false,
    deadlineEntityTypes: rule.conditions.deadlineEntityTypes ?? [],
    requireCurrentDeadlineEvent: rule.conditions.requireCurrentDeadlineEvent ?? true,
    allowedFromOrderStatusIds: [...(rule.conditions.allowedFromOrderStatusIds ?? [])],
    excludeOrderStatusIds: [...(rule.conditions.excludeOrderStatusIds ?? [])],
    resolvers: rule.recipients.resolvers ?? [],
    roleCodes: [...(rule.recipients.roleCodes ?? [])],
    userIds: [...(rule.recipients.userIds ?? [])],
    titleTemplate: rule.titleTemplate ?? '',
    messageTemplate: rule.messageTemplate ?? '',
  };
}

export function generateNotificationRuleCode(
  timestamp: number = Date.now(),
  entropy: string = createRuleCodeEntropy()
): string {
  const safeEntropy = entropy
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16);

  return `notification-rule-${timestamp.toString(36)}-${safeEntropy || 'auto'}`;
}

function normalizeTemplate(value: string): string | null {
  return value.trim() === '' ? null : value;
}

function buildConditions(draft: Partial<NotificationRuleDraft>) {
  const conditions: {
    allowedFromOrderStatusIds?: number[];
    deadlineEntityTypes?: DeadlineNotificationEntityType[];
    excludeOrderStatusIds?: number[];
    excludeCompletedOrders?: boolean;
    requireCurrentDeadlineEvent?: boolean;
  } = {};

  if (draft.deadlineEntityTypes && draft.deadlineEntityTypes.length > 0) {
    conditions.deadlineEntityTypes = [...draft.deadlineEntityTypes];
  }

  if (draft.requireCurrentDeadlineEvent === false) {
    conditions.requireCurrentDeadlineEvent = false;
  } else if (draft.requireCurrentDeadlineEvent === true && draft.deadlineEntityTypes?.length) {
    conditions.requireCurrentDeadlineEvent = true;
  }

  if (draft.allowedFromOrderStatusIds?.length) {
    conditions.allowedFromOrderStatusIds = [...draft.allowedFromOrderStatusIds];
  }

  if (draft.excludeOrderStatusIds?.length) {
    conditions.excludeOrderStatusIds = [...draft.excludeOrderStatusIds];
  }

  if (draft.excludeCompletedOrders) {
    conditions.excludeCompletedOrders = true;
  }

  return conditions;
}

function buildRecipients(draft: Partial<NotificationRuleDraft>) {
  const recipients: {
    resolvers?: RecipientResolverKind[];
    roleCodes?: string[];
    userIds?: number[];
  } = {};

  if (draft.resolvers && draft.resolvers.length > 0) {
    recipients.resolvers = [...draft.resolvers];
  }

  if (draft.roleCodes?.length) {
    recipients.roleCodes = [...draft.roleCodes];
  }

  if (draft.userIds?.length) {
    recipients.userIds = [...draft.userIds];
  }

  return recipients;
}

export function buildCreatePayload(draft: NotificationRuleDraft): CreateNotificationRuleRequest {
  return {
    ruleCode: draft.ruleCode,
    eventType: draft.eventType,
    groupId: draft.groupId,
    level: draft.level,
    priority: draft.priority,
    isEnabled: draft.isEnabled,
    conditions: buildConditions(draft),
    recipients: buildRecipients(draft),
    titleTemplate: normalizeTemplate(draft.titleTemplate),
    messageTemplate: normalizeTemplate(draft.messageTemplate),
  };
}

export function buildUpdatePayload(
  draft: NotificationRuleDraft,
  reason: string,
  expectedUpdatedAt: string
): UpdateNotificationRuleRequest {
  const result: UpdateNotificationRuleRequest = {
    reason,
    expectedUpdatedAt,
  };

  if (draft.priority !== undefined) result.priority = draft.priority;
  if (draft.isEnabled !== undefined) result.isEnabled = draft.isEnabled;
  if (draft.groupId !== undefined) result.groupId = draft.groupId;

  // Always send `conditions` on edit (even `{}`). The backend merge keeps the
  // existing `conditions` when the key is ABSENT, so omitting an empty object
  // would silently no-op a "clear all conditions" edit (stale gating persists).
  // An explicit `{}` clears it. Mirrors buildCreatePayload, which always sends.
  result.conditions = buildConditions(draft);

  const recipients = buildRecipients(draft);
  if (Object.keys(recipients).length > 0) {
    result.recipients = recipients;
  }

  if (draft.titleTemplate !== undefined) result.titleTemplate = normalizeTemplate(draft.titleTemplate);
  if (draft.messageTemplate !== undefined) result.messageTemplate = normalizeTemplate(draft.messageTemplate);

  return result;
}

export function canManageNotificationRules(user: PermissionCarrier | null | undefined): boolean {
  return canAny(['notifications.manage_rules'], user);
}

export function canViewNotificationRules(user: PermissionCarrier | null | undefined): boolean {
  return canAny(['notifications.view_rules'], user);
}

function createRuleCodeEntropy(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return Math.random().toString(36).slice(2);
}
