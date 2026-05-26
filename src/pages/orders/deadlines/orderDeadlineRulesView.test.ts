import { describe, expect, it } from 'vitest';
import type {
  DeadlineActionRuleDto,
  DeadlineDto,
  DeadlineEventDto,
  DeadlineOrderOverrideDto,
  DeadlinePolicyDto,
  OrderEffectiveDeadlineRulesResponse,
  PreviewOrderDeadlineActionRulesResponse,
} from '../../../api/types/deadlineApi.types';
import type { BackendUserIdentity } from '../../../api/types/authApi.types';
import {
  buildDisableOrderOverrideRequest,
  buildEffectiveActionRuleRows,
  buildEffectivePolicyRows,
  buildOrderOverrideRows,
  buildPreviewActionRuleRows,
  canEditOrderDeadlineOverrides,
  canViewOrderDeadlineRules,
  loadOrderDeadlinePanelData,
  selectDeadlineActionPreviewContext,
} from './orderDeadlineRulesView';

const actionRuleId = '11111111-1111-4111-8111-111111111111';
const policyId = '22222222-2222-4222-8222-222222222222';

describe('orderDeadlineRulesView', () => {
  it('gates the order rule block separately from override edit permission', () => {
    expect(
      canViewOrderDeadlineRules(userWithPermissions(['deadlines.actions.manage'])),
    ).toBe(true);
    expect(
      canViewOrderDeadlineRules(userWithPermissions(['deadlines.manage_order_overrides'])),
    ).toBe(true);
    expect(canViewOrderDeadlineRules(userWithPermissions(['deadlines.manage']))).toBe(false);
    expect(canViewOrderDeadlineRules(userWithPermissions(['settings.manage']))).toBe(false);
    expect(
      canEditOrderDeadlineOverrides(userWithPermissions(['settings.manage'])),
    ).toBe(false);
    expect(
      canEditOrderDeadlineOverrides(userWithPermissions(['deadlines.manage_order_overrides'])),
    ).toBe(true);
    expect(canViewOrderDeadlineRules(userWithPermissions([]))).toBe(false);
  });

  it('builds effective policy and action rows with override state', () => {
    const response: OrderEffectiveDeadlineRulesResponse = {
      orderId: 42,
      policies: [
        {
          ...policy(),
          override: override({ targetType: 'policy', policyId, actionRuleId: null }),
        },
      ],
      actionRules: [
        {
          ...actionRule(),
          override: override({ targetType: 'action_rule', policyId: null, actionRuleId }),
        },
      ],
      overrides: [],
    };

    expect(buildEffectivePolicyRows(response)[0]).toMatchObject({
      key: policyId,
      name: 'Final order timer',
      enabled: true,
      overrideId: actionRuleId,
      overrideDisabled: true,
      targetType: 'policy',
    });
    expect(buildEffectiveActionRuleRows(response)[0]).toMatchObject({
      key: actionRuleId,
      actionType: 'change_order_status',
      priority: 10,
      targetStatusId: 7,
      overrideDisabled: true,
      allowedFrom: '1, 2',
      excluded: '9',
      targetType: 'action_rule',
    });
  });

  it('builds preview rows that expose dry-run selection and skip reasons', () => {
    const response: PreviewOrderDeadlineActionRulesResponse = {
      orderId: 42,
      eventType: 'DEADLINE_EXPIRED',
      candidateActionRules: [
        {
          actionRuleId,
          priority: 10,
          actionType: 'change_order_status',
          wouldRun: false,
          wouldSkipReason: 'order_override_disabled',
          targetOrderStatusId: 7,
          overrideId: '33333333-3333-4333-8333-333333333333',
        },
      ],
      selectedActionRuleId: null,
      selectionReason: 'no_candidate_rules',
    };

    expect(buildPreviewActionRuleRows(response)[0]).toEqual({
      key: actionRuleId,
      actionRuleId,
      priority: 10,
      actionType: 'change_order_status',
      wouldRun: false,
      wouldSkipReason: 'order_override_disabled',
      targetStatusId: 7,
      overrideId: '33333333-3333-4333-8333-333333333333',
      selected: false,
    });
  });

  it('selects the latest DEADLINE_EXPIRED event as preview context', () => {
    expect(
      selectDeadlineActionPreviewContext([
        deadlineEvent({
          deadlineEventId: '11111111-1111-4111-8111-111111111111',
          deadlineId: '22222222-2222-4222-8222-222222222222',
          eventType: 'DEADLINE_CREATED',
          eventAt: '2026-05-01T10:00:00.000Z',
        }),
        deadlineEvent({
          deadlineEventId: '33333333-3333-4333-8333-333333333333',
          deadlineId: '44444444-4444-4444-8444-444444444444',
          eventType: 'DEADLINE_EXPIRED',
          eventAt: '2026-05-01T12:00:00.000Z',
        }),
        deadlineEvent({
          deadlineEventId: '55555555-5555-4555-8555-555555555555',
          deadlineId: '66666666-6666-4666-8666-666666666666',
          eventType: 'DEADLINE_EXPIRED',
          eventAt: '2026-05-01T11:00:00.000Z',
        }),
      ]),
    ).toEqual({
      eventType: 'DEADLINE_EXPIRED',
      deadlineId: '44444444-4444-4444-8444-444444444444',
      deadlineEventId: '33333333-3333-4333-8333-333333333333',
    });

    expect(
      selectDeadlineActionPreviewContext([
        deadlineEvent({ eventType: 'DEADLINE_CREATED' }),
      ]),
    ).toBeNull();
  });

  it('includes non-empty fixture key from the latest expired event preview context', () => {
    expect(
      selectDeadlineActionPreviewContext([
        deadlineEvent({
          deadlineEventId: '33333333-3333-4333-8333-333333333333',
          deadlineId: '44444444-4444-4444-8444-444444444444',
          eventAt: '2026-05-01T12:00:00.000Z',
          payload: { fixtureKey: 'deadline-canary' },
        }),
      ]),
    ).toEqual({
      eventType: 'DEADLINE_EXPIRED',
      deadlineId: '44444444-4444-4444-8444-444444444444',
      deadlineEventId: '33333333-3333-4333-8333-333333333333',
      fixtureKey: 'deadline-canary',
    });

    expect(
      selectDeadlineActionPreviewContext([
        deadlineEvent({
          payload: { fixtureKey: '   ' },
        }),
      ]),
    ).toEqual({
      eventType: 'DEADLINE_EXPIRED',
      deadlineId: '88888888-8888-4888-8888-888888888888',
      deadlineEventId: '77777777-7777-4777-8777-777777777777',
    });
  });

  it('builds order override rows with actor and timestamp visibility', () => {
    expect(
      buildOrderOverrideRows([
        override({
          createdByUserId: 11,
          updatedByUserId: 22,
          updatedAt: '2026-05-03T10:15:00.000Z',
        }),
      ])[0],
    ).toMatchObject({
      key: actionRuleId,
      overrideId: actionRuleId,
      targetId: actionRuleId,
      createdByUserId: 11,
      updatedByUserId: 22,
      updatedAt: '2026-05-03T10:15:00.000Z',
    });
  });

  it('builds disable override payloads for policies and action rules', () => {
    expect(buildDisableOrderOverrideRequest('policy', policyId, 'Timer not applicable')).toEqual({
      targetType: 'policy',
      policyId,
      isDisabled: true,
      reason: 'Timer not applicable',
    });
    expect(buildDisableOrderOverrideRequest('action_rule', actionRuleId, 'Manual exception')).toEqual({
      targetType: 'action_rule',
      actionRuleId,
      isDisabled: true,
      reason: 'Manual exception',
    });
  });

  it('preserves base deadline data when supplemental rules and preview fail', async () => {
    const result = await loadOrderDeadlinePanelData({
      orderId: 42,
      canViewRules: true,
      api: {
        getSummaryForOrder: async () => summary(),
        listForOrder: async () => ({ data: [deadline()] }),
        listEventsForOrder: async () => ({
          data: [
            deadlineEvent({
              deadlineEventId: '33333333-3333-4333-8333-333333333333',
              deadlineId: '44444444-4444-4444-8444-444444444444',
            }),
          ],
        }),
        getOrderEffectiveRules: async () => {
          throw new Error('rules unavailable');
        },
        previewOrderActionRules: async () => {
          throw new Error('preview unavailable');
        },
      },
    });

    expect(result.summary.orderId).toBe(42);
    expect(result.deadlines).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect(result.effectiveRules).toBeNull();
    expect(result.preview).toBeNull();
    expect(result.rulesError).toBe('rules unavailable');
    expect(result.previewUnavailableReason).toBe('preview unavailable');
  });
});

function userWithPermissions(permissions: string[]): BackendUserIdentity {
  return {
    id: '1',
    username: 'admin',
    role: 'admin',
    permissions,
  };
}

function policy(overrides: Partial<DeadlinePolicyDto> = {}): DeadlinePolicyDto {
  return {
    policyId,
    policyCode: 'final_order_timer',
    policyName: 'Final order timer',
    scopeType: 'order',
    isEnabled: true,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

function actionRule(overrides: Partial<DeadlineActionRuleDto> = {}): DeadlineActionRuleDto {
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

function override(overrides: Partial<DeadlineOrderOverrideDto> = {}): DeadlineOrderOverrideDto {
  return {
    overrideId: actionRuleId,
    orderId: 42,
    targetType: 'action_rule',
    policyId: null,
    actionRuleId,
    isDisabled: true,
    overrideConfig: {},
    reason: 'Manual exception',
    createdByUserId: 1,
    updatedByUserId: 1,
    retiredByUserId: null,
    retiredAt: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}

function deadlineEvent(overrides: Partial<DeadlineEventDto> = {}): DeadlineEventDto {
  return {
    deadlineEventId: '77777777-7777-4777-8777-777777777777',
    deadlineId: '88888888-8888-4888-8888-888888888888',
    eventType: 'DEADLINE_EXPIRED',
    severity: 'critical',
    eventAt: '2026-05-01T10:00:00.000Z',
    deadlineAt: '2026-05-01T09:00:00.000Z',
    delayMinutes: 60,
    payload: null,
    ...overrides,
  };
}

function deadline(): DeadlineDto {
  return {
    deadlineId: '99999999-9999-4999-8999-999999999999',
    entityType: 'order',
    entityId: '42',
    orderId: 42,
    deadlineAt: '2026-05-02T10:00:00.000Z',
    status: 'active',
    source: 'policy',
    isManuallyOverridden: false,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
  };
}

function summary() {
  return {
    orderId: 42,
    finalDeadline: null,
    currentStageDeadline: null,
    counts: {
      active: 1,
      expired: 0,
      completedLate: 0,
      completedOnTime: 0,
    },
  };
}
