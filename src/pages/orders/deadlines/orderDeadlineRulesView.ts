import type {
  DeadlineActionRuleDto,
  DeadlineEventsResponse,
  DeadlineEventDto,
  DeadlineOrderOverrideDto,
  DeadlineOrderOverrideTargetType,
  OrderDeadlineSummary,
  OrderDeadlinesResponse,
  OrderEffectiveDeadlineRulesResponse,
  PreviewOrderDeadlineActionRulesRequest,
  PreviewOrderDeadlineActionRulesResponse,
  UpsertDeadlineOrderOverrideRequest,
} from '../../../api/types/deadlineApi.types';
import { can, canAny, type PermissionCarrier } from '../../../utils/permissions';

export interface EffectivePolicyRuleRow {
  key: string;
  policyId: string;
  name: string;
  code: string;
  scopeType: string;
  enabled: boolean;
  overrideId: string | null;
  overrideDisabled: boolean;
  overrideReason: string | null;
  targetType: 'policy';
}

export interface EffectiveActionRuleRow {
  key: string;
  actionRuleId: string;
  actionType: string;
  eventType: string;
  enabled: boolean;
  priority: number;
  targetStatusId: number | null;
  allowedFrom: string;
  excluded: string;
  excludeCompletedOrders: boolean;
  overrideId: string | null;
  overrideDisabled: boolean;
  overrideReason: string | null;
  targetType: 'action_rule';
}

export interface PreviewActionRuleRow {
  key: string;
  actionRuleId: string;
  priority: number;
  actionType: string;
  wouldRun: boolean;
  wouldSkipReason: string | null;
  targetStatusId: number | null;
  overrideId: string | null;
  selected: boolean;
}

export interface OrderOverrideRow {
  key: string;
  overrideId: string;
  targetType: DeadlineOrderOverrideTargetType;
  targetId: string;
  isDisabled: boolean;
  reason: string;
  createdByUserId: number;
  updatedByUserId: number;
  updatedAt: string;
}

export interface OrderDeadlinePanelLoadApi {
  getSummaryForOrder(orderId: number): Promise<OrderDeadlineSummary>;
  listForOrder(orderId: number): Promise<OrderDeadlinesResponse>;
  listEventsForOrder(orderId: number): Promise<DeadlineEventsResponse>;
  getOrderEffectiveRules(orderId: number): Promise<OrderEffectiveDeadlineRulesResponse>;
  previewOrderActionRules(
    orderId: number,
    request: PreviewOrderDeadlineActionRulesRequest,
  ): Promise<PreviewOrderDeadlineActionRulesResponse>;
}

export interface OrderDeadlinePanelLoadResult {
  summary: OrderDeadlineSummary;
  deadlines: OrderDeadlinesResponse['data'];
  events: DeadlineEventsResponse['data'];
  effectiveRules: OrderEffectiveDeadlineRulesResponse | null;
  preview: PreviewOrderDeadlineActionRulesResponse | null;
  rulesError: string | null;
  previewUnavailableReason: string | null;
}

export function canViewOrderDeadlineRules(user: PermissionCarrier | null | undefined): boolean {
  return canAny(['deadlines.actions.manage', 'deadlines.manage_order_overrides'], user);
}

export function canEditOrderDeadlineOverrides(user: PermissionCarrier | null | undefined): boolean {
  return can('deadlines.manage_order_overrides', user);
}

export function buildEffectivePolicyRows(
  response: OrderEffectiveDeadlineRulesResponse | null,
): EffectivePolicyRuleRow[] {
  return (response?.policies ?? []).map((policy) => ({
    key: policy.policyId,
    policyId: policy.policyId,
    name: policy.policyName,
    code: policy.policyCode,
    scopeType: policy.scopeType,
    enabled: policy.isEnabled,
    overrideId: policy.override?.overrideId ?? null,
    overrideDisabled: policy.override?.isDisabled ?? false,
    overrideReason: policy.override?.reason ?? null,
    targetType: 'policy',
  }));
}

export function buildEffectiveActionRuleRows(
  response: OrderEffectiveDeadlineRulesResponse | null,
): EffectiveActionRuleRow[] {
  return (response?.actionRules ?? []).map((rule) => ({
    key: rule.actionRuleId,
    actionRuleId: rule.actionRuleId,
    actionType: rule.actionType,
    eventType: rule.eventType,
    enabled: rule.isEnabled,
    priority: rule.priority,
    targetStatusId: getTargetStatusId(rule),
    allowedFrom: formatIdList(rule.config?.conditions?.allowedFromOrderStatusIds),
    excluded: formatIdList(rule.config?.conditions?.excludeOrderStatusIds),
    excludeCompletedOrders: rule.config?.conditions?.excludeCompletedOrders ?? false,
    overrideId: rule.override?.overrideId ?? null,
    overrideDisabled: rule.override?.isDisabled ?? false,
    overrideReason: rule.override?.reason ?? null,
    targetType: 'action_rule',
  }));
}

export function buildPreviewActionRuleRows(
  response: PreviewOrderDeadlineActionRulesResponse | null,
): PreviewActionRuleRow[] {
  return (response?.candidateActionRules ?? []).map((candidate) => ({
    key: candidate.actionRuleId,
    actionRuleId: candidate.actionRuleId,
    priority: candidate.priority,
    actionType: candidate.actionType,
    wouldRun: candidate.wouldRun,
    wouldSkipReason: candidate.wouldSkipReason,
    targetStatusId: candidate.targetOrderStatusId,
    overrideId: candidate.overrideId,
    selected: response?.selectedActionRuleId === candidate.actionRuleId,
  }));
}

export function buildOrderOverrideRows(overrides: DeadlineOrderOverrideDto[]): OrderOverrideRow[] {
  return overrides.map((override) => ({
    key: override.overrideId,
    overrideId: override.overrideId,
    targetType: override.targetType,
    targetId: override.policyId ?? override.actionRuleId ?? '',
    isDisabled: override.isDisabled,
    reason: override.reason,
    createdByUserId: override.createdByUserId,
    updatedByUserId: override.updatedByUserId,
    updatedAt: override.updatedAt,
  }));
}

export function selectDeadlineActionPreviewContext(
  events: DeadlineEventDto[],
): PreviewOrderDeadlineActionRulesRequest | null {
  const latestExpiredEvent = events
    .filter((event) => event.eventType === 'DEADLINE_EXPIRED')
    .sort((left, right) => Date.parse(right.eventAt) - Date.parse(left.eventAt))[0];

  if (!latestExpiredEvent) return null;

  const fixtureKey =
    typeof latestExpiredEvent.payload?.fixtureKey === 'string' &&
    latestExpiredEvent.payload.fixtureKey.trim() !== ''
      ? latestExpiredEvent.payload.fixtureKey
      : null;

  return {
    eventType: 'DEADLINE_EXPIRED',
    deadlineId: latestExpiredEvent.deadlineId,
    deadlineEventId: latestExpiredEvent.deadlineEventId,
    ...(fixtureKey ? { fixtureKey } : {}),
  };
}

export async function loadOrderDeadlinePanelData(input: {
  orderId: number;
  canViewRules: boolean;
  api: OrderDeadlinePanelLoadApi;
}): Promise<OrderDeadlinePanelLoadResult> {
  const [summary, deadlines, events] = await Promise.all([
    input.api.getSummaryForOrder(input.orderId),
    input.api.listForOrder(input.orderId),
    input.api.listEventsForOrder(input.orderId),
  ]);

  if (!input.canViewRules) {
    return {
      summary,
      deadlines: deadlines.data,
      events: events.data,
      effectiveRules: null,
      preview: null,
      rulesError: null,
      previewUnavailableReason: null,
    };
  }

  let effectiveRules: OrderEffectiveDeadlineRulesResponse | null = null;
  let preview: PreviewOrderDeadlineActionRulesResponse | null = null;
  let rulesError: string | null = null;
  let previewUnavailableReason: string | null = null;

  try {
    effectiveRules = await input.api.getOrderEffectiveRules(input.orderId);
  } catch (error) {
    rulesError = getErrorMessage(error, 'Не удалось загрузить правила дедлайнов');
  }

  const previewContext = selectDeadlineActionPreviewContext(events.data);
  if (!previewContext) {
    previewUnavailableReason = 'Нет контекста DEADLINE_EXPIRED события';
  } else {
    try {
      preview = await input.api.previewOrderActionRules(input.orderId, previewContext);
    } catch (error) {
      previewUnavailableReason = getErrorMessage(error, 'Не удалось загрузить dry-run preview');
    }
  }

  return {
    summary,
    deadlines: deadlines.data,
    events: events.data,
    effectiveRules,
    preview,
    rulesError,
    previewUnavailableReason,
  };
}

export function buildDisableOrderOverrideRequest(
  targetType: DeadlineOrderOverrideTargetType,
  targetId: string,
  reason: string,
): UpsertDeadlineOrderOverrideRequest {
  if (targetType === 'policy') {
    return {
      targetType,
      policyId: targetId,
      isDisabled: true,
      reason,
    };
  }

  return {
    targetType,
    actionRuleId: targetId,
    isDisabled: true,
    reason,
  };
}

export function formatIdList(ids: number[] | null | undefined): string {
  return ids?.length ? ids.join(', ') : '';
}

function getTargetStatusId(rule: DeadlineActionRuleDto): number | null {
  return rule.config?.actionConfig?.targetOrderStatusId ?? null;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
