import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { DeadlineActionRuleDto, DeadlineOrderOverrideDto } from '../dto/deadline-action-rule.dto';
import type { DeadlineInstanceDto } from '../dto/deadline-instance.dto';
import type { DeadlinePolicyDto } from '../dto/deadline-policy.dto';
import { DeadlineQueryService, buildOrderDeadlineSummary } from './deadline-query.service';
import type { DeadlineRepositoryPort } from './deadline.types';

describe('DeadlineQueryService', () => {
  it('requires deadlines.view for list reads', async () => {
    const service = new DeadlineQueryService({
      repository: createRepository(),
    });

    await expect(
      service.list({
        currentUser: currentUser([]),
        query: {
          page: 1,
          pageSize: 25,
          sortBy: 'deadlineAt',
          sortOrder: 'asc',
          onlyOverdue: false,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    } satisfies Partial<ApiError>);
  });

  it('builds order deadline summary from deadline instances', () => {
    const summary = buildOrderDeadlineSummary(
      42,
      [
        createDeadline({
          deadlineId: 'final',
          entityType: 'order',
          orderId: 42,
          deadlineAt: '2026-05-02T10:00:00.000Z',
          status: 'active',
        }),
        createDeadline({
          deadlineId: 'stage',
          entityType: 'order_stage',
          orderId: 42,
          orderWorkshopId: 7,
          deadlineAt: '2026-05-01T09:00:00.000Z',
          status: 'expired',
          metadata: { stageName: 'Раскрой' },
        }),
        createDeadline({
          deadlineId: 'late',
          entityType: 'order_stage',
          orderId: 42,
          deadlineAt: '2026-04-30T09:00:00.000Z',
          status: 'completed_late',
        }),
      ],
      '2026-05-01T10:00:00.000Z',
    );

    expect(summary).toMatchObject({
      orderId: 42,
      finalDeadline: {
        deadlineId: 'final',
        remainingMinutes: 1440,
      },
      currentStageDeadline: {
        deadlineId: 'stage',
        orderWorkshopId: 7,
        stageName: 'Раскрой',
      },
      counts: {
        active: 1,
        expired: 1,
        completedLate: 1,
        completedOnTime: 0,
      },
    });
  });

  it('lists effective order rules with active order overrides', async () => {
    const repository = createRepository({
      policies: [policy()],
      actionRules: [transitionRule()],
      overrides: [orderOverride({ policyId: 'policy-1', actionRuleId: null, targetType: 'policy' })],
    });
    const service = new DeadlineQueryService({ repository });

    await expect(
      service.listOrderEffectiveRules({
        currentUser: currentUser(['deadlines.manage_order_overrides']),
        orderId: 42,
      }),
    ).resolves.toMatchObject({
      orderId: 42,
      policies: [
        {
          policyId: 'policy-1',
          durationValue: 10,
          override: { overrideId: 'override-1' },
        },
      ],
      actionRules: [
        {
          actionRuleId: 'rule-1',
          override: null,
        },
      ],
      overrides: [{ overrideId: 'override-1' }],
    });
  });

  it('requires restricted permissions for effective order rules', async () => {
    const service = new DeadlineQueryService({
      repository: createRepository({ policies: [policy()], actionRules: [transitionRule()] }),
    });

    await expect(
      service.listOrderEffectiveRules({
        currentUser: currentUser(['deadlines.view']),
        orderId: 42,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    } satisfies Partial<ApiError>);

    await expect(
      service.listOrderEffectiveRules({
        currentUser: currentUser(['deadlines.manage_order_overrides']),
        orderId: 42,
      }),
    ).resolves.toMatchObject({ orderId: 42 });
  });

  it('previews transition rule selection without creating action executions', async () => {
    const repository = createRepository({
      actionRules: [
        transitionRule({ actionRuleId: 'disabled-rule', isEnabled: false, priority: 1 }),
        transitionRule({ actionRuleId: 'override-rule', priority: 2 }),
        transitionRule({ actionRuleId: 'missing-target-rule', priority: 3, config: {
          scope: { type: 'global_orders' },
          conditions: { allowedFromOrderStatusIds: [1] },
          actionConfig: {},
        } }),
        transitionRule({ actionRuleId: 'selected-rule', priority: 4 }),
        transitionRule({ actionRuleId: 'lower-rule', priority: 5 }),
      ],
      overrides: [orderOverride({ actionRuleId: 'override-rule', overrideId: 'override-disabled' })],
      orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
      isCurrentDeadlineEvent: true,
    });
    const service = new DeadlineQueryService({ repository });

    const preview = await service.previewOrderActionRules({
      currentUser: currentUser(),
      orderId: 42,
      dto: {
        eventType: 'DEADLINE_EXPIRED',
        deadlineId: '11111111-1111-4111-8111-111111111111',
        deadlineEventId: '22222222-2222-4222-8222-222222222222',
      },
    });

    expect(preview.selectedActionRuleId).toBe('selected-rule');
    expect(preview.selectionReason).toBe('first_applicable_rule');
    expect(preview.candidateActionRules.map((candidate) => [
      candidate.actionRuleId,
      candidate.wouldRun,
      candidate.wouldSkipReason,
      candidate.overrideId,
    ])).toEqual([
      ['disabled-rule', false, 'action_disabled', null],
      ['override-rule', false, 'order_override_disabled', 'override-disabled'],
      ['missing-target-rule', false, 'missing_target_status', null],
      ['selected-rule', true, null, null],
      ['lower-rule', false, 'lower_priority_rule_not_selected', null],
    ]);
    expect(repository.createActionExecution).not.toHaveBeenCalled();
    expect(repository.upsertOrderOverride).not.toHaveBeenCalled();
    expect(repository.retireOrderOverride).not.toHaveBeenCalled();
    expect(repository.updateGlobalTransitionRule).not.toHaveBeenCalled();
  });

  it('applies active overrideConfig when previewing candidates', async () => {
    const repository = createRepository({
      actionRules: [
        transitionRule({
          actionRuleId: 'rule-overridden',
          config: {
            scope: { type: 'global_orders' },
            conditions: {
              allowedFromOrderStatusIds: [2],
              excludeOrderStatusIds: [7],
              excludeCompletedOrders: true,
              requireCurrentDeadlineEvent: false,
            },
            actionConfig: { targetOrderStatusId: 7 },
          },
        }),
      ],
      overrides: [
        orderOverride({
          overrideId: 'override-config',
          actionRuleId: 'rule-overridden',
          isDisabled: false,
          overrideConfig: {
            conditions: {
              allowedFromOrderStatusIds: [1],
              excludeOrderStatusIds: [],
            },
            actionConfig: { targetOrderStatusId: 8 },
          },
        }),
      ],
      orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
      isCurrentDeadlineEvent: true,
    });

    await expect(
      new DeadlineQueryService({ repository }).previewOrderActionRules({
        currentUser: currentUser(),
        orderId: 42,
        dto: { eventType: 'DEADLINE_EXPIRED' },
      }),
    ).resolves.toMatchObject({
      selectedActionRuleId: 'rule-overridden',
      candidateActionRules: [
        {
          actionRuleId: 'rule-overridden',
          wouldRun: true,
          overrideId: 'override-config',
          targetOrderStatusId: 8,
        },
      ],
    });
    expect(repository.createActionExecution).not.toHaveBeenCalled();
  });

  it('validates current deadline event when an active override requires it', async () => {
    const repository = createRepository({
      actionRules: [
        transitionRule({
          actionRuleId: 'rule-overridden-current-event',
          config: {
            scope: { type: 'global_orders' },
            conditions: {
              allowedFromOrderStatusIds: [1],
              excludeOrderStatusIds: [],
              excludeCompletedOrders: true,
              requireCurrentDeadlineEvent: false,
            },
            actionConfig: { targetOrderStatusId: 7 },
          },
        }),
      ],
      overrides: [
        orderOverride({
          overrideId: 'override-requires-current-event',
          actionRuleId: 'rule-overridden-current-event',
          isDisabled: false,
          overrideConfig: {
            conditions: {
              requireCurrentDeadlineEvent: true,
            },
          },
        }),
      ],
      orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
      isCurrentDeadlineEvent: false,
    });

    await expect(
      new DeadlineQueryService({ repository }).previewOrderActionRules({
        currentUser: currentUser(),
        orderId: 42,
        dto: {
          eventType: 'DEADLINE_EXPIRED',
          deadlineId: '11111111-1111-4111-8111-111111111111',
          deadlineEventId: '22222222-2222-4222-8222-222222222222',
        },
      }),
    ).resolves.toMatchObject({
      selectedActionRuleId: null,
      candidateActionRules: [
        {
          actionRuleId: 'rule-overridden-current-event',
          wouldRun: false,
          wouldSkipReason: 'stale_deadline_event',
          overrideId: 'override-requires-current-event',
        },
      ],
    });
    expect(repository.isDeadlineEventCurrentForOrder).toHaveBeenCalledWith({
      orderId: 42,
      deadlineId: '11111111-1111-4111-8111-111111111111',
      deadlineEventId: '22222222-2222-4222-8222-222222222222',
    });
    expect(repository.createActionExecution).not.toHaveBeenCalled();
  });

  it('skips rules requiring current deadline event when preview event context is missing or stale', async () => {
    const staleRepository = createRepository({
      actionRules: [transitionRule()],
      orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
      isCurrentDeadlineEvent: false,
    });
    const currentRepository = createRepository({
      actionRules: [transitionRule()],
      orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
      isCurrentDeadlineEvent: true,
    });

    await expect(
      new DeadlineQueryService({ repository: staleRepository }).previewOrderActionRules({
        currentUser: currentUser(),
        orderId: 42,
        dto: {
          eventType: 'DEADLINE_EXPIRED',
          deadlineId: '11111111-1111-4111-8111-111111111111',
          deadlineEventId: '22222222-2222-4222-8222-222222222222',
        },
      }),
    ).resolves.toMatchObject({
      selectedActionRuleId: null,
      candidateActionRules: [
        {
          actionRuleId: 'rule-1',
          wouldRun: false,
          wouldSkipReason: 'stale_deadline_event',
        },
      ],
    });

    await expect(
      new DeadlineQueryService({ repository: currentRepository }).previewOrderActionRules({
        currentUser: currentUser(),
        orderId: 42,
        dto: {
          eventType: 'DEADLINE_EXPIRED',
          deadlineId: '11111111-1111-4111-8111-111111111111',
          deadlineEventId: '22222222-2222-4222-8222-222222222222',
        },
      }),
    ).resolves.toMatchObject({
      selectedActionRuleId: 'rule-1',
      candidateActionRules: [{ actionRuleId: 'rule-1', wouldRun: true }],
    });
    expect(staleRepository.isDeadlineEventCurrentForOrder).toHaveBeenCalledWith({
      orderId: 42,
      deadlineId: '11111111-1111-4111-8111-111111111111',
      deadlineEventId: '22222222-2222-4222-8222-222222222222',
    });
    expect(staleRepository.createActionExecution).not.toHaveBeenCalled();
    expect(currentRepository.createActionExecution).not.toHaveBeenCalled();
  });

  it('allows stale transition preview candidates when rule config opts out of current-event enforcement', async () => {
    const repository = createRepository({
      actionRules: [
        transitionRule({
          actionRuleId: 'rule-stale-default',
          config: {
            scope: { type: 'global_orders' },
            conditions: {
              allowedFromOrderStatusIds: [1],
              requireCurrentDeadlineEvent: false,
            },
            actionConfig: { targetOrderStatusId: 7 },
          },
        }),
      ],
      orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
      isCurrentDeadlineEvent: false,
    });

    await expect(
      new DeadlineQueryService({ repository }).previewOrderActionRules({
        currentUser: currentUser(),
        orderId: 42,
        dto: {
          eventType: 'DEADLINE_EXPIRED',
          deadlineId: '11111111-1111-4111-8111-111111111111',
          deadlineEventId: '22222222-2222-4222-8222-222222222222',
        },
      }),
    ).resolves.toMatchObject({
      selectedActionRuleId: 'rule-stale-default',
      candidateActionRules: [
        {
          actionRuleId: 'rule-stale-default',
          wouldRun: true,
          wouldSkipReason: null,
        },
      ],
    });
    expect(repository.isDeadlineEventCurrentForOrder).toHaveBeenCalledWith({
      orderId: 42,
      deadlineId: '11111111-1111-4111-8111-111111111111',
      deadlineEventId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('uses dispatcher-compatible fixture filtering for transition previews', async () => {
    const repository = createRepository({
      actionRules: [
        transitionRule({
          actionRuleId: 'fixture-rule',
          priority: 1,
          config: {
            fixtureKey: 'deadline-canary',
            conditions: { allowedFromOrderStatusIds: [1] },
            actionConfig: { targetOrderStatusId: 8 },
          },
        }),
        transitionRule({ actionRuleId: 'normal-rule', priority: 2 }),
      ],
      orderContext: { orderId: 42, orderStatusId: 1, isCompleted: false },
      isCurrentDeadlineEvent: true,
    });

    await expect(
      new DeadlineQueryService({ repository }).previewOrderActionRules({
        currentUser: currentUser(),
        orderId: 42,
        dto: {
          eventType: 'DEADLINE_EXPIRED',
          deadlineId: '11111111-1111-4111-8111-111111111111',
          deadlineEventId: '22222222-2222-4222-8222-222222222222',
        },
      }),
    ).resolves.toMatchObject({
      selectedActionRuleId: 'normal-rule',
      candidateActionRules: [{ actionRuleId: 'normal-rule', wouldRun: true }],
    });

    await expect(
      new DeadlineQueryService({ repository }).previewOrderActionRules({
        currentUser: currentUser(),
        orderId: 42,
        dto: {
          eventType: 'DEADLINE_EXPIRED',
          deadlineId: '11111111-1111-4111-8111-111111111111',
          deadlineEventId: '22222222-2222-4222-8222-222222222222',
          fixtureKey: 'deadline-canary',
        },
      }),
    ).resolves.toMatchObject({
      selectedActionRuleId: 'fixture-rule',
      candidateActionRules: [
        { actionRuleId: 'fixture-rule', wouldRun: true },
        { actionRuleId: 'normal-rule', wouldRun: false, wouldSkipReason: 'lower_priority_rule_not_selected' },
      ],
    });
  });

  it('requires admin action permission to list global transition rules', async () => {
    const service = new DeadlineQueryService({
      repository: createRepository({ actionRules: [transitionRule()] }),
    });

    await expect(
      service.listGlobalTransitionRules({
        currentUser: currentUser(['deadlines.view']),
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    } satisfies Partial<ApiError>);
  });
});

function currentUser(permissions = getPermissionsForRole('manager')): CurrentUser {
  return {
    id: 'u1',
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions,
  };
}

function createRepository(options: {
  policies?: DeadlinePolicyDto[];
  actionRules?: DeadlineActionRuleDto[];
  overrides?: DeadlineOrderOverrideDto[];
  orderContext?: { orderId: number; orderStatusId: number; isCompleted: boolean };
  isCurrentDeadlineEvent?: boolean;
} = {}): DeadlineRepositoryPort {
  const createActionExecution = vi.fn(
    async () => {
      throw new Error('createActionExecution should not be called');
    },
  );
  const upsertOrderOverride = vi.fn(async () => orderOverride());
  const retireOrderOverride = vi.fn(async () => orderOverride());
  const updateGlobalTransitionRule = vi.fn(async () => transitionRule());
  const isDeadlineEventCurrentForOrder = vi.fn(async () => options.isCurrentDeadlineEvent ?? false);

  return {
    async listDeadlines() {
      return { data: [], total: 0 };
    },
    async getDeadlineById() {
      return null;
    },
    async getDeadlineByIdForUpdate() {
      return null;
    },
    async listOrderDeadlines() {
      return [];
    },
    async listOrderDeadlineEvents() {
      return [];
    },
    async listPolicies() {
      return options.policies ?? [];
    },
    async createPolicy() {
      throw new Error('not implemented');
    },
    async updatePolicy() {
      throw new Error('not implemented');
    },
    async getSettings() {
      throw new Error('not implemented');
    },
    async updateSettings() {
      throw new Error('not implemented');
    },
    async createDeadlineInstance() {
      throw new Error('not implemented');
    },
    async overrideDeadline() {
      throw new Error('not implemented');
    },
    async pauseDeadline() {
      throw new Error('not implemented');
    },
    async resumeDeadline() {
      throw new Error('not implemented');
    },
    async cancelDeadline() {
      throw new Error('not implemented');
    },
    async findDueDeadlinesForUpdate() {
      return [];
    },
    async markDeadlineExpired() {
      throw new Error('not implemented');
    },
    async markDeadlineCompleted() {
      throw new Error('not implemented');
    },
    async createDeadlineEvent() {
      throw new Error('not implemented');
    },
    async listActionRules() {
      return options.actionRules ?? [];
    },
    createActionExecution,
    async listOrderOverrides() {
      return options.overrides ?? [];
    },
    async listOrderActionRuleOverrides() {
      return options.overrides ?? [];
    },
    async listGlobalTransitionRules() {
      return options.actionRules ?? [];
    },
    async getOrderDeadlineEvaluationContext(orderId: number) {
      return options.orderContext ?? { orderId, orderStatusId: 1, isCompleted: false };
    },
    upsertOrderOverride,
    retireOrderOverride,
    updateGlobalTransitionRule,
    isDeadlineEventCurrentForOrder,
  } as DeadlineRepositoryPort;
}

function policy(overrides: Partial<DeadlinePolicyDto> = {}): DeadlinePolicyDto {
  return {
    policyId: 'policy-1',
    policyCode: 'order.final',
    policyName: 'Final order deadline',
    scopeType: 'order',
    targetType: null,
    targetCode: null,
    durationValue: 10,
    durationUnit: 'working_day',
    startPoint: null,
    isEnabled: true,
    createdAt: '2026-05-25T10:00:00.000Z',
    updatedAt: '2026-05-25T10:00:00.000Z',
    ...overrides,
  };
}

function transitionRule(overrides: Partial<DeadlineActionRuleDto> = {}): DeadlineActionRuleDto {
  return {
    actionRuleId: 'rule-1',
    policyId: null,
    scopeType: 'order',
    eventType: 'DEADLINE_EXPIRED',
    actionType: 'change_order_status',
    isEnabled: true,
    priority: 10,
    config: {
      scope: { type: 'global_orders' },
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
}

function orderOverride(overrides: Partial<DeadlineOrderOverrideDto> = {}): DeadlineOrderOverrideDto {
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

function createDeadline(overrides: Partial<DeadlineInstanceDto>): DeadlineInstanceDto {
  return {
    deadlineId: 'deadline',
    entityType: 'order',
    entityId: '42',
    orderId: 42,
    orderWorkshopId: null,
    clientId: null,
    responsibleUserId: null,
    deadlineAt: '2026-05-02T10:00:00.000Z',
    status: 'active',
    source: 'manual',
    isManuallyOverridden: false,
    metadata: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}
