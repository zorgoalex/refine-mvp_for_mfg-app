import { auditService } from '../../../common/audit/audit.service';
import type { TransactionClient } from '../../../database/database.types';
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
  loadOrderAutomationState,
} from '../adapters/pg-status-automation-repository';
import {
  selectApplicableRules,
} from '../domain/status-automation-evaluator';
import type {
  StatusAutomationEvent,
  StatusAutomationRule,
} from './status-automation.types';

const MEANINGFUL_SKIP_REASONS = new Set([
  'same_status',
  'auto_mode_from_details',
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

function buildOutboxIdempotencyKey(
  event: StatusAutomationEvent,
  rule: StatusAutomationRule,
): string {
  const baseKey = event.sourceIdempotencyKey ?? `req-${event.requestId}`;
  return `${baseKey}:automation-${rule.id}`;
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
    },
  });
}
