import type {
  OrderAutomationState,
  StatusAutomationActionType,
  StatusAutomationEvent,
  StatusAutomationRule,
} from '../application/status-automation.types';

export interface RuleEvaluationResult {
  applied: StatusAutomationRule[];
  skipped: Array<{ ruleId: number; reason: string }>;
}

interface ConditionEvaluationResult {
  matched: boolean;
  reason?: string;
}

function failed(reason: string): ConditionEvaluationResult {
  return { matched: false, reason };
}

export function evaluateRuleConditions(
  rule: StatusAutomationRule,
  state: OrderAutomationState,
  event: StatusAutomationEvent,
): ConditionEvaluationResult {
  const conditions = rule.conditions;

  if (
    conditions.currentOrderStatusIn !== undefined &&
    conditions.currentOrderStatusIn.length > 0 &&
    !conditions.currentOrderStatusIn.includes(state.orderStatusId)
  ) {
    return failed('order_status_not_in_list');
  }

  if (
    conditions.currentOrderStatusNotIn !== undefined &&
    conditions.currentOrderStatusNotIn.length > 0 &&
    conditions.currentOrderStatusNotIn.includes(state.orderStatusId)
  ) {
    return failed('order_status_excluded');
  }

  if (
    conditions.currentPaymentStatusIn !== undefined &&
    conditions.currentPaymentStatusIn.length > 0 &&
    !conditions.currentPaymentStatusIn.includes(state.paymentStatusId)
  ) {
    return failed('payment_status_not_in_list');
  }

  if (
    conditions.currentPaymentStatusNotIn !== undefined &&
    conditions.currentPaymentStatusNotIn.length > 0 &&
    conditions.currentPaymentStatusNotIn.includes(state.paymentStatusId)
  ) {
    return failed('payment_status_excluded');
  }

  if (
    conditions.currentProductionStatusIn !== undefined &&
    conditions.currentProductionStatusIn.length > 0 &&
    (state.productionStatusId === null ||
      !conditions.currentProductionStatusIn.includes(state.productionStatusId))
  ) {
    return failed('production_status_not_in_list');
  }

  if (
    conditions.currentProductionStatusNotIn !== undefined &&
    conditions.currentProductionStatusNotIn.length > 0 &&
    state.productionStatusId !== null &&
    conditions.currentProductionStatusNotIn.includes(state.productionStatusId)
  ) {
    return failed('production_status_excluded');
  }

  if (conditions.paidShareGte !== undefined) {
    if (
      state.finalAmount === 0
        ? conditions.paidShareGte !== 0
        : state.paidAmount + 0.01 < state.finalAmount * conditions.paidShareGte / 100
    ) {
      return failed('paid_share_below_threshold');
    }
  }

  if (
    conditions.orderSourceIn !== undefined &&
    conditions.orderSourceIn.length > 0 &&
    !conditions.orderSourceIn.includes(state.source)
  ) {
    return failed('order_source_not_in_list');
  }

  if (conditions.firstPaymentOnly === true && event.paymentsCountAfter !== 1) {
    return failed('not_first_payment');
  }

  return { matched: true };
}

export function selectApplicableRules(
  rules: StatusAutomationRule[],
  state: OrderAutomationState,
  event: StatusAutomationEvent,
): RuleEvaluationResult {
  const applied: StatusAutomationRule[] = [];
  const skipped: Array<{ ruleId: number; reason: string }> = [];
  const appliedActionTypes = new Set<StatusAutomationActionType>();

  for (const rule of rules) {
    const evaluation = evaluateRuleConditions(rule, state, event);
    if (!evaluation.matched) {
      skipped.push({
        ruleId: rule.id,
        reason: evaluation.reason ?? 'condition_not_matched',
      });
      continue;
    }

    if (appliedActionTypes.has(rule.actionType)) {
      skipped.push({ ruleId: rule.id, reason: 'lower_priority_same_target' });
      continue;
    }

    applied.push(rule);
    appliedActionTypes.add(rule.actionType);
  }

  return { applied, skipped };
}
