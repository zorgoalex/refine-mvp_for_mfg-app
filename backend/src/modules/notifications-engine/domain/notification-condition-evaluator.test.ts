import { describe, expect, it } from 'vitest';
import { evaluateRuleConditions } from './notification-condition-evaluator';
import { getMutatingActionConditionSkipReason } from '../../deadlines/application/deadline-action-evaluator';
import type { NotificationRuleConditions } from './notification-rule.types';

const ctx = {
  orderStatusId: 30,
  isOrderCompleted: false,
  deadlineEntityType: null,
  isCurrentDeadlineEvent: true,
} as const;

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
  it('honors deadlineEntityTypes for final order deadline rules', () => {
    expect(evaluateRuleConditions(
      { deadlineEntityTypes: ['order'] },
      { ...ctx, deadlineEntityType: 'order' },
    )).toEqual({ matched: true });

    expect(evaluateRuleConditions(
      { deadlineEntityTypes: ['order'] },
      { ...ctx, deadlineEntityType: 'order_stage' },
    )).toEqual({ matched: false, skipReason: 'deadline_entity_type_not_allowed' });
  });
  it('fails closed when deadlineEntityTypes is configured but context has no deadline entity type', () => {
    expect(evaluateRuleConditions(
      { deadlineEntityTypes: ['order'] },
      { ...ctx, deadlineEntityType: null },
    )).toEqual({ matched: false, skipReason: 'deadline_entity_type_unavailable' });
  });

  describe('requireCurrentDeadlineEvent staleness guard', () => {
    it('defaults requireCurrentDeadlineEvent to true and skips stale deadline events', () => {
      expect(evaluateRuleConditions({}, { ...ctx, isCurrentDeadlineEvent: false }))
        .toEqual({ matched: false, skipReason: 'stale_deadline_event' });
    });

    it('passes a current deadline event with the default (true) requirement', () => {
      expect(evaluateRuleConditions({}, { ...ctx, isCurrentDeadlineEvent: true }))
        .toEqual({ matched: true });
    });

    it('allows opting out via requireCurrentDeadlineEvent: false', () => {
      expect(evaluateRuleConditions(
        { requireCurrentDeadlineEvent: false },
        { ...ctx, isCurrentDeadlineEvent: false },
      )).toEqual({ matched: true });
    });

    it('does not gate non-deadline events (isCurrentDeadlineEvent: true by convention)', () => {
      // order.* events always pass isCurrentDeadlineEvent: true from the context builder.
      expect(evaluateRuleConditions({}, { ...ctx, isCurrentDeadlineEvent: true }))
        .toEqual({ matched: true });
    });
  });
});

describe('parity: lenient deadline-action condition gate vs. evaluateRuleConditions', () => {
  type Matrix = {
    label: string;
    conditions: NotificationRuleConditions;
    orderContext: { orderId: number; orderStatusId: number; isCompleted: boolean } | null;
    isCurrentDeadlineEvent: boolean;
  };

  // PARITY CONTRACT EXCEPTION: a rule with NO `conditions` at all is NEVER
  // staleness-gated by `getMutatingActionConditionSkipReason` (Task 3
  // regression guarantee for pre-existing set_overdue_flag/
  // change_production_status rules), but IS staleness-gated by
  // `evaluateRuleConditions` with its `requireCurrentDeadlineEvent ?? true`
  // default (Task 2, applies to engine-owned notify_*/escalate rules with no
  // legacy population to protect). This matrix intentionally omits a
  // "no conditions + stale" row for that reason — see Architecture section
  // "DRY / parity decision" in the plan doc.
  const matrix: Matrix[] = [
    {
      label: 'no conditions, current event -> both pass',
      conditions: {},
      orderContext: { orderId: 1, orderStatusId: 10, isCompleted: false },
      isCurrentDeadlineEvent: true,
    },
    {
      label: 'excludeCompletedOrders true + completed order -> both skip order_completed',
      conditions: { excludeCompletedOrders: true },
      orderContext: { orderId: 1, orderStatusId: 10, isCompleted: true },
      isCurrentDeadlineEvent: true,
    },
    {
      label: 'excludeOrderStatusIds matches order status -> both skip status_excluded',
      conditions: { excludeOrderStatusIds: [10] },
      orderContext: { orderId: 1, orderStatusId: 10, isCompleted: false },
      isCurrentDeadlineEvent: true,
    },
    {
      label: 'allowedFromOrderStatusIds excludes order status -> both skip status_not_allowed',
      conditions: { allowedFromOrderStatusIds: [20, 30] },
      orderContext: { orderId: 1, orderStatusId: 10, isCompleted: false },
      isCurrentDeadlineEvent: true,
    },
    {
      label: 'allowedFromOrderStatusIds includes order status -> both pass',
      conditions: { allowedFromOrderStatusIds: [10, 30] },
      orderContext: { orderId: 1, orderStatusId: 10, isCompleted: false },
      isCurrentDeadlineEvent: true,
    },
    {
      label: 'stale deadline event, default requireCurrentDeadlineEvent -> both skip stale_deadline_event',
      conditions: { allowedFromOrderStatusIds: [10] },
      orderContext: { orderId: 1, orderStatusId: 10, isCompleted: false },
      isCurrentDeadlineEvent: false,
    },
    {
      label: 'stale deadline event, requireCurrentDeadlineEvent: false -> both pass',
      conditions: { allowedFromOrderStatusIds: [10], requireCurrentDeadlineEvent: false },
      orderContext: { orderId: 1, orderStatusId: 10, isCompleted: false },
      isCurrentDeadlineEvent: false,
    },
  ];

  for (const { label, conditions, orderContext, isCurrentDeadlineEvent } of matrix) {
    it(`${label}`, () => {
      const engineResult = evaluateRuleConditions(conditions, {
        orderStatusId: orderContext?.orderStatusId ?? null,
        isOrderCompleted: orderContext?.isCompleted ?? false,
        deadlineEntityType: null,
        isCurrentDeadlineEvent,
      });

      const lenientSkipReason = getMutatingActionConditionSkipReason({
        rule: {
          actionRuleId: 'parity-rule',
          scopeType: 'order',
          eventType: 'DEADLINE_EXPIRED',
          actionType: 'set_overdue_flag',
          isEnabled: true,
          priority: 100,
          config: { conditions },
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        } as any,
        orderContext,
        orderContextUnavailable: false,
        isCurrentDeadlineEvent,
      });

      const lenientMatched = lenientSkipReason === null;
      expect(lenientMatched).toBe(engineResult.matched);
      if (!engineResult.matched) {
        expect(lenientSkipReason).toBe(engineResult.skipReason);
      }
    });
  }
});
