import type {
  CreateNotificationRuleRequest,
  DeadlineNotificationEntityType,
  NotificationChannel,
  NotificationLevel,
  NotificationRuleConditions,
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
  channels: NotificationChannel[];
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
  /**
   * Условия, которые форма не редактирует (закуп: procurementChangeTypes/allocationRoles). Сохраняются как есть:
   * иначе правка правила (например, включение) стёрла бы их и правило сработало бы на любые изменения (ф.4б).
   */
  preservedConditions?: Pick<NotificationRuleConditions, 'procurementChangeTypes' | 'allocationRoles'>;
}

export function emptyDraft(): NotificationRuleDraft {
  return {
    ruleCode: '',
    eventType: '',
    groupId: null,
    level: 'info',
    priority: 100,
    isEnabled: true,
    channels: ['in_app'],
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
    channels: [...(rule.channels ?? ['in_app'])],
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
    ...(rule.conditions.procurementChangeTypes || rule.conditions.allocationRoles ? {
      preservedConditions: {
        ...(rule.conditions.procurementChangeTypes ? { procurementChangeTypes: [...rule.conditions.procurementChangeTypes] } : {}),
        ...(rule.conditions.allocationRoles ? { allocationRoles: [...rule.conditions.allocationRoles] } : {}),
      },
    } : {}),
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
  const conditions: NotificationRuleConditions = {};
  if (draft.preservedConditions?.procurementChangeTypes?.length) {
    conditions.procurementChangeTypes = [...draft.preservedConditions.procurementChangeTypes];
  }
  if (draft.preservedConditions?.allocationRoles?.length) {
    conditions.allocationRoles = [...draft.preservedConditions.allocationRoles];
  }

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
    channels: [...draft.channels],
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
  result.channels = [...(draft.channels ?? ['in_app'])];
  if (draft.groupId !== undefined) result.groupId = draft.groupId;

  // Always send `conditions` on edit (even `{}`). The backend merge keeps the
  // existing `conditions` when the key is ABSENT, so omitting an empty object
  // would silently no-op a "clear all conditions" edit (stale gating persists).
  // An explicit `{}` clears it. Mirrors buildCreatePayload, which always sends.
  result.conditions = buildConditions(draft);

  const recipients = buildRecipients(draft);
  if (draft.eventType && isServiceEventType(draft.eventType)) {
    // Сервисное правило закупа: получатели отправляются ВСЕГДА — пустой выбор `{}` сбрасывает к умолчанию
    // (иначе backend оставил бы прежних получателей, план 2026-10-02 R1-1); способы определения не применимы.
    result.recipients = {
      ...(recipients.roleCodes ? { roleCodes: recipients.roleCodes } : {}),
      ...(recipients.userIds ? { userIds: recipients.userIds } : {}),
    };
  } else if (Object.keys(recipients).length > 0) {
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

/**
 * События закупа (ф.4б): правило нельзя создать формой (нет выбора изменений закупа — бэкенд потребует
 * procurementChangeTypes), только засеянное правило правится/включается; канал — только «в приложении».
 */
export const PROCUREMENT_EVENT_TYPES: readonly string[] = [
  'order.resource_procurement_changed',
  'order.resource_demand_changed_after_mark',
  'procurement.deficit_digest',
  'procurement.receipt_unallocated',
];

/**
 * События сервиса закупа (ф.4б-2, план 2026-10-02): уведомления пишет сервис по расписанию (раз в день); получатели —
 * роли и/или пользователи правила, пусто — умолчание. Получает только тот, у кого есть нужное право.
 */
export const SERVICE_EVENT_RECIPIENTS: Readonly<Record<string, string>> = {
  'procurement.deficit_digest': 'По умолчанию: все с правом «Закупки: управление» — каждому по его заказам',
  'procurement.receipt_unallocated': 'По умолчанию: все с правом «Закупки: управление»',
};

/** Право, без которого сервис не пошлёт уведомление выбранному получателю. */
export const SERVICE_EVENT_REQUIRED_RIGHT: Readonly<Record<string, string>> = {
  'procurement.deficit_digest': 'Закупки: управление',
  'procurement.receipt_unallocated': 'Закупки: просмотр',
};

/** Описание получателей сервисного правила в таблице: свои — с оговоркой о праве; пусто — умолчание. */
export function describeServiceRecipients(eventType: string, custom: string | null): string {
  if (!custom) return SERVICE_EVENT_RECIPIENTS[eventType] ?? '—';
  const right = SERVICE_EVENT_REQUIRED_RIGHT[eventType];
  return right ? `${custom} (только с правом «${right}»)` : custom;
}

export function isServiceEventType(eventType: string): boolean {
  return eventType in SERVICE_EVENT_RECIPIENTS;
}

export function isProcurementEventType(eventType: string): boolean {
  return PROCUREMENT_EVENT_TYPES.includes(eventType);
}

export function creatableEventTypes<T extends { eventType: string }>(eventTypes: readonly T[]): T[] {
  return eventTypes.filter((eventType) => !isProcurementEventType(eventType.eventType));
}
