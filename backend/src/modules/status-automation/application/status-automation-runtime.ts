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
]);

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
  if (event.origin === 'automation') {
    return;
  }

  const rules = await listEnabledRulesForEvent(tx, event.eventType);
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

    let result: AutomationActionResult;
    try {
      result = await runAutomationAction(tx, event.orderId, rule, context);
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

    let result: AutomationActionResult;
    try {
      result = await runAutomationAction(tx, input.orderId, rule, context);
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
  rule: StatusAutomationRule,
  context: AutomationActionContext,
): Promise<AutomationActionResult> {
  switch (rule.actionType) {
    case 'change_order_status':
      return changeOrderStatusFromAutomationInTransaction(
        tx,
        orderId,
        rule.targetStatusId,
        context,
      );
    case 'change_production_status':
      return changeProductionStatusFromAutomationInTransaction(
        tx,
        orderId,
        rule.targetStatusId,
        context,
      );
    case 'change_details_production_status':
      return changeDetailsProductionStatusFromAutomationInTransaction(
        tx,
        orderId,
        rule.targetStatusId,
        context,
      );
  }
}

async function recordRuleApplied(
  tx: TransactionClient,
  event: StatusAutomationEvent,
  rule: StatusAutomationRule,
  result: AutomationActionResult,
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
      targetStatusId: rule.targetStatusId,
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
