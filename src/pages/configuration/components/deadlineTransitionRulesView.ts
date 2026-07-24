import type {
  CreateGlobalTransitionRuleRequest,
  DeadlineActionRuleDto,
  DeadlinePolicyDto,
  UpdateGlobalTransitionRuleRequest,
} from '../../../api/types/deadlineApi.types';
import { canAny, type PermissionCarrier } from '../../../utils/permissions';

export interface DeadlineTransitionRuleDraft {
  ruleName: string;
  ruleCode: string;
  policyId: string | null;
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

  return {
    ...buildMutablePayload(draft),
    ruleName: draft.ruleName.trim(),
    ruleCode: draft.ruleCode.trim() || undefined,
    policyId: draft.policyId,
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
): string {
  if (!rule.policyId) return 'Все дедлайны заказа';
  const policy = policies.find((item) => item.policyId === rule.policyId);
  return policy ? policy.policyName : `Политика ${rule.policyId.slice(0, 8)}`;
}

export function formatStatusNames(ids: number[], names: Map<number, string>): string {
  return ids.map((id) => names.get(id) ?? `#${id}`).join(', ');
}

function buildMutablePayload(draft: DeadlineTransitionRuleDraft) {
  return {
    isEnabled: draft.isEnabled,
    priority: draft.priority,
    eventType: 'DEADLINE_EXPIRED' as const,
    actionType: 'change_order_status' as const,
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
  if (draft.allowedFromOrderStatusIds.length === 0) {
    throw new Error('Выберите хотя бы один исходный статус');
  }
  if (draft.allowedFromOrderStatusIds.includes(draft.targetOrderStatusId)) {
    throw new Error('Целевой статус должен отличаться от исходных');
  }
  if (!Number.isInteger(draft.priority) || draft.priority < 0 || draft.priority > 100000) {
    throw new Error('Приоритет должен быть целым числом от 0 до 100000');
  }
}

function normalizeComment(comment?: string | null): string | null {
  return comment?.trim() ? comment.trim() : null;
}
