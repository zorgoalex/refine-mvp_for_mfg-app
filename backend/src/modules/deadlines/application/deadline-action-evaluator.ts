import { createHash } from 'node:crypto';
import type {
  DeadlineActionRuleConfigDto,
  DeadlineActionRuleDto,
  DeadlineOrderOverrideDto,
  DeadlineRuleConfigSnapshotDto,
} from '../dto/deadline-action-rule.dto';
import type { DeadlineActionType } from '../domain/deadline-actions';
import type { DeadlineEventType } from '../domain/deadline-events';
import type { OrderDeadlineEvaluationContext } from './deadline.types';

export interface DeadlineActionRuleEvaluationCandidate {
  actionRuleId: string;
  priority: number;
  actionType: DeadlineActionType;
  rule: DeadlineActionRuleDto;
  effectiveConfig: DeadlineActionRuleConfigDto | null | undefined;
  wouldRun: boolean;
  skipReason: string | null;
  targetStatusId: number | null;
  overrideId: string | null;
  ruleSnapshot: DeadlineRuleConfigSnapshotDto;
  idempotencyMaterial: DeadlineActionRuleIdempotencyMaterial;
  orderContext: OrderDeadlineEvaluationContext | null;
}

export interface DeadlineActionRuleIdempotencyMaterial {
  deadlineEventId: string;
  actionType: DeadlineActionType;
  actionRuleId: string;
  orderId: number | null;
  targetStatusId: number | null;
  snapshotHash: string;
}

export interface DeadlineActionRuleEvaluationResult {
  candidates: DeadlineActionRuleEvaluationCandidate[];
  selectedActionRuleId: string | null;
  selectionReason: 'first_applicable_rule' | 'no_applicable_rules';
}

export interface EvaluateDeadlineActionRulesInput {
  eventType: DeadlineEventType;
  deadlineEventId: string;
  deadlineId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  orderContext?: OrderDeadlineEvaluationContext | null;
  orderContextUnavailable?: boolean;
  isCurrentDeadlineEvent: boolean;
  actionsEnabled?: boolean;
  rules: DeadlineActionRuleDto[];
  overrides: DeadlineOrderOverrideDto[];
}

export function evaluateDeadlineActionRules(
  input: EvaluateDeadlineActionRulesInput,
): DeadlineActionRuleEvaluationResult {
  const overrideByActionRuleId = buildActionRuleOverrideMap(input.overrides);
  let selectedActionRuleId: string | null = null;

  const candidates = sortActionRules(input.rules).map((rule) => {
    const override = overrideByActionRuleId.get(rule.actionRuleId) ?? null;
    const effectiveConfig = mergeRuleOverrideConfig(rule.config, override);
    const effectiveRule = { ...rule, config: effectiveConfig };
    const targetStatusId = effectiveConfig?.actionConfig?.targetOrderStatusId ?? null;
    let skipReason = getRuleSkipReason({
      actionsEnabled: input.actionsEnabled ?? true,
      eventType: input.eventType,
      rule: effectiveRule,
      override,
      orderContext: input.orderContext ?? null,
      orderContextUnavailable: input.orderContextUnavailable ?? false,
      targetStatusId,
      isCurrentDeadlineEvent: input.isCurrentDeadlineEvent,
    });

    if (!skipReason && rule.actionType === 'change_order_status' && selectedActionRuleId) {
      skipReason = 'lower_priority_rule_not_selected';
    }

    const wouldRun = !skipReason;
    if (wouldRun && rule.actionType === 'change_order_status') {
      selectedActionRuleId = rule.actionRuleId;
    }

    const ruleSnapshot = buildRuleConfigSnapshot(effectiveRule);

    return {
      actionRuleId: rule.actionRuleId,
      priority: rule.priority,
      actionType: rule.actionType,
      rule: effectiveRule,
      effectiveConfig,
      wouldRun,
      skipReason,
      targetStatusId,
      overrideId: override?.overrideId ?? null,
      ruleSnapshot,
      idempotencyMaterial: {
        deadlineEventId: input.deadlineEventId,
        actionType: rule.actionType,
        actionRuleId: rule.actionRuleId,
        orderId: input.orderContext?.orderId ?? null,
        targetStatusId,
        snapshotHash: ruleSnapshot.snapshotHash,
      },
      orderContext: input.orderContext ?? null,
    };
  });

  return {
    candidates,
    selectedActionRuleId,
    selectionReason: selectedActionRuleId ? 'first_applicable_rule' : 'no_applicable_rules',
  };
}

export function sortActionRules(rules: DeadlineActionRuleDto[]): DeadlineActionRuleDto[] {
  return [...rules].sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }

    const createdAtCompare = left.createdAt.localeCompare(right.createdAt);
    if (createdAtCompare !== 0) {
      return createdAtCompare;
    }

    return left.actionRuleId.localeCompare(right.actionRuleId);
  });
}

export function filterActionRulesForFixture(
  rules: DeadlineActionRuleDto[],
  fixtureKey?: string | null,
): DeadlineActionRuleDto[] {
  return sortActionRules(rules).filter((rule) => actionRuleMatchesFixture(rule, fixtureKey));
}

export function mergeRuleOverrideConfig(
  ruleConfig: DeadlineActionRuleConfigDto | null | undefined,
  override: DeadlineOrderOverrideDto | null,
): DeadlineActionRuleConfigDto | null | undefined {
  if (!override?.overrideConfig) {
    return ruleConfig;
  }

  return {
    ...(ruleConfig ?? {}),
    conditions: {
      ...(ruleConfig?.conditions ?? {}),
      ...(override.overrideConfig.conditions ?? {}),
    },
    actionConfig: {
      ...(ruleConfig?.actionConfig ?? {}),
      ...(override.overrideConfig.actionConfig ?? {}),
    },
  };
}

export function buildRuleConfigSnapshot(rule: DeadlineActionRuleDto): DeadlineRuleConfigSnapshotDto {
  const snapshotWithoutHash = {
    actionRuleId: rule.actionRuleId,
    priority: rule.priority,
    eventType: rule.eventType,
    actionType: rule.actionType,
    conditions: rule.config?.conditions ?? {},
    actionConfig: rule.config?.actionConfig ?? {},
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };

  return {
    ...snapshotWithoutHash,
    snapshotHash: `sha256:${createHash('sha256')
      .update(stableStringify(snapshotWithoutHash))
      .digest('hex')}`,
  };
}

function actionRuleMatchesFixture(
  rule: DeadlineActionRuleDto,
  fixtureKey?: string | null,
): boolean {
  const ruleFixtureKey = rule.config?.fixtureKey;
  if (typeof ruleFixtureKey !== 'string' || ruleFixtureKey.trim() === '') {
    return true;
  }

  return fixtureKey === ruleFixtureKey;
}

function buildActionRuleOverrideMap(overrides: DeadlineOrderOverrideDto[]): Map<string, DeadlineOrderOverrideDto> {
  return new Map(
    overrides
      .filter((override) => override.actionRuleId)
      .map((override) => [override.actionRuleId as string, override]),
  );
}

function getRuleSkipReason(input: {
  actionsEnabled: boolean;
  eventType: DeadlineEventType;
  rule: DeadlineActionRuleDto;
  override: DeadlineOrderOverrideDto | null;
  orderContext: OrderDeadlineEvaluationContext | null;
  orderContextUnavailable: boolean;
  targetStatusId: number | null;
  isCurrentDeadlineEvent: boolean;
}): string | null {
  if (!input.actionsEnabled) {
    return 'global_actions_disabled';
  }
  if (input.rule.eventType !== input.eventType) {
    return 'unsupported_event_type';
  }
  if (!input.rule.isEnabled) {
    return 'action_disabled';
  }
  if (input.override?.isDisabled) {
    return 'order_override_disabled';
  }
  if (input.rule.actionType !== 'change_order_status') {
    return null;
  }
  if (!input.orderContext) {
    if (input.orderContextUnavailable) {
      return 'stale_deadline_event';
    }
    return 'missing_order_id';
  }
  if (!input.targetStatusId) {
    return 'missing_target_status';
  }

  const allowedFrom = input.rule.config?.conditions?.allowedFromOrderStatusIds ?? [];
  if (allowedFrom.length === 0) {
    return 'missing_allowed_from_statuses';
  }

  const excluded = input.rule.config?.conditions?.excludeOrderStatusIds ?? [];
  if (excluded.includes(input.orderContext.orderStatusId) || excluded.includes(input.targetStatusId)) {
    return 'disallowed_from_status';
  }
  if (!allowedFrom.includes(input.orderContext.orderStatusId)) {
    return 'disallowed_from_status';
  }
  if (input.orderContext.isCompleted) {
    return 'terminal_order_status';
  }
  const requireCurrentDeadlineEvent = input.rule.config?.conditions?.requireCurrentDeadlineEvent ?? true;
  if (requireCurrentDeadlineEvent && !input.isCurrentDeadlineEvent) {
    return 'stale_deadline_event';
  }

  return null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
