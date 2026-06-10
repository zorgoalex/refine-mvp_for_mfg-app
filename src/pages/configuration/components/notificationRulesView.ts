import type {
  CreateNotificationRuleRequest,
  NotificationLevel,
  NotificationRuleDto,
  RecipientResolverKind,
  UpdateNotificationRuleRequest,
} from '../../../api/types/notificationRulesApi.types';
import { canAny, type PermissionCarrier } from '../../../utils/permissions';

export interface NotificationRuleDraft {
  ruleCode: string;
  eventType: string;
  level: NotificationLevel;
  priority: number;
  isEnabled: boolean;
  excludeCompletedOrders: boolean;
  allowedFromOrderStatusIdsText: string;
  excludeOrderStatusIdsText: string;
  resolvers: RecipientResolverKind[];
  roleCodesText: string;
  userIdsText: string;
  titleTemplate: string;
  messageTemplate: string;
}

export function emptyDraft(): NotificationRuleDraft {
  return {
    ruleCode: '',
    eventType: '',
    level: 'info',
    priority: 100,
    isEnabled: true,
    excludeCompletedOrders: false,
    allowedFromOrderStatusIdsText: '',
    excludeOrderStatusIdsText: '',
    resolvers: [],
    roleCodesText: '',
    userIdsText: '',
    titleTemplate: '',
    messageTemplate: '',
  };
}

export function buildDraftFromRule(rule: NotificationRuleDto): NotificationRuleDraft {
  return {
    ruleCode: rule.ruleCode,
    eventType: rule.eventType,
    level: rule.level,
    priority: rule.priority,
    isEnabled: rule.isEnabled,
    excludeCompletedOrders: rule.conditions.excludeCompletedOrders ?? false,
    allowedFromOrderStatusIdsText: formatIdList(rule.conditions.allowedFromOrderStatusIds),
    excludeOrderStatusIdsText: formatIdList(rule.conditions.excludeOrderStatusIds),
    resolvers: rule.recipients.resolvers ?? [],
    roleCodesText: formatStringList(rule.recipients.roleCodes),
    userIdsText: formatIdList(rule.recipients.userIds),
    titleTemplate: rule.titleTemplate ?? '',
    messageTemplate: rule.messageTemplate ?? '',
  };
}

export function parseIdList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0);
}

export function parseRoleCodeList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function formatIdList(ids: number[] | null | undefined): string {
  return ids?.length ? ids.join(', ') : '';
}

export function formatStringList(values: string[] | null | undefined): string {
  return values?.length ? values.join(', ') : '';
}

function normalizeTemplate(value: string): string | null {
  return value.trim() === '' ? null : value;
}

function buildConditions(draft: Partial<NotificationRuleDraft>) {
  const conditions: {
    allowedFromOrderStatusIds?: number[];
    excludeOrderStatusIds?: number[];
    excludeCompletedOrders?: boolean;
  } = {};

  const allowed = parseIdList(draft.allowedFromOrderStatusIdsText);
  if (allowed.length > 0) {
    conditions.allowedFromOrderStatusIds = allowed;
  }

  const excluded = parseIdList(draft.excludeOrderStatusIdsText);
  if (excluded.length > 0) {
    conditions.excludeOrderStatusIds = excluded;
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

  const roleCodes = parseRoleCodeList(draft.roleCodesText);
  if (roleCodes.length > 0) {
    recipients.roleCodes = roleCodes;
  }

  const userIds = parseIdList(draft.userIdsText);
  if (userIds.length > 0) {
    recipients.userIds = userIds;
  }

  return recipients;
}

export function buildCreatePayload(draft: NotificationRuleDraft): CreateNotificationRuleRequest {
  return {
    ruleCode: draft.ruleCode,
    eventType: draft.eventType,
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
  expectedUpdatedAt: string,
): UpdateNotificationRuleRequest {
  const result: UpdateNotificationRuleRequest = {
    reason,
    expectedUpdatedAt,
  };

  if (draft.priority !== undefined) result.priority = draft.priority;
  if (draft.isEnabled !== undefined) result.isEnabled = draft.isEnabled;

  const conditions = buildConditions(draft);
  if (Object.keys(conditions).length > 0) {
    result.conditions = conditions;
  }

  const recipients = buildRecipients(draft);
  if (Object.keys(recipients).length > 0) {
    result.recipients = recipients;
  }

  if (draft.titleTemplate !== undefined) result.titleTemplate = normalizeTemplate(draft.titleTemplate);
  if (draft.messageTemplate !== undefined) result.messageTemplate = normalizeTemplate(draft.messageTemplate);

  return result;
}

export function canManageNotificationRules(
  user: PermissionCarrier | null | undefined,
): boolean {
  return canAny(['notifications.manage_rules'], user);
}

export function canViewNotificationRules(
  user: PermissionCarrier | null | undefined,
): boolean {
  return canAny(['notifications.view_rules'], user);
}
