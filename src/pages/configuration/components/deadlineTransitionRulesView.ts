import type {
  CreateGlobalTransitionRuleRequest,
  DeadlineActionRuleDeadlineTargetDto,
  DeadlineActionRuleDto,
  DeadlineDefaultScheduleDto,
  DeadlinePolicyDto,
  UpdateGlobalTransitionRuleRequest,
} from '../../../api/types/deadlineApi.types';
import { canAny, type PermissionCarrier } from '../../../utils/permissions';

export interface DeadlineTransitionRuleDraft {
  ruleName: string;
  ruleCode: string;
  policyId: string | null;
  deadlineTarget: DeadlineActionRuleDeadlineTargetDto;
  delayAfterDeadlineEnabled: boolean;
  delayDays: number;
  delayHours: number;
  delayMinutes: number;
  isEnabled: boolean;
  priority: number;
  targetOrderStatusId: number | null;
  allowedFromOrderStatusIds: number[];
  excludeOrderStatusIds: number[];
  excludeCompletedOrders: boolean;
  requireCurrentDeadlineEvent: boolean;
}

export interface DeadlineTransitionRuleCatalogs {
  statusNames: Map<number, string>;
  policyNames: Map<string, string>;
}

export function canManageDeadlineTransitionRules(
  user: PermissionCarrier | null | undefined,
): boolean {
  return canAny(['deadlines.actions.manage'], user);
}

export function emptyTransitionRuleDraft(): DeadlineTransitionRuleDraft {
  return {
    ruleName: '',
    ruleCode: '',
    policyId: null,
    deadlineTarget: { type: 'all_order_deadlines' },
    delayAfterDeadlineEnabled: false,
    delayDays: 0,
    delayHours: 0,
    delayMinutes: 0,
    isEnabled: false,
    priority: 100,
    targetOrderStatusId: null,
    allowedFromOrderStatusIds: [],
    excludeOrderStatusIds: [],
    excludeCompletedOrders: true,
    requireCurrentDeadlineEvent: true,
  };
}

export function buildTransitionRuleDraft(rule: DeadlineActionRuleDto): DeadlineTransitionRuleDraft {
  return {
    ruleName: rule.config?.ruleName?.trim() || `Правило ${rule.actionRuleId.slice(0, 8)}`,
    ruleCode: rule.config?.ruleCode ?? '',
    policyId: rule.policyId ?? null,
    deadlineTarget: rule.config?.deadlineTarget ?? {
      type: 'all_order_deadlines',
    },
    delayAfterDeadlineEnabled: Boolean(rule.config?.delayAfterDeadline),
    delayDays: rule.config?.delayAfterDeadline?.days ?? 0,
    delayHours: rule.config?.delayAfterDeadline?.hours ?? 0,
    delayMinutes: rule.config?.delayAfterDeadline?.minutes ?? 0,
    isEnabled: rule.isEnabled,
    priority: rule.priority,
    targetOrderStatusId: rule.config?.actionConfig?.targetOrderStatusId ?? null,
    allowedFromOrderStatusIds: [...(rule.config?.conditions?.allowedFromOrderStatusIds ?? [])],
    excludeOrderStatusIds: [...(rule.config?.conditions?.excludeOrderStatusIds ?? [])],
    excludeCompletedOrders: true,
    requireCurrentDeadlineEvent: true,
  };
}

export function buildTransitionRuleCreatePayload(
  draft: DeadlineTransitionRuleDraft,
  reason: string,
  comment?: string | null,
): CreateGlobalTransitionRuleRequest {
  validateTransitionRuleDraft(draft, reason);
  const delayAfterDeadline = buildDelayAfterDeadline(draft);

  return {
    ...buildMutablePayload(draft),
    ruleName: draft.ruleName.trim(),
    ruleCode: draft.ruleCode.trim() || undefined,
    policyId: draft.policyId,
    deadlineTarget: draft.deadlineTarget,
    ...(delayAfterDeadline
      ? { delayAfterDeadline }
      : {}),
    reason: reason.trim(),
    comment: normalizeComment(comment),
  };
}

export function buildTransitionRuleUpdatePayload(
  rule: DeadlineActionRuleDto,
  draft: DeadlineTransitionRuleDraft,
  reason: string,
  comment?: string | null,
): UpdateGlobalTransitionRuleRequest {
  validateTransitionRuleDraft(draft, reason);

  return {
    expectedUpdatedAt: rule.updatedAt,
    ...buildMutablePayload(draft),
    ruleName: draft.ruleName.trim(),
    ruleCode: draft.ruleCode.trim() || null,
    policyId: draft.policyId,
    deadlineTarget: draft.deadlineTarget,
    delayAfterDeadline: buildDelayAfterDeadline(draft),
    reason: reason.trim(),
    comment: normalizeComment(comment),
  };
}

export function describeTransition(
  rule: DeadlineActionRuleDto,
  catalogs: DeadlineTransitionRuleCatalogs,
): string {
  const from = formatStatusNames(
    rule.config?.conditions?.allowedFromOrderStatusIds ?? [],
    catalogs.statusNames,
  );
  const targetId = rule.config?.actionConfig?.targetOrderStatusId;
  const target = targetId ? catalogs.statusNames.get(targetId) ?? `#${targetId}` : 'не задан';
  return `${from || '—'} → ${target}`;
}

export function describeRuleScope(
  rule: DeadlineActionRuleDto,
  policies: DeadlinePolicyDto[],
  productionStatusNames: Map<number, string> = new Map(),
): string {
  if (rule.policyId) {
    const policy = policies.find((item) => item.policyId === rule.policyId);
    return policy ? policy.policyName : `Политика ${rule.policyId.slice(0, 8)}`;
  }
  const target = rule.config?.deadlineTarget;
  if (!target || target.type === 'all_order_deadlines') {
    return 'Все дедлайны заказа';
  }
  if (target.type === 'final_order') {
    return 'Финальный дедлайн заказа';
  }
  return `Этап: ${
    productionStatusNames.get(target.productionStatusId)
    ?? `#${target.productionStatusId}`
  }`;
}

export function describeRuleDelay(rule: DeadlineActionRuleDto): string {
  const delay = rule.config?.delayAfterDeadline;
  if (!delay) return 'Сразу';
  return [
    delay.days > 0 ? `${delay.days} дн.` : null,
    delay.hours > 0 ? `${delay.hours} ч.` : null,
    delay.minutes > 0 ? `${delay.minutes} мин.` : null,
  ].filter(Boolean).join(' ');
}

export function formatStatusNames(ids: number[], names: Map<number, string>): string {
  return ids.map((id) => names.get(id) ?? `#${id}`).join(', ');
}

export function buildDeadlineTargetOptions(
  schedule: DeadlineDefaultScheduleDto | null,
  policies: DeadlinePolicyDto[],
): Array<{ value: string; label: string }> {
  return [
    { value: 'all_order_deadlines', label: 'Все дедлайны заказа' },
    { value: 'final_order', label: 'Финальный дедлайн заказа' },
    ...(schedule?.stages ?? [])
      .filter((stage) => stage.durationDays !== null)
      .map((stage) => ({
        value: `production_stage:${stage.productionStatusId}`,
        label: `Этап: ${stage.productionStatusName}`,
      })),
    ...policies
      .filter((policy) =>
        ['order', 'order_stage', 'client_action'].includes(policy.scopeType),
      )
      .map((policy) => ({
        value: `policy:${policy.policyId}`,
        label: `Политика: ${policy.policyName}${
          policy.isEnabled ? '' : ' (выключена)'
        }`,
      })),
  ];
}

export function getDeadlineTargetOptionValue(
  draft: DeadlineTransitionRuleDraft,
): string {
  if (draft.policyId) return `policy:${draft.policyId}`;
  if (draft.deadlineTarget.type === 'final_order') return 'final_order';
  if (draft.deadlineTarget.type === 'production_stage') {
    return `production_stage:${draft.deadlineTarget.productionStatusId}`;
  }
  return 'all_order_deadlines';
}

export function getDeadlineRuleTimingKey(
  draft: DeadlineTransitionRuleDraft,
): string {
  const delay = buildDelayAfterDeadline(draft);
  return [
    getDeadlineTargetOptionValue(draft),
    delay?.days ?? 0,
    delay?.hours ?? 0,
    delay?.minutes ?? 0,
  ].join(':');
}

export function applyDeadlineTargetOption(
  draft: DeadlineTransitionRuleDraft,
  value: string,
): DeadlineTransitionRuleDraft {
  if (value === 'all_order_deadlines') {
    return {
      ...draft,
      policyId: null,
      deadlineTarget: { type: 'all_order_deadlines' },
    };
  }
  if (value === 'final_order') {
    return {
      ...draft,
      policyId: null,
      deadlineTarget: { type: 'final_order' },
    };
  }
  if (value.startsWith('production_stage:')) {
    const productionStatusId = Number(value.slice('production_stage:'.length));
    if (!Number.isInteger(productionStatusId) || productionStatusId <= 0) {
      throw new Error('Некорректный этап производства');
    }
    return {
      ...draft,
      policyId: null,
      deadlineTarget: { type: 'production_stage', productionStatusId },
    };
  }
  if (value.startsWith('policy:') && value.length > 'policy:'.length) {
    return {
      ...draft,
      policyId: value.slice('policy:'.length),
      deadlineTarget: { type: 'all_order_deadlines' },
    };
  }
  throw new Error('Некорректная область дедлайна');
}

function buildMutablePayload(draft: DeadlineTransitionRuleDraft) {
  return {
    isEnabled: draft.isEnabled,
    priority: draft.priority,
    eventType: 'DEADLINE_EXPIRED' as const,
    actionType: 'change_order_status' as const,
    deadlineTarget: draft.deadlineTarget,
    targetOrderStatusId: draft.targetOrderStatusId as number,
    allowedFromOrderStatusIds: [...new Set(draft.allowedFromOrderStatusIds)],
    excludeOrderStatusIds: [...new Set(draft.excludeOrderStatusIds)],
    excludeCompletedOrders: draft.excludeCompletedOrders,
    requireCurrentDeadlineEvent: draft.requireCurrentDeadlineEvent,
  };
}

function validateTransitionRuleDraft(
  draft: DeadlineTransitionRuleDraft,
  reason: string,
): void {
  if (!draft.ruleName.trim()) throw new Error('Укажите название правила');
  if (!reason.trim()) throw new Error('Укажите причину изменения');
  if (!draft.targetOrderStatusId) throw new Error('Выберите целевой статус');
  if (
    draft.deadlineTarget.type === 'production_stage'
    && (!Number.isInteger(draft.deadlineTarget.productionStatusId)
      || draft.deadlineTarget.productionStatusId <= 0)
  ) {
    throw new Error('Выберите этап производства');
  }
  if (draft.allowedFromOrderStatusIds.length === 0) {
    throw new Error('Выберите хотя бы один исходный статус');
  }
  if (draft.allowedFromOrderStatusIds.includes(draft.targetOrderStatusId)) {
    throw new Error('Целевой статус должен отличаться от исходных');
  }
  if (draft.excludeOrderStatusIds.includes(draft.targetOrderStatusId)) {
    throw new Error('Целевой статус не должен быть исключён');
  }
  if (
    draft.allowedFromOrderStatusIds.some((statusId) =>
      draft.excludeOrderStatusIds.includes(statusId),
    )
  ) {
    throw new Error('Исходные и исключённые статусы не должны пересекаться');
  }
  if (!draft.excludeCompletedOrders || !draft.requireCurrentDeadlineEvent) {
    throw new Error('Обязательные защиты правила должны быть включены');
  }
  if (draft.delayAfterDeadlineEnabled) {
    const values = [draft.delayDays, draft.delayHours, draft.delayMinutes];
    if (values.some((value) => !Number.isInteger(value) || value < 0)) {
      throw new Error('Срок должен состоять из целых неотрицательных значений');
    }
    if (draft.delayDays > 3650 || draft.delayHours > 23 || draft.delayMinutes > 59) {
      throw new Error('Допустимо: до 3650 дней, 23 часов и 59 минут');
    }
    if (draft.delayDays + draft.delayHours + draft.delayMinutes === 0) {
      throw new Error('Укажите хотя бы один ненулевой срок');
    }
  }
  if (!Number.isInteger(draft.priority) || draft.priority < 0 || draft.priority > 100000) {
    throw new Error('Приоритет должен быть целым числом от 0 до 100000');
  }
}

function buildDelayAfterDeadline(
  draft: DeadlineTransitionRuleDraft,
): CreateGlobalTransitionRuleRequest['delayAfterDeadline'] | null {
  if (!draft.delayAfterDeadlineEnabled) return null;
  return {
    days: draft.delayDays,
    hours: draft.delayHours,
    minutes: draft.delayMinutes,
  };
}

function normalizeComment(comment?: string | null): string | null {
  return comment?.trim() ? comment.trim() : null;
}
