import { describe, expect, it } from 'vitest';
import { evaluateRuleConditions } from './notification-condition-evaluator';

const ctx = { orderStatusId: 30, isOrderCompleted: false } as any;

describe('evaluateRuleConditions', () => {
  it('passes when no conditions', () => {
    expect(evaluateRuleConditions({}, ctx)).toEqual({ matched: true });
  });
  it('excludes completed orders', () => {
    expect(evaluateRuleConditions({ excludeCompletedOrders: true }, { ...ctx, isOrderCompleted: true }))
      .toEqual({ matched: false, skipReason: 'order_completed' });
  });
  it('honors allowedFromOrderStatusIds', () => {
    expect(evaluateRuleConditions({ allowedFromOrderStatusIds: [40, 50] }, ctx))
      .toEqual({ matched: false, skipReason: 'status_not_allowed' });
    expect(evaluateRuleConditions({ allowedFromOrderStatusIds: [30] }, ctx)).toEqual({ matched: true });
  });
  it('honors excludeOrderStatusIds', () => {
    expect(evaluateRuleConditions({ excludeOrderStatusIds: [30] }, ctx))
      .toEqual({ matched: false, skipReason: 'status_excluded' });
  });
});
