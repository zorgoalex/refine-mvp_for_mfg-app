import { describe, expect, it } from 'vitest';
import type { DeadlineActionRuleDto, DeadlineOrderOverrideDto } from '../dto/deadline-action-rule.dto';
import { evaluateDeadlineActionRules } from './deadline-action-evaluator';

describe('evaluateDeadlineActionRules', () => {
  it('sorts candidates deterministically and applies first applicable status rule wins', () => {
    const result = evaluateDeadlineActionRules({
      eventType: 'DEADLINE_EXPIRED',
      deadlineEventId: 'event-1',
      deadlineId: 'deadline-1',
      targetType: 'order',
      targetId: '42',
      orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
      isCurrentDeadlineEvent: true,
      rules: [
        rule({ actionRuleId: 'rule-c', priority: 20, createdAt: '2026-05-25T10:00:00.000Z' }),
        rule({ actionRuleId: 'rule-b', priority: 10, createdAt: '2026-05-25T09:00:00.000Z' }),
        rule({ actionRuleId: 'rule-a', priority: 10, createdAt: '2026-05-25T09:00:00.000Z' }),
      ],
      overrides: [],
    });

    expect(result.selectedActionRuleId).toBe('rule-a');
    expect(result.candidates.map((candidate) => [
      candidate.actionRuleId,
      candidate.wouldRun,
      candidate.skipReason,
    ])).toEqual([
      ['rule-a', true, null],
      ['rule-b', false, 'lower_priority_rule_not_selected'],
      ['rule-c', false, 'lower_priority_rule_not_selected'],
    ]);
  });

  it('returns skip reasons, merged override config, snapshot evidence, and idempotency material', () => {
    const result = evaluateDeadlineActionRules({
      eventType: 'DEADLINE_EXPIRED',
      deadlineEventId: 'event-1',
      deadlineId: 'deadline-1',
      targetType: 'order',
      targetId: '42',
      orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
      isCurrentDeadlineEvent: false,
      rules: [
        rule({ actionRuleId: 'disabled-rule', isEnabled: false, priority: 1 }),
        rule({ actionRuleId: 'override-disabled-rule', priority: 2 }),
        rule({
          actionRuleId: 'missing-target-rule',
          priority: 3,
          config: {
            conditions: { allowedFromOrderStatusIds: [1] },
            actionConfig: {},
          },
        }),
        rule({
          actionRuleId: 'missing-allowed-rule',
          priority: 4,
          config: {
            conditions: {},
            actionConfig: { targetOrderStatusId: 7 },
          },
        }),
        rule({
          actionRuleId: 'stale-rule',
          priority: 5,
          config: {
            conditions: {
              allowedFromOrderStatusIds: [2],
              requireCurrentDeadlineEvent: false,
            },
            actionConfig: { targetOrderStatusId: 7 },
          },
        }),
      ],
      overrides: [
        override({ actionRuleId: 'override-disabled-rule', overrideId: 'override-disabled' }),
        override({
          actionRuleId: 'stale-rule',
          overrideId: 'override-config',
          isDisabled: false,
          overrideConfig: {
            conditions: {
              allowedFromOrderStatusIds: [1],
              requireCurrentDeadlineEvent: true,
            },
            actionConfig: { targetOrderStatusId: 8 },
          },
        }),
      ],
    });

    expect(result.selectedActionRuleId).toBeNull();
    expect(result.selectionReason).toBe('no_applicable_rules');
    expect(result.candidates.map((candidate) => [
      candidate.actionRuleId,
      candidate.skipReason,
      candidate.overrideId,
      candidate.targetStatusId,
    ])).toEqual([
      ['disabled-rule', 'action_disabled', null, 7],
      ['override-disabled-rule', 'order_override_disabled', 'override-disabled', 7],
      ['missing-target-rule', 'missing_target_status', null, null],
      ['missing-allowed-rule', 'missing_allowed_from_statuses', null, 7],
      ['stale-rule', 'stale_deadline_event', 'override-config', 8],
    ]);
    expect(result.candidates[4]).toMatchObject({
      orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
      ruleSnapshot: {
        actionRuleId: 'stale-rule',
        policyId: null,
        scopeType: 'order',
        isEnabled: true,
        ruleName: null,
        ruleCode: null,
        conditions: {
          allowedFromOrderStatusIds: [1],
          requireCurrentDeadlineEvent: true,
        },
        actionConfig: { targetOrderStatusId: 8 },
        snapshotHash: expect.stringMatching(/^sha256:/),
      },
      idempotencyMaterial: {
        deadlineEventId: 'event-1',
        actionType: 'change_order_status',
        actionRuleId: 'stale-rule',
        orderId: 42,
        sourceOrderStatusId: 1,
        targetStatusId: 8,
        snapshotHash: expect.stringMatching(/^sha256:/),
      },
    });
  });

  it('accepts allowed from-status and skips disallowed or terminal order transitions by default', () => {
    expect(
      evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-allowed',
        orderContext: { orderId: 42, orderStatusId: 2, isCompleted: false },
        isCurrentDeadlineEvent: true,
        rules: [
          rule({
            actionRuleId: 'allowed-rule',
            config: {
              conditions: {
                allowedFromOrderStatusIds: [2],
                excludeCompletedOrders: true,
                requireCurrentDeadlineEvent: true,
              },
              actionConfig: { targetOrderStatusId: 7 },
            },
          }),
        ],
        overrides: [],
      }),
    ).toMatchObject({
      selectedActionRuleId: 'allowed-rule',
      candidates: [{ actionRuleId: 'allowed-rule', wouldRun: true, skipReason: null }],
    });

    expect(
      evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-disallowed',
        orderContext: { orderId: 42, orderStatusId: 5, isCompleted: false },
        isCurrentDeadlineEvent: true,
        rules: [rule({ actionRuleId: 'disallowed-rule' })],
        overrides: [],
      }).candidates[0],
    ).toMatchObject({
      actionRuleId: 'disallowed-rule',
      wouldRun: false,
      skipReason: 'disallowed_from_status',
    });

    expect(
      evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-completed',
        orderContext: { orderId: 42, orderStatusId: 1, isCompleted: true },
        isCurrentDeadlineEvent: true,
        rules: [
          rule({
            actionRuleId: 'completed-rule',
            config: {
              conditions: {
                allowedFromOrderStatusIds: [1],
                excludeCompletedOrders: true,
                requireCurrentDeadlineEvent: true,
              },
              actionConfig: { targetOrderStatusId: 7 },
            },
          }),
        ],
        overrides: [],
      }).candidates[0],
    ).toMatchObject({
      actionRuleId: 'completed-rule',
      wouldRun: false,
      skipReason: 'terminal_order_status',
    });
  });

  it('skips stale status transition events by default', () => {
    expect(
      evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-stale',
        orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
        isCurrentDeadlineEvent: false,
        rules: [
          rule({
            actionRuleId: 'stale-default-rule',
            config: {
              conditions: {
                allowedFromOrderStatusIds: [1],
              },
              actionConfig: { targetOrderStatusId: 7 },
            },
          }),
        ],
        overrides: [],
      }).candidates[0],
    ).toMatchObject({
      actionRuleId: 'stale-default-rule',
      wouldRun: false,
      skipReason: 'stale_deadline_event',
    });
  });

  it('fails closed when a status rule opts out of current-event enforcement', () => {
    expect(
      evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-stale-allowed',
        orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
        isCurrentDeadlineEvent: false,
        rules: [
          rule({
            actionRuleId: 'stale-allowed-rule',
            config: {
              conditions: {
                allowedFromOrderStatusIds: [1],
                requireCurrentDeadlineEvent: false,
              },
              actionConfig: { targetOrderStatusId: 7 },
            },
          }),
        ],
        overrides: [],
      }).candidates[0],
    ).toMatchObject({
      actionRuleId: 'stale-allowed-rule',
      wouldRun: false,
      skipReason: 'unsafe_rule_config',
    });
  });

  describe('set_overdue_flag / change_production_status condition gating', () => {
    it('REGRESSION: a set_overdue_flag rule with no conditions configured still runs (no orderContext fetched)', () => {
      const result = evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-1',
        deadlineId: 'deadline-1',
        targetType: 'order',
        targetId: '42',
        orderContext: null,
        orderContextUnavailable: false,
        isCurrentDeadlineEvent: true,
        rules: [
          rule({ actionRuleId: 'overdue-rule', actionType: 'set_overdue_flag', config: {} }),
        ],
        overrides: [],
      });

      expect(result.candidates).toEqual([
        expect.objectContaining({ actionRuleId: 'overdue-rule', wouldRun: true, skipReason: null }),
      ]);
    });

    it('REGRESSION: a change_production_status rule with no conditions configured still runs', () => {
      const result = evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-1',
        deadlineId: 'deadline-1',
        targetType: 'order',
        targetId: '42',
        orderContext: null,
        orderContextUnavailable: false,
        isCurrentDeadlineEvent: true,
        rules: [
          rule({
            actionRuleId: 'production-rule',
            actionType: 'change_production_status',
            config: { actionConfig: { targetProductionStatusId: 6, productionStatusScope: 'order' } },
          }),
        ],
        overrides: [],
      });

      expect(result.candidates).toEqual([
        expect.objectContaining({ actionRuleId: 'production-rule', wouldRun: true, skipReason: null }),
      ]);
    });

    it('skips set_overdue_flag when excludeCompletedOrders is configured and the order is completed', () => {
      const result = evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-1',
        deadlineId: 'deadline-1',
        targetType: 'order',
        targetId: '42',
        orderContext: { orderId: 42, orderStatusId: 90, isCompleted: true },
        orderContextUnavailable: false,
        isCurrentDeadlineEvent: true,
        rules: [
          rule({
            actionRuleId: 'overdue-rule',
            actionType: 'set_overdue_flag',
            config: { conditions: { excludeCompletedOrders: true } },
          }),
        ],
        overrides: [],
      });

      expect(result.candidates).toEqual([
        expect.objectContaining({
          actionRuleId: 'overdue-rule',
          wouldRun: false,
          skipReason: 'order_completed',
        }),
      ]);
    });

    it('skips change_production_status when the order status is in excludeOrderStatusIds', () => {
      const result = evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-1',
        deadlineId: 'deadline-1',
        targetType: 'order',
        targetId: '42',
        orderContext: { orderId: 42, orderStatusId: 5, isCompleted: false },
        orderContextUnavailable: false,
        isCurrentDeadlineEvent: true,
        rules: [
          rule({
            actionRuleId: 'production-rule',
            actionType: 'change_production_status',
            config: {
              conditions: { excludeOrderStatusIds: [5] },
              actionConfig: { targetProductionStatusId: 6, productionStatusScope: 'order' },
            },
          }),
        ],
        overrides: [],
      });

      expect(result.candidates).toEqual([
        expect.objectContaining({
          actionRuleId: 'production-rule',
          wouldRun: false,
          skipReason: 'status_excluded',
        }),
      ]);
    });

    it('runs set_overdue_flag when allowedFromOrderStatusIds includes the current order status', () => {
      const result = evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-1',
        deadlineId: 'deadline-1',
        targetType: 'order',
        targetId: '42',
        orderContext: { orderId: 42, orderStatusId: 10, isCompleted: false },
        orderContextUnavailable: false,
        isCurrentDeadlineEvent: true,
        rules: [
          rule({
            actionRuleId: 'overdue-rule',
            actionType: 'set_overdue_flag',
            config: { conditions: { allowedFromOrderStatusIds: [10, 11] } },
          }),
        ],
        overrides: [],
      });

      expect(result.candidates).toEqual([
        expect.objectContaining({ actionRuleId: 'overdue-rule', wouldRun: true, skipReason: null }),
      ]);
    });

    it('skips set_overdue_flag when allowedFromOrderStatusIds does not include the current order status', () => {
      const result = evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-1',
        deadlineId: 'deadline-1',
        targetType: 'order',
        targetId: '42',
        orderContext: { orderId: 42, orderStatusId: 99, isCompleted: false },
        orderContextUnavailable: false,
        isCurrentDeadlineEvent: true,
        rules: [
          rule({
            actionRuleId: 'overdue-rule',
            actionType: 'set_overdue_flag',
            config: { conditions: { allowedFromOrderStatusIds: [10, 11] } },
          }),
        ],
        overrides: [],
      });

      expect(result.candidates).toEqual([
        expect.objectContaining({
          actionRuleId: 'overdue-rule',
          wouldRun: false,
          skipReason: 'status_not_allowed',
        }),
      ]);
    });

    it('skips set_overdue_flag when the rule has conditions but orderContext is unavailable (stale)', () => {
      const result = evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-1',
        deadlineId: 'deadline-1',
        targetType: 'order',
        targetId: '42',
        orderContext: null,
        orderContextUnavailable: true,
        isCurrentDeadlineEvent: true,
        rules: [
          rule({
            actionRuleId: 'overdue-rule',
            actionType: 'set_overdue_flag',
            config: { conditions: { excludeCompletedOrders: true } },
          }),
        ],
        overrides: [],
      });

      expect(result.candidates).toEqual([
        expect.objectContaining({
          actionRuleId: 'overdue-rule',
          wouldRun: false,
          skipReason: 'stale_deadline_event',
        }),
      ]);
    });

    it('skips set_overdue_flag with conditions when no orderContext AND orderContextUnavailable is false (missing_order_id)', () => {
      const result = evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-1',
        deadlineId: 'deadline-1',
        targetType: 'order',
        targetId: '42',
        orderContext: null,
        orderContextUnavailable: false,
        isCurrentDeadlineEvent: true,
        rules: [
          rule({
            actionRuleId: 'overdue-rule',
            actionType: 'set_overdue_flag',
            config: { conditions: { excludeCompletedOrders: true } },
          }),
        ],
        overrides: [],
      });

      expect(result.candidates).toEqual([
        expect.objectContaining({
          actionRuleId: 'overdue-rule',
          wouldRun: false,
          skipReason: 'missing_order_id',
        }),
      ]);
    });

    it('skips set_overdue_flag with conditions when isCurrentDeadlineEvent is false and requireCurrentDeadlineEvent defaults to true', () => {
      const result = evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-1',
        deadlineId: 'deadline-1',
        targetType: 'order',
        targetId: '42',
        orderContext: { orderId: 42, orderStatusId: 10, isCompleted: false },
        orderContextUnavailable: false,
        isCurrentDeadlineEvent: false,
        rules: [
          rule({
            actionRuleId: 'overdue-rule',
            actionType: 'set_overdue_flag',
            config: { conditions: { allowedFromOrderStatusIds: [10] } },
          }),
        ],
        overrides: [],
      });

      expect(result.candidates).toEqual([
        expect.objectContaining({
          actionRuleId: 'overdue-rule',
          wouldRun: false,
          skipReason: 'stale_deadline_event',
        }),
      ]);
    });

    it('runs set_overdue_flag with conditions when isCurrentDeadlineEvent is false but requireCurrentDeadlineEvent is false', () => {
      const result = evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-1',
        deadlineId: 'deadline-1',
        targetType: 'order',
        targetId: '42',
        orderContext: { orderId: 42, orderStatusId: 10, isCompleted: false },
        orderContextUnavailable: false,
        isCurrentDeadlineEvent: false,
        rules: [
          rule({
            actionRuleId: 'overdue-rule',
            actionType: 'set_overdue_flag',
            config: {
              conditions: { allowedFromOrderStatusIds: [10], requireCurrentDeadlineEvent: false },
            },
          }),
        ],
        overrides: [],
      });

      expect(result.candidates).toEqual([
        expect.objectContaining({ actionRuleId: 'overdue-rule', wouldRun: true, skipReason: null }),
      ]);
    });

    it('EDGE CASE: a set_overdue_flag rule with ONLY requireCurrentDeadlineEvent:false has no gating conditions (no orderContext needed, runs even when stale)', () => {
      const result = evaluateDeadlineActionRules({
        eventType: 'DEADLINE_EXPIRED',
        deadlineEventId: 'event-1',
        deadlineId: 'deadline-1',
        targetType: 'order',
        targetId: '42',
        orderContext: null,
        orderContextUnavailable: false,
        isCurrentDeadlineEvent: false,
        rules: [
          rule({
            actionRuleId: 'overdue-rule',
            actionType: 'set_overdue_flag',
            config: { conditions: { requireCurrentDeadlineEvent: false } },
          }),
        ],
        overrides: [],
      });

      expect(result.candidates).toEqual([
        expect.objectContaining({ actionRuleId: 'overdue-rule', wouldRun: true, skipReason: null }),
      ]);
    });
  });
});

function rule(overrides: Partial<DeadlineActionRuleDto> = {}): DeadlineActionRuleDto {
  const result: DeadlineActionRuleDto = {
    actionRuleId: 'rule-1',
    policyId: null,
    scopeType: 'order',
    eventType: 'DEADLINE_EXPIRED',
    actionType: 'change_order_status',
    isEnabled: true,
    priority: 100,
    config: {
      conditions: {
        allowedFromOrderStatusIds: [1],
        excludeOrderStatusIds: [9],
        excludeCompletedOrders: true,
        requireCurrentDeadlineEvent: true,
      },
      actionConfig: { targetOrderStatusId: 7 },
    },
    createdAt: '2026-05-25T10:00:00.000Z',
    updatedAt: '2026-05-25T10:00:00.000Z',
    ...overrides,
  };
  if (result.actionType === 'change_order_status') {
    result.config = {
      ...(result.config ?? {}),
      conditions: {
        excludeCompletedOrders: true,
        requireCurrentDeadlineEvent: true,
        ...(result.config?.conditions ?? {}),
      },
    };
  }
  return result;
}

function override(overrides: Partial<DeadlineOrderOverrideDto> = {}): DeadlineOrderOverrideDto {
  return {
    overrideId: 'override-1',
    orderId: 42,
    targetType: 'action_rule',
    policyId: null,
    actionRuleId: 'rule-1',
    isDisabled: true,
    overrideConfig: {},
    reason: 'Manual customer exception',
    createdByUserId: 1,
    updatedByUserId: 1,
    retiredByUserId: null,
    retiredAt: null,
    createdAt: '2026-05-25T10:00:00.000Z',
    updatedAt: '2026-05-25T10:00:00.000Z',
    ...overrides,
  };
}
