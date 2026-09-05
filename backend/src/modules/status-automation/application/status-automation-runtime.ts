import { auditService } from '../../../common/audit/audit.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  changeDetailsProductionStatusFromAutomationInTransaction,
  changeOrderStatusFromAutomationInTransaction,
  changeProductionStatusFromAutomationInTransaction,
  type AutomationActionContext,
  type AutomationActionResult,
} from '../../production-actions/adapters/pg-production-action-repository';
import { ProductionActionStatusNotFoundError } from '../../production-actions/errors/production-action.errors';
import {
  listEnabledRulesForEvent,
  listEnabledRulesForManualRefresh,
  loadOrderAutomationState,
} from '../adapters/pg-status-automation-repository';
import {
  evaluateRuleConditions,
  selectApplicableRules,
} from '../domain/status-automation-evaluator';
import type {
  OrderAutomationState,
  StatusAutomationEvent,
  StatusAutomationEventType,
  StatusAutomationRule,
} from './status-automation.types';

export interface MdfOrderMachineFilesPresentAutomationInput {
  orderIds: Iterable<number | null | undefined>;
  actor: CurrentUser;
  requestId: string;
  sourceIdempotencyKey: string;
}

export interface MdfBoardColumnAutomationInput {
  eventType: Extract<
    StatusAutomationEvent['eventType'],
    'mdf.board.completed' | 'mdf.board.baths' | 'mdf.board.baths_ready' | 'mdf.board.baths_laminated'
  >;
  orderIds: Iterable<number | null | undefined>;
  actor: CurrentUser;
  requestId: string;
  sourceIdempotencyKey: string;
}

export interface ManualStatusAutomationOrderRefreshInput {
  orderId: number;
  actor: CurrentUser;
  requestId: string;
  sourceIdempotencyKey: string;
}

export interface StatusAutomationOrderRefreshSummary {
  orderId: number;
  orderFound: boolean;
  evaluatedRuleCount: number;
  matchedRuleCount: number;
  executedActionCount: number;
  skippedRuleCount: number;
  skippedActionCount: number;
}

const MEANINGFUL_SKIP_REASONS = new Set([
  'same_status',
  'target_status_missing',
  'no_details',
  'lower_priority_same_target',
  'mapping_source_status_missing',
]);

interface StatusAutomationActionRunResult extends AutomationActionResult {
  resolvedTargetStatusId: number | null;
  mappingSourceStatusId?: number;
  mappingDirection?: 'order_to_details' | 'production_to_order';
}

export function isStatusAutomationEnabled(): boolean {
  return process.env.BACKEND_STATUS_AUTOMATION === 'true';
}

export async function evaluateStatusAutomation(
  tx: TransactionClient,
  event: StatusAutomationEvent,
): Promise<void> {
  if (!isStatusAutomationEnabled()) {
    return;
  }
  const allRules = await listEnabledRulesForEvent(tx, event.eventType);
  // Automation-originated order status changes still need their downstream detail cascade.
  // Restrict that second hop to detail-only actions so status rules cannot recurse in cycles.
  const rules = event.origin === 'automation'
    ? allRules.filter((rule) =>
      rule.actionType === 'change_details_production_status'
      || rule.actionType === 'map_order_status_to_details_production_status')
    : allRules;
  if (rules.length === 0) {
    return;
  }

  const state = await loadOrderAutomationState(tx, event.orderId);
  if (state === null) {
    return;
  }

  const { applied, skipped } = selectApplicableRules(rules, state, event);
  for (const rule of applied) {
    const outboxIdempotencyKey = buildOutboxIdempotencyKey(event, rule);
    const context: AutomationActionContext = {
      actor: event.actor,
      requestId: event.requestId,
      ruleId: rule.id,
      ruleName: rule.name,
      eventType: event.eventType,
      outboxIdempotencyKey,
    };

    let result: StatusAutomationActionRunResult;
    try {
      result = await runAutomationAction(tx, event.orderId, state, rule, context);
    } catch (error: unknown) {
      if (!(error instanceof ProductionActionStatusNotFoundError)) {
        throw error;
      }
      await recordRuleSkipped(tx, event, rule, 'target_status_missing');
      continue;
    }

    if (result.status === 'executed') {
      await recordRuleApplied(tx, event, rule, result);
    } else if (result.skipReason !== undefined && MEANINGFUL_SKIP_REASONS.has(result.skipReason)) {
      await recordRuleSkipped(tx, event, rule, result.skipReason);
    }
  }

  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  for (const skippedRule of skipped) {
    if (!MEANINGFUL_SKIP_REASONS.has(skippedRule.reason)) {
      continue;
    }
    const rule = rulesById.get(skippedRule.ruleId);
    if (rule !== undefined) {
      await recordRuleSkipped(tx, event, rule, skippedRule.reason);
    }
  }
}

export async function evaluateAllStatusAutomationRulesForOrder(
  tx: TransactionClient,
  input: ManualStatusAutomationOrderRefreshInput,
): Promise<StatusAutomationOrderRefreshSummary> {
  const state = await loadOrderAutomationState(tx, input.orderId);
  if (state === null) {
    return emptyOrderRefreshSummary(input.orderId, false);
  }

  const rules = await listEnabledRulesForManualRefresh(tx);
  const summary = emptyOrderRefreshSummary(input.orderId, true);
  summary.evaluatedRuleCount = rules.length;
  if (rules.length === 0) {
    return summary;
  }

  const appliedActionTypes = new Set<string>();
  for (const rule of rules) {
    const event = manualRefreshEventForRule(input, rule.eventType);
    const evaluation = evaluateRuleConditions(rule, state, event);
    if (!evaluation.matched) {
      summary.skippedRuleCount += 1;
      continue;
    }

    if (appliedActionTypes.has(rule.actionType)) {
      summary.skippedRuleCount += 1;
      await recordRuleSkipped(tx, event, rule, 'lower_priority_same_target');
      continue;
    }

    appliedActionTypes.add(rule.actionType);
    summary.matchedRuleCount += 1;
    const outboxIdempotencyKey = buildOutboxIdempotencyKey(event, rule);
    const context: AutomationActionContext = {
      actor: input.actor,
      requestId: input.requestId,
      ruleId: rule.id,
      ruleName: rule.name,
      eventType: rule.eventType,
      outboxIdempotencyKey,
    };

    let result: StatusAutomationActionRunResult;
    try {
      result = await runAutomationAction(tx, input.orderId, state, rule, context);
    } catch (error: unknown) {
      if (!(error instanceof ProductionActionStatusNotFoundError)) {
        throw error;
      }
      summary.skippedActionCount += 1;
      await recordRuleSkipped(tx, event, rule, 'target_status_missing');
      continue;
    }

    if (result.status === 'executed') {
      summary.executedActionCount += 1;
      await recordRuleApplied(tx, event, rule, result);
    } else {
      summary.skippedActionCount += 1;
      if (result.skipReason !== undefined && MEANINGFUL_SKIP_REASONS.has(result.skipReason)) {
        await recordRuleSkipped(tx, event, rule, result.skipReason);
      }
    }
  }

  return summary;
}

export async function evaluateMdfOrderMachineFilesPresentAutomation(
  tx: TransactionClient,
  input: MdfOrderMachineFilesPresentAutomationInput,
): Promise<void> {
  const orderIds = normalizeAutomationOrderIds(input.orderIds);
  for (const orderId of orderIds) {
    await evaluateStatusAutomation(tx, {
      eventType: 'mdf.order_machine_files_present',
      origin: 'user',
      orderId,
      actor: input.actor,
      requestId: input.requestId,
      sourceIdempotencyKey: `${input.sourceIdempotencyKey}:order-${orderId}`,
    });
  }
}

export async function evaluateMdfBoardColumnAutomation(
  tx: TransactionClient,
  input: MdfBoardColumnAutomationInput,
): Promise<void> {
  const orderIds = normalizeAutomationOrderIds(input.orderIds);
  for (const orderId of orderIds) {
    await evaluateStatusAutomation(tx, {
      eventType: input.eventType,
      origin: 'user',
      orderId,
      actor: input.actor,
      requestId: input.requestId,
      sourceIdempotencyKey: `${input.sourceIdempotencyKey}:order-${orderId}`,
    });
  }
}

function normalizeAutomationOrderIds(
  values: Iterable<number | null | undefined>,
): number[] {
  const ids = new Set<number>();
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      ids.add(value);
    }
  }
  return Array.from(ids).sort((left, right) => left - right);
}

function emptyOrderRefreshSummary(
  orderId: number,
  orderFound: boolean,
): StatusAutomationOrderRefreshSummary {
  return {
    orderId,
    orderFound,
    evaluatedRuleCount: 0,
    matchedRuleCount: 0,
    executedActionCount: 0,
    skippedRuleCount: 0,
    skippedActionCount: 0,
  };
}

function manualRefreshEventForRule(
  input: ManualStatusAutomationOrderRefreshInput,
  eventType: StatusAutomationEventType,
): StatusAutomationEvent {
  return {
    eventType,
    origin: 'user',
    orderId: input.orderId,
    actor: input.actor,
    requestId: input.requestId,
    sourceIdempotencyKey: `${input.sourceIdempotencyKey}:manual-${eventType}:order-${input.orderId}`,
  };
}

function buildOutboxIdempotencyKey(
  event: StatusAutomationEvent,
  rule: StatusAutomationRule,
): string {
  const baseKey = event.sourceIdempotencyKey ?? `req-${event.requestId}`;
  // orderId в ключе обязателен: перенос платежа гоняет автоматику для ДВУХ
  // заказов с одним requestId — без orderId второй outbox дропается ON CONFLICT.
  return `${baseKey}:automation-${rule.id}:order-${event.orderId}`;
}

async function runAutomationAction(
  tx: TransactionClient,
  orderId: number,
  state: OrderAutomationState,
  rule: StatusAutomationRule,
  context: AutomationActionContext,
): Promise<StatusAutomationActionRunResult> {
  const run = async (
    targetStatusId: number,
    action: () => Promise<AutomationActionResult>,
    mapping?: Pick<StatusAutomationActionRunResult, 'mappingSourceStatusId' | 'mappingDirection'>,
  ): Promise<StatusAutomationActionRunResult> => ({
    ...(await action()),
    resolvedTargetStatusId: targetStatusId,
    ...mapping,
  });

  switch (rule.actionType) {
    case 'change_order_status':
      return run(requireTargetStatusId(rule), () =>
        changeOrderStatusFromAutomationInTransaction(tx, orderId, requireTargetStatusId(rule), context),
      );
    case 'change_production_status':
      return run(requireTargetStatusId(rule), () =>
        changeProductionStatusFromAutomationInTransaction(tx, orderId, requireTargetStatusId(rule), context),
      );
    case 'change_details_production_status':
      return run(requireTargetStatusId(rule), () =>
        changeDetailsProductionStatusFromAutomationInTransaction(
          tx,
          orderId,
          requireTargetStatusId(rule),
          context,
          rule.actionConfig?.detailTransitionMode ?? 'set_exact',
        ),
      );
    case 'map_order_status_to_details_production_status': {
      const targetStatusId = resolveMappedStatusId(rule, state.orderStatusId);
      if (targetStatusId === null) {
        return { status: 'skipped', skipReason: 'mapping_source_status_missing', resolvedTargetStatusId: null };
      }
      return run(
        targetStatusId,
        () => changeDetailsProductionStatusFromAutomationInTransaction(tx, orderId, targetStatusId, context),
        { mappingSourceStatusId: state.orderStatusId, mappingDirection: 'order_to_details' },
      );
    }
    case 'map_production_status_to_order_status': {
      if (state.productionStatusId === null) {
        return { status: 'skipped', skipReason: 'mapping_source_status_missing', resolvedTargetStatusId: null };
      }
      const targetStatusId = resolveMappedStatusId(rule, state.productionStatusId);
      if (targetStatusId === null) {
        return { status: 'skipped', skipReason: 'mapping_source_status_missing', resolvedTargetStatusId: null };
      }
      return run(
        targetStatusId,
        () => changeOrderStatusFromAutomationInTransaction(tx, orderId, targetStatusId, context),
        { mappingSourceStatusId: state.productionStatusId, mappingDirection: 'production_to_order' },
      );
    }
  }
}

function requireTargetStatusId(rule: StatusAutomationRule): number {
  if (rule.targetStatusId === null) {
    throw new Error(`Rule ${rule.id} has no target status`);
  }
  return rule.targetStatusId;
}

function resolveMappedStatusId(rule: StatusAutomationRule, sourceStatusId: number): number | null {
  return rule.actionConfig?.statusMapping?.entries.find((entry) =>
    entry.sourceStatusIds.includes(sourceStatusId),
  )?.targetStatusId ?? null;
}

async function recordRuleApplied(
  tx: TransactionClient,
  event: StatusAutomationEvent,
  rule: StatusAutomationRule,
  result: StatusAutomationActionRunResult,
): Promise<void> {
  await auditService.record(tx, {
    event: 'status_automation.rule_applied',
    entityType: 'status_automation_rule',
    entityId: rule.id,
    actorUserId: event.actor.id,
    actorUsername: event.actor.username,
    actorRole: event.actor.role,
    requestId: event.requestId,
    source: 'backend-status-automation',
    relatedOrderId: event.orderId,
    metadata: {
      eventType: event.eventType,
      actionType: rule.actionType,
      targetStatusId: result.resolvedTargetStatusId,
      ...(result.mappingDirection ? {
        configuredTargetStatusId: rule.targetStatusId,
        mappingSourceStatusId: result.mappingSourceStatusId ?? null,
        mappingDirection: result.mappingDirection,
      } : {}),
      ruleName: rule.name,
      statusCommandAuditId: result.auditId ?? null,
      paymentStatusIdBefore: event.paymentStatusIdBefore ?? null,
      paymentStatusIdAfter: event.paymentStatusIdAfter ?? null,
      plannedCompletionDateBefore: event.plannedCompletionDateBefore ?? null,
      plannedCompletionDateAfter: event.plannedCompletionDateAfter ?? null,
    },
  });
}

async function recordRuleSkipped(
  tx: TransactionClient,
  event: StatusAutomationEvent,
  rule: StatusAutomationRule,
  reason: string,
): Promise<void> {
  await auditService.record(tx, {
    event: 'status_automation.rule_skipped',
    entityType: 'status_automation_rule',
    entityId: rule.id,
    actorUserId: event.actor.id,
    actorUsername: event.actor.username,
    actorRole: event.actor.role,
    requestId: event.requestId,
    source: 'backend-status-automation',
    relatedOrderId: event.orderId,
    metadata: {
      eventType: event.eventType,
      actionType: rule.actionType,
      targetStatusId: rule.targetStatusId,
      ruleName: rule.name,
      reason,
      plannedCompletionDateBefore: event.plannedCompletionDateBefore ?? null,
      plannedCompletionDateAfter: event.plannedCompletionDateAfter ?? null,
    },
  });
}
