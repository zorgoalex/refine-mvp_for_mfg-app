import { describe, expect, it } from 'vitest';
import type {
  OrderAutomationState,
  StatusAutomationConditions,
  StatusAutomationEvent,
  StatusAutomationRule,
} from '../application/status-automation.types';
import {
  evaluateRuleConditions,
  selectApplicableRules,
} from './status-automation-evaluator';

function makeRule(
  overrides: Partial<StatusAutomationRule> = {},
): StatusAutomationRule {
  return {
    id: 1,
    name: 'Test rule',
    eventType: 'order.created',
    actionType: 'change_order_status',
    targetStatusId: 2,
    conditions: {},
    priority: 10,
    isEnabled: true,
    version: 1,
    ...overrides,
  };
}

function makeState(overrides: Partial<OrderAutomationState> = {}): OrderAutomationState {
  return {
    orderId: 100,
    orderStatusId: 1,
    paymentStatusId: 2,
    productionStatusId: 3,
    productionStatusFromDetailsEnabled: false,
    finalAmount: 1000,
    paidAmount: 500,
    source: 'manual',
    version: 1,
    clientId: 10,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<StatusAutomationEvent> = {}): StatusAutomationEvent {
  return {
    eventType: 'order.created',
    origin: 'user',
    orderId: 100,
    actor: {
      id: '1',
      username: 'tester',
      role: 'manager',
      roleId: 10,
      permissions: [],
    },
    requestId: 'request-1',
    ...overrides,
  };
}

describe('evaluateRuleConditions', () => {
  it('matches when conditions are empty', () => {
    expect(evaluateRuleConditions(makeRule(), makeState(), makeEvent())).toEqual({ matched: true });
  });

  it.each([
    {
      name: 'order status',
      conditions: { currentOrderStatusIn: [2, 3] },
      state: { orderStatusId: 5 },
      reason: 'order_status_not_in_list',
    },
    {
      name: 'payment status',
      conditions: { currentPaymentStatusIn: [4, 5] },
      state: { paymentStatusId: 2 },
      reason: 'payment_status_not_in_list',
    },
    {
      name: 'production status',
      conditions: { currentProductionStatusIn: [4, 5] },
      state: { productionStatusId: 3 },
      reason: 'production_status_not_in_list',
    },
  ])('$name list mismatch returns its condition reason', ({ conditions, state, reason }) => {
    expect(evaluateRuleConditions(makeRule({ conditions }), makeState(state), makeEvent())).toEqual({
      matched: false,
      reason,
    });
  });

  it('does not match a production list when production status is null', () => {
    const result = evaluateRuleConditions(
      makeRule({ conditions: { currentProductionStatusIn: [4, 5] } }),
      makeState({ productionStatusId: null }),
      makeEvent(),
    );

    expect(result).toEqual({ matched: false, reason: 'production_status_not_in_list' });
  });

  it.each([
    {
      name: 'order status',
      conditions: { currentOrderStatusNotIn: [1, 7] },
      reason: 'order_status_excluded',
    },
    {
      name: 'payment status',
      conditions: { currentPaymentStatusNotIn: [2, 8] },
      reason: 'payment_status_excluded',
    },
    {
      name: 'production status',
      conditions: { currentProductionStatusNotIn: [3, 9] },
      reason: 'production_status_excluded',
    },
  ])('$name exclusion list mismatch returns its condition reason', ({ conditions, reason }) => {
    expect(evaluateRuleConditions(makeRule({ conditions }), makeState(), makeEvent())).toEqual({
      matched: false,
      reason,
    });
  });

  it('does not match a production exclusion when production status is null', () => {
    const result = evaluateRuleConditions(
      makeRule({ conditions: { currentProductionStatusNotIn: [3, 9] } }),
      makeState({ productionStatusId: null }),
      makeEvent(),
    );

    expect(result).toEqual({ matched: true });
  });

  it('uses the paid-share threshold with a 0.01 tolerance', () => {
    const rule = makeRule({ conditions: { paidShareGte: 50 } });

    expect(
      evaluateRuleConditions(rule, makeState({ finalAmount: 1000, paidAmount: 499.989 }), makeEvent()),
    ).toEqual({ matched: false, reason: 'paid_share_below_threshold' });
    expect(
      evaluateRuleConditions(rule, makeState({ finalAmount: 1000, paidAmount: 499.995 }), makeEvent()),
    ).toEqual({ matched: true });
  });

  it.each([
    { paidShareGte: 0, matched: true },
    { paidShareGte: 50, matched: false },
  ])('handles a zero final amount for paidShareGte=$paidShareGte', ({ paidShareGte, matched }) => {
    const result = evaluateRuleConditions(
      makeRule({ conditions: { paidShareGte } }),
      makeState({ finalAmount: 0, paidAmount: 0 }),
      makeEvent(),
    );

    expect(result.matched).toBe(matched);
    if (!matched) {
      expect(result.reason).toBe('paid_share_below_threshold');
    }
  });

  it('returns the order-source mismatch reason', () => {
    expect(
      evaluateRuleConditions(
        makeRule({ conditions: { orderSourceIn: ['bazis'] } }),
        makeState({ source: 'manual' }),
        makeEvent(),
      ),
    ).toEqual({ matched: false, reason: 'order_source_not_in_list' });
  });

  it('matches the previous order status from the change event', () => {
    const rule = makeRule({
      eventType: 'order.status_changed',
      conditions: { previousOrderStatusIn: [5, 6] },
    });

    expect(evaluateRuleConditions(
      rule,
      makeState(),
      makeEvent({ eventType: 'order.status_changed', orderStatusIdBefore: 5, orderStatusIdAfter: 7 }),
    )).toEqual({ matched: true });
    expect(evaluateRuleConditions(
      rule,
      makeState(),
      makeEvent({ eventType: 'order.status_changed', orderStatusIdBefore: 4, orderStatusIdAfter: 7 }),
    )).toEqual({ matched: false, reason: 'previous_order_status_not_in_list' });
    expect(evaluateRuleConditions(
      rule,
      makeState(),
      makeEvent({ eventType: 'order.status_changed' }),
    )).toEqual({ matched: false, reason: 'previous_order_status_not_in_list' });
  });

  it.each([
    { paymentsCountAfter: 1, matched: true },
    { paymentsCountAfter: 2, matched: false },
    { paymentsCountAfter: undefined, matched: false },
  ])('handles firstPaymentOnly with paymentsCountAfter=$paymentsCountAfter', ({ paymentsCountAfter, matched }) => {
    const result = evaluateRuleConditions(
      makeRule({ conditions: { firstPaymentOnly: true } }),
      makeState(),
      makeEvent({ eventType: 'payment.created', paymentsCountAfter }),
    );

    expect(result.matched).toBe(matched);
    if (!matched) {
      expect(result.reason).toBe('not_first_payment');
    }
  });

  it('does not check empty list conditions', () => {
    const conditions: StatusAutomationConditions = {
      currentOrderStatusIn: [],
      currentOrderStatusNotIn: [],
      previousOrderStatusIn: [],
      currentPaymentStatusIn: [],
      currentPaymentStatusNotIn: [],
      currentProductionStatusIn: [],
      currentProductionStatusNotIn: [],
      orderSourceIn: [],
    };

    expect(evaluateRuleConditions(makeRule({ conditions }), makeState(), makeEvent())).toEqual({
      matched: true,
    });
  });
});

describe('selectApplicableRules', () => {
  it('applies the first matched rule independently for each action type', () => {
    const firstOrderStatusRule = makeRule({ id: 10, priority: 10 });
    const lowerOrderStatusRule = makeRule({ id: 20, priority: 20 });
    const productionRule = makeRule({
      id: 30,
      priority: 30,
      actionType: 'change_production_status',
    });

    expect(selectApplicableRules(
      [firstOrderStatusRule, lowerOrderStatusRule, productionRule],
      makeState(),
      makeEvent(),
    )).toEqual({
      applied: [firstOrderStatusRule, productionRule],
      skipped: [{ ruleId: 20, reason: 'lower_priority_same_target' }],
    });
  });

  it('skips unmatched rules with the condition reason', () => {
    const rule = makeRule({
      id: 40,
      conditions: { currentOrderStatusIn: [99] },
    });

    expect(selectApplicableRules([rule], makeState(), makeEvent())).toEqual({
      applied: [],
      skipped: [{ ruleId: 40, reason: 'order_status_not_in_list' }],
    });
  });
});
