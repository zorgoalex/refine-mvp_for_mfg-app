import { describe, expect, it } from 'vitest';
import type {
  DeadlineActionRuleConfigDto,
  DeadlineRuleConfigSnapshotDto,
} from './deadline-action-rule.dto';
import { getDeadlineOrderOverrideTarget } from './deadline-action-rule.dto';
import type { UpsertDeadlineOrderOverrideInput } from './deadline-action-rule.dto';

describe('deadline action rule DTO contracts', () => {
  it('types first-stage transition rule conditions and action config', () => {
    const config = {
      scope: { type: 'global_orders' },
      conditions: {
        allowedFromOrderStatusIds: [1, 2],
        excludeOrderStatusIds: [7, 8],
        excludeCompletedOrders: true,
        requireCurrentDeadlineEvent: true,
      },
      actionConfig: {
        targetOrderStatusId: 7,
      },
    } satisfies DeadlineActionRuleConfigDto;

    expect(config.conditions.allowedFromOrderStatusIds).toEqual([1, 2]);
    expect(config.actionConfig.targetOrderStatusId).toBe(7);
  });

  it('requires immutable rule snapshot evidence fields for executions', () => {
    const snapshot = {
      actionRuleId: 'rule-1',
      priority: 10,
      eventType: 'DEADLINE_EXPIRED',
      actionType: 'change_order_status',
      conditions: {
        excludeCompletedOrders: true,
        requireCurrentDeadlineEvent: true,
      },
      actionConfig: {
        targetOrderStatusId: 7,
      },
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-01T10:05:00.000Z',
      snapshotHash: 'sha256:rule-1',
    } satisfies DeadlineRuleConfigSnapshotDto;

    expect(snapshot.actionRuleId).toBe('rule-1');
    expect(snapshot.snapshotHash).toBe('sha256:rule-1');
  });

  it('uses a discriminated union for policy override inputs', () => {
    const input = {
      targetType: 'policy',
      orderId: 100,
      policyId: 'policy-1',
      isDisabled: true,
      reason: 'Pause timer for exception',
    } satisfies UpsertDeadlineOrderOverrideInput;

    expect(getDeadlineOrderOverrideTarget(input)).toEqual({
      targetType: 'policy',
      targetId: 'policy-1',
    });
  });

  it('uses a discriminated union for action-rule override inputs', () => {
    const input = {
      targetType: 'action_rule',
      orderId: 100,
      actionRuleId: 'rule-1',
      isDisabled: true,
      reason: 'Skip automatic transition',
    } satisfies UpsertDeadlineOrderOverrideInput;

    expect(getDeadlineOrderOverrideTarget(input)).toEqual({
      targetType: 'action_rule',
      targetId: 'rule-1',
    });
  });
});
