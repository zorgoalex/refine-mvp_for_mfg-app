import type {
  DeadlineActionRuleDto,
  UpdateGlobalTransitionRuleRequest,
} from '../../../api/types/deadlineApi.types';
import { canAny, type PermissionCarrier } from '../../../utils/permissions';

export interface DeadlineTransitionRuleDraft {
  isEnabled: boolean;
  priority: number;
  targetOrderStatusId: number | null;
  allowedFromOrderStatusIdsText: string;
  excludeOrderStatusIdsText: string;
  excludeCompletedOrders: boolean;
  requireCurrentDeadlineEvent: boolean;
}

export function canManageDeadlineTransitionRules(
  user: PermissionCarrier | null | undefined,
): boolean {
  return canAny(['deadlines.actions.manage'], user);
}

export function buildTransitionRuleDraft(rule: DeadlineActionRuleDto): DeadlineTransitionRuleDraft {
  return {
    isEnabled: rule.isEnabled,
    priority: rule.priority,
    targetOrderStatusId: rule.config?.actionConfig?.targetOrderStatusId ?? null,
    allowedFromOrderStatusIdsText: formatStatusIdList(
      rule.config?.conditions?.allowedFromOrderStatusIds,
    ),
    excludeOrderStatusIdsText: formatStatusIdList(rule.config?.conditions?.excludeOrderStatusIds),
    excludeCompletedOrders: rule.config?.conditions?.excludeCompletedOrders ?? true,
    requireCurrentDeadlineEvent: rule.config?.conditions?.requireCurrentDeadlineEvent ?? true,
  };
}

export function buildTransitionRuleUpdatePayload(
  rule: DeadlineActionRuleDto,
  draft: DeadlineTransitionRuleDraft,
  reason: string,
  comment?: string | null,
): UpdateGlobalTransitionRuleRequest {
  const allowedFromOrderStatusIds = parseStatusIdList(
    draft.allowedFromOrderStatusIdsText,
    'Allowed-from statuses',
  );
  const excludeOrderStatusIds = parseStatusIdList(
    draft.excludeOrderStatusIdsText,
    'Excluded statuses',
  );

  if (allowedFromOrderStatusIds.length === 0) {
    throw new Error('Allowed-from statuses are required');
  }

  const payload: UpdateGlobalTransitionRuleRequest = {
    expectedUpdatedAt: rule.updatedAt,
    priority: draft.priority,
    eventType: 'DEADLINE_EXPIRED',
    actionType: 'change_order_status',
    targetOrderStatusId: draft.targetOrderStatusId ?? undefined,
    allowedFromOrderStatusIds,
    excludeOrderStatusIds,
    excludeCompletedOrders: draft.excludeCompletedOrders,
    requireCurrentDeadlineEvent: draft.requireCurrentDeadlineEvent,
    reason,
    comment: comment?.trim() ? comment.trim() : null,
  };

  return payload;
}

export function formatStatusIdList(ids: number[] | null | undefined): string {
  return ids?.length ? ids.join(', ') : '';
}

export function parseStatusIdList(value: string, label = 'Status list'): number[] {
  const tokens = value
    .split(/[,\s]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const invalidTokens = tokens.filter((token) => {
    return !/^[1-9]\d*$/.test(token);
  });

  if (invalidTokens.length > 0) {
    throw new Error(`${label} contains invalid status ids: ${invalidTokens.join(', ')}`);
  }

  return tokens.map((token) => Number(token));
}
