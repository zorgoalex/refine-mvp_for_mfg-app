import { describe, expect, it } from 'vitest';
import type { DeadlineActionRuleDto } from '../../../api/types/deadlineApi.types';
import {
  buildTransitionRuleDraft,
  buildTransitionRuleUpdatePayload,
  canManageDeadlineTransitionRules,
  formatStatusIdList,
  parseStatusIdList,
} from './deadlineTransitionRulesView';

const actionRuleId = '11111111-1111-4111-8111-111111111111';

describe('deadlineTransitionRulesView', () => {
  it('matches backend permissions for managing transition rules', () => {
    expect(canManageDeadlineTransitionRules({ permissions: ['deadlines.actions.manage'] })).toBe(true);
    expect(canManageDeadlineTransitionRules({ permissions: ['settings.manage'] })).toBe(false);
    expect(canManageDeadlineTransitionRules({ permissions: ['deadlines.manage'] })).toBe(false);
    expect(canManageDeadlineTransitionRules({ permissions: [] })).toBe(false);
  });

  it('formats and parses comma separated status id lists', () => {
    expect(formatStatusIdList([1, 2, 7])).toBe('1, 2, 7');
    expect(formatStatusIdList(undefined)).toBe('');
    expect(parseStatusIdList('1, 2 3\n4')).toEqual([1, 2, 3, 4]);
    expect(parseStatusIdList('')).toEqual([]);
  });

  it('builds editable drafts from transition rule config', () => {
    expect(buildTransitionRuleDraft(rule())).toEqual({
      isEnabled: true,
      priority: 10,
      targetOrderStatusId: 7,
      allowedFromOrderStatusIdsText: '1, 2',
      excludeOrderStatusIdsText: '9',
      excludeCompletedOrders: true,
      requireCurrentDeadlineEvent: true,
    });
  });

  it('builds stale-safe disabled transition rule update payloads', () => {
    const payload = buildTransitionRuleUpdatePayload(
      rule({ updatedAt: '2026-06-14T00:00:00.000Z' }),
      {
        isEnabled: true,
        priority: 25,
        targetOrderStatusId: 8,
        allowedFromOrderStatusIdsText: '1, 2',
        excludeOrderStatusIdsText: '9, 10',
        excludeCompletedOrders: false,
        requireCurrentDeadlineEvent: true,
      },
      'Ops approved change',
      'Ticket OPS-42',
    );

    expect(payload).toEqual({
      expectedUpdatedAt: '2026-06-14T00:00:00.000Z',
      priority: 25,
      eventType: 'DEADLINE_EXPIRED',
      actionType: 'change_order_status',
      targetOrderStatusId: 8,
      allowedFromOrderStatusIds: [1, 2],
      excludeOrderStatusIds: [9, 10],
      excludeCompletedOrders: false,
      requireCurrentDeadlineEvent: true,
      reason: 'Ops approved change',
      comment: 'Ticket OPS-42',
    });
  });

  it('sends an empty exclude list when blank so backend config can be cleared', () => {
    const payload = buildTransitionRuleUpdatePayload(
      rule(),
      {
        isEnabled: true,
        priority: 10,
        targetOrderStatusId: 7,
        allowedFromOrderStatusIdsText: '1',
        excludeOrderStatusIdsText: ' ',
        excludeCompletedOrders: true,
        requireCurrentDeadlineEvent: true,
      },
      'Enable rule',
    );

    expect(payload.allowedFromOrderStatusIds).toEqual([1]);
    expect(payload.excludeOrderStatusIds).toEqual([]);
    expect('isEnabled' in payload).toBe(false);
    expect('enabled' in payload).toBe(false);
  });

  it('rejects blank required allowed-from statuses before building payload', () => {
    expect(() =>
      buildTransitionRuleUpdatePayload(
        rule(),
        {
          isEnabled: true,
          priority: 10,
          targetOrderStatusId: 7,
          allowedFromOrderStatusIdsText: '',
          excludeOrderStatusIdsText: '',
          excludeCompletedOrders: true,
          requireCurrentDeadlineEvent: true,
        },
        'Enable rule',
      ),
    ).toThrow('Allowed-from statuses are required');
  });

  it('rejects invalid status id tokens instead of dropping them', () => {
    expect(() => parseStatusIdList('1, nope, 3', 'Allowed-from statuses')).toThrow(
      'Allowed-from statuses contains invalid status ids: nope',
    );
    expect(() => parseStatusIdList('1e2', 'Allowed-from statuses')).toThrow(
      'Allowed-from statuses contains invalid status ids: 1e2',
    );
    expect(() => parseStatusIdList('0x10', 'Allowed-from statuses')).toThrow(
      'Allowed-from statuses contains invalid status ids: 0x10',
    );
    expect(() => parseStatusIdList('1.0', 'Allowed-from statuses')).toThrow(
      'Allowed-from statuses contains invalid status ids: 1.0',
    );
    expect(() =>
      buildTransitionRuleUpdatePayload(
        rule(),
        {
          isEnabled: true,
          priority: 10,
          targetOrderStatusId: 7,
          allowedFromOrderStatusIdsText: '1, nope',
          excludeOrderStatusIdsText: '',
          excludeCompletedOrders: true,
          requireCurrentDeadlineEvent: true,
        },
        'Enable rule',
      ),
    ).toThrow('Allowed-from statuses contains invalid status ids: nope');
  });
});

function rule(overrides: Partial<DeadlineActionRuleDto> = {}): DeadlineActionRuleDto {
  return {
    actionRuleId,
    policyId: null,
    scopeType: 'order',
    eventType: 'DEADLINE_EXPIRED',
    actionType: 'change_order_status',
    isEnabled: true,
    priority: 10,
    config: {
      scope: { type: 'global_orders' },
      conditions: {
        allowedFromOrderStatusIds: [1, 2],
        excludeOrderStatusIds: [9],
        excludeCompletedOrders: true,
        requireCurrentDeadlineEvent: true,
      },
      actionConfig: { targetOrderStatusId: 7 },
    },
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}
