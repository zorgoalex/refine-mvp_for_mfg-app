import { describe, expect, it } from 'vitest';
import type { OrderAutomationState, StatusAutomationEvent, StatusAutomationRule } from '../application/status-automation.types';
import { evaluateRuleConditions } from './status-automation-evaluator';

const event: StatusAutomationEvent = {
  eventType: 'order.production_status_changed', origin: 'user', orderId: 1,
  actor: { id: '1', username: 'e2e_test', role: 'admin', roleId: 1, permissions: [] },
  requestId: 'e2e-composition',
};
const rule: StatusAutomationRule = {
  id: 1, name: 'Тест: все детали закатаны', eventType: event.eventType,
  actionType: 'change_order_status', targetStatusId: 4,
  conditions: { currentProductionStatusIn: [6, 7] }, priority: 1, isEnabled: true, version: 1,
};
const base: OrderAutomationState = {
  orderId: 1, orderStatusId: 4, paymentStatusId: 1, productionStatusId: 6,
  productionStatusFromDetailsEnabled: true, finalAmount: 0, paidAmount: 0,
  source: 'manual', version: 1, clientId: 1,
};

describe('production automation checks complete composition, never the header minimum', () => {
  it.each([
    { name: 'one detail without status', detailCount: 2, unassignedCount: 1, statusIds: [6] },
    { name: 'mixed stages both listed in the rule', detailCount: 2, unassignedCount: 0, statusIds: [6, 7] },
    { name: 'all unassigned with stale header', detailCount: 2, unassignedCount: 2, statusIds: [] },
    { name: 'empty order with stale header', detailCount: 0, unassignedCount: 0, statusIds: [] },
  ])('rejects $name', ({ name: _name, ...productionSummary }) => {
    const state = { ...base, productionSummary };
    expect(evaluateRuleConditions(rule, state, event).matched).toBe(false);
  });

  it('rejects missing composition rather than falling back to the header', () => {
    expect(evaluateRuleConditions(rule, base, event).matched).toBe(false);
  });

  it('accepts a uniform complete composition even if the header is stale', () => {
    const state = { ...base, productionStatusId: null,
      productionSummary: { detailCount: 2, unassignedCount: 0, statusIds: [6] } };
    expect(evaluateRuleConditions(rule, state, event).matched).toBe(true);
  });

  it('does not let an unqualified production event move a mixed order', () => {
    const state = { ...base,
      productionSummary: { detailCount: 2, unassignedCount: 0, statusIds: [6, 7] } };
    expect(evaluateRuleConditions({ ...rule, conditions: {} }, state, event).matched).toBe(false);
  });

  it('checks excluded stages beyond the minimum', () => {
    const state = { ...base,
      productionSummary: { detailCount: 2, unassignedCount: 0, statusIds: [6, 22] } };
    expect(evaluateRuleConditions({ ...rule, eventType: 'payment.created',
      actionType: 'change_details_production_status', conditions: { currentProductionStatusNotIn: [22] } },
    state, { ...event, eventType: 'payment.created' }).matched).toBe(false);
  });

  it('allows initialization of unassigned details through a negative predicate', () => {
    const state = { ...base, productionStatusId: null,
      productionSummary: { detailCount: 2, unassignedCount: 2, statusIds: [] } };
    expect(evaluateRuleConditions({ ...rule, eventType: 'payment.created',
      actionType: 'change_details_production_status', conditions: { currentProductionStatusNotIn: [22] } },
    state, { ...event, eventType: 'payment.created' }).matched).toBe(true);
  });
});
