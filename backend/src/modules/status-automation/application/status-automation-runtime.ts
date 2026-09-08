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
import { loadMdfBoardEvents } from '../adapters/pg-mdf-board-event-repository';
import { isMdfBoardEvent, type MdfBoardDetailScope, type MdfBoardEventInput } from './mdf-board-event.types';
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

export interface MdfOrderMachineFilesPresentAutomationInput extends MdfBoardEventInput {
  /** Legacy audit hint only. Membership is always resolved from source. */
  orderIds?: Iterable<number | null | undefined>;
}

export interface MdfBoardColumnAutomationInput extends MdfBoardEventInput {
  eventType: Extract<
    StatusAutomationEvent['eventType'],
    'mdf.board.completed' | 'mdf.board.baths' | 'mdf.board.baths_ready' | 'mdf.board.baths_laminated'
  >;
  orderIds?: Iterable<number | null | undefined>;
}

// Only the server resolver can attach a scope. A generic event cannot opt into
// an all-order MDF action by supplying an event name or fabricated detail IDs.
const mdfScopes = new WeakMap<StatusAutomationEvent, MdfBoardDetailScope>();

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
  const mdfScope = mdfScopes.get(event);
  if (isMdfBoardEvent(event.eventType) && !mdfScope) return;
  const allRules = await listEnabledRulesForEvent(tx, event.eventType);
  // Automation-originated order status changes still need their downstream detail cascade.
  // Restrict that second hop to detail-only actions so status rules cannot recurse in cycles.
  const compatibleRules = mdfScope ? allRules.filter(rule => rule.actionType === 'change_details_production_status') : allRules;
  if (mdfScope) for (const rule of allRules) {
    if (rule.actionType !== 'change_details_production_status') await recordRuleSkipped(tx, event, rule, 'mdf_detail_action_required');
  }
  const rules = event.origin === 'automation'
    ? compatibleRules.filter((rule) =>
      rule.actionType === 'change_details_production_status'
      || rule.actionType === 'map_order_status_to_details_production_status')
    : compatibleRules;
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
      ...(mdfScope ? { mdfBoardScope: mdfScope } : {}),
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
    if (isMdfBoardEvent(rule.eventType)) {
      summary.skippedRuleCount += 1;
      await recordRuleSkipped(tx, event, rule, 'mdf_source_required');
      continue;
    }
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
  await dispatchMdfBoardEvent(tx, input);
}

export async function evaluateMdfBoardColumnAutomation(
  tx: TransactionClient,
  input: MdfBoardColumnAutomationInput,
): Promise<void> {
  await dispatchMdfBoardEvent(tx, input);
}

/** Single internal API for all five MDF events. Never called from board GET. */
export async function dispatchMdfBoardEvent(tx: TransactionClient, input: MdfBoardEventInput): Promise<void> {
  if (!isStatusAutomationEnabled() || !input.source) return;
  const rules = (await listEnabledRulesForManualRefresh(tx)).filter(rule => isMdfBoardEvent(rule.eventType));
  if (!rules.length) return;
  const initial = await loadMdfBoardEvents(tx, input.source);
  const resolved = initial.filter(e => e.scope.source.kind === input.source.kind && e.scope.source.id === input.source.id);
  // Resolve impacted mixed-order baths in their own full context, before any
  // status writes. This avoids circular evidence from earlier rules in the batch.
  const baths = new Set(initial.filter(e => e.scope.source.kind === 'bath'
    && !(input.source.kind === 'bath' && e.scope.source.id === input.source.id)).map(e => e.scope.source.id));
  for (const id of baths) resolved.push(...await loadMdfBoardEvents(tx, { kind: 'bath', id }));
  for (const entry of resolved) {
    if (!rules.some(rule => rule.eventType === entry.eventType)) continue;
    const eligible = entry.scope.details.filter(d => d.requiredQuantity > 0 && d.eligibleQuantity >= d.requiredQuantity);
    const event: StatusAutomationEvent = {
      eventType: entry.eventType, origin: 'user', orderId: entry.orderId,
      actor: input.actor, requestId: input.requestId,
      sourceIdempotencyKey: `${input.sourceIdempotencyKey}:${entry.scope.source.kind}:${entry.scope.source.id}:${entry.eventType}:order-${entry.orderId}`,
    };
    mdfScopes.set(event, entry.scope);
    if (!eligible.length) {
      for (const rule of rules.filter(r => r.eventType === event.eventType)) {
        await recordRuleSkipped(tx, event, rule, 'mdf_quantity_incomplete');
      }
      continue;
    }
    await evaluateStatusAutomation(tx, event);
  }
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
          context.mdfBoardScope ? 'advance_only' : rule.actionConfig?.detailTransitionMode ?? 'set_exact',
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
      ...(mdfScopes.has(event) ? { mdfBoardScope: mdfScopes.get(event), sourceIdempotencyKey: event.sourceIdempotencyKey } : {}),
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
      ...(mdfScopes.has(event) ? { mdfBoardScope: mdfScopes.get(event), sourceIdempotencyKey: event.sourceIdempotencyKey } : {}),
      plannedCompletionDateBefore: event.plannedCompletionDateBefore ?? null,
      plannedCompletionDateAfter: event.plannedCompletionDateAfter ?? null,
    },
  });
}
