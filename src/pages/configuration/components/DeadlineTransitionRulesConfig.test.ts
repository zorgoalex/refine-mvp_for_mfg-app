import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  DeadlineActionRuleDto,
  DeadlinePolicyDto,
  DeadlineTransitionRulesReadinessDto,
} from '../../../api/types/deadlineApi.types';
import { ReadinessAlert } from './DeadlineTransitionRulesConfig';
import {
  applyDeadlineTargetOption,
  buildDeadlineTargetOptions,
  buildTransitionRuleCreatePayload,
  buildTransitionRuleDraft,
  buildTransitionRuleUpdatePayload,
  canManageDeadlineTransitionRules,
  describeRuleScope,
  describeTransition,
  emptyTransitionRuleDraft,
  getDeadlineTargetOptionValue,
} from './deadlineTransitionRulesView';

const actionRuleId = '11111111-1111-4111-8111-111111111111';

describe('deadlineTransitionRulesView', () => {
  it('matches backend permissions for managing transition rules', () => {
    expect(canManageDeadlineTransitionRules({ permissions: ['deadlines.actions.manage'] })).toBe(true);
    expect(canManageDeadlineTransitionRules({ permissions: ['settings.manage'] })).toBe(false);
    expect(canManageDeadlineTransitionRules({ permissions: [] })).toBe(false);
  });

  it('builds named drafts with policy and status arrays', () => {
    expect(buildTransitionRuleDraft(rule())).toEqual({
      ruleName: 'Просрочена выдача',
      ruleCode: 'overdue-issue',
      policyId: '22222222-2222-4222-8222-222222222222',
      deadlineTarget: { type: 'all_order_deadlines' },
      isEnabled: true,
      priority: 10,
      targetOrderStatusId: 7,
      allowedFromOrderStatusIds: [1, 2],
      excludeOrderStatusIds: [9],
      excludeCompletedOrders: true,
      requireCurrentDeadlineEvent: true,
    });
    const legacyUnsafe = rule();
    legacyUnsafe.config = {
      ...legacyUnsafe.config,
      conditions: {
        ...legacyUnsafe.config?.conditions,
        excludeCompletedOrders: false,
        requireCurrentDeadlineEvent: false,
      },
    };
    expect(buildTransitionRuleDraft(legacyUnsafe)).toMatchObject({
      excludeCompletedOrders: true,
      requireCurrentDeadlineEvent: true,
    });
  });

  it('builds complete create and stale-safe update payloads', () => {
    const draft = {
      ...emptyTransitionRuleDraft(),
      ruleName: '  Просрочена выдача  ',
      ruleCode: ' overdue-issue ',
      policyId: '22222222-2222-4222-8222-222222222222',
      isEnabled: true,
      priority: 25,
      targetOrderStatusId: 8,
      allowedFromOrderStatusIds: [1, 2],
      excludeOrderStatusIds: [9, 10],
    };

    expect(buildTransitionRuleCreatePayload(draft, ' Ops approved ', ' Ticket OPS-42 ')).toEqual({
      ruleName: 'Просрочена выдача',
      ruleCode: 'overdue-issue',
      policyId: draft.policyId,
      deadlineTarget: { type: 'all_order_deadlines' },
      isEnabled: true,
      priority: 25,
      eventType: 'DEADLINE_EXPIRED',
      actionType: 'change_order_status',
      targetOrderStatusId: 8,
      allowedFromOrderStatusIds: [1, 2],
      excludeOrderStatusIds: [9, 10],
      excludeCompletedOrders: true,
      requireCurrentDeadlineEvent: true,
      reason: 'Ops approved',
      comment: 'Ticket OPS-42',
    });
    expect(
      buildTransitionRuleUpdatePayload(
        rule({ updatedAt: '2026-06-14T00:00:00.000Z' }),
        draft,
        'Ops approved',
      ),
    ).toMatchObject({
      expectedUpdatedAt: '2026-06-14T00:00:00.000Z',
      ruleName: 'Просрочена выдача',
      isEnabled: true,
      targetOrderStatusId: 8,
    });
  });

  it('renders named scope and transition labels', () => {
    const policies = [policy()];
    expect(describeRuleScope(rule(), policies)).toBe('Финальная выдача');
    expect(
      describeTransition(rule(), {
        statusNames: new Map([[1, 'Новый'], [2, 'Оформлен'], [7, 'Просрочен']]),
        policyNames: new Map(),
      }),
    ).toBe('Новый, Оформлен → Просрочен');
    expect(describeRuleScope(rule({ policyId: null }), policies)).toBe('Все дедлайны заказа');
    const stageRule = rule({ policyId: null });
    stageRule.config = {
      ...stageRule.config,
      deadlineTarget: { type: 'production_stage', productionStatusId: 4 },
    };
    expect(
      describeRuleScope(
        stageRule,
        policies,
        new Map([[4, 'Распилен']]),
      ),
    ).toBe('Этап: Распилен');
  });

  it('maps final, production-stage, global and legacy-policy selector values', () => {
    const initial = emptyTransitionRuleDraft();
    const finalOrder = applyDeadlineTargetOption(initial, 'final_order');
    expect(getDeadlineTargetOptionValue(finalOrder)).toBe('final_order');
    expect(finalOrder).toMatchObject({
      policyId: null,
      deadlineTarget: { type: 'final_order' },
    });

    const stage = applyDeadlineTargetOption(finalOrder, 'production_stage:4');
    expect(getDeadlineTargetOptionValue(stage)).toBe('production_stage:4');
    expect(stage.deadlineTarget).toEqual({
      type: 'production_stage',
      productionStatusId: 4,
    });

    const policy = applyDeadlineTargetOption(
      stage,
      'policy:22222222-2222-4222-8222-222222222222',
    );
    expect(policy).toMatchObject({
      policyId: '22222222-2222-4222-8222-222222222222',
      deadlineTarget: { type: 'all_order_deadlines' },
    });
    expect(getDeadlineTargetOptionValue(policy)).toBe(
      'policy:22222222-2222-4222-8222-222222222222',
    );

    expect(applyDeadlineTargetOption(policy, 'all_order_deadlines')).toMatchObject({
      policyId: null,
      deadlineTarget: { type: 'all_order_deadlines' },
    });
  });

  it('builds selector options from configured production-stage durations', () => {
    expect(
      buildDeadlineTargetOptions(
        {
          configured: true,
          hasStoredConfiguration: true,
          version: 2,
          reserveDays: 0,
          transitionsOrder: {},
          totalProductionDays: 3,
          plannedOrderDays: 3,
          updatedAt: '2026-07-26T00:00:00.000Z',
          stages: [
            {
              productionStatusId: 4,
              productionStatusName: 'Распилен',
              productionStatusCode: 'cut',
              sortOrder: 4,
              durationDays: 3,
              parallelWithPrevious: false,
              cumulativeDeadlineDays: 3,
            },
            {
              productionStatusId: 5,
              productionStatusName: 'Не настроен',
              productionStatusCode: 'unset',
              sortOrder: 5,
              durationDays: null,
              parallelWithPrevious: false,
              cumulativeDeadlineDays: null,
            },
          ],
        },
        [],
      ),
    ).toEqual([
      { value: 'all_order_deadlines', label: 'Все дедлайны заказа' },
      { value: 'final_order', label: 'Финальный дедлайн заказа' },
      { value: 'production_stage:4', label: 'Этап: Распилен' },
    ]);
  });

  it('rejects unsafe or incomplete drafts', () => {
    expect(() =>
      buildTransitionRuleCreatePayload(
        { ...emptyTransitionRuleDraft(), ruleName: 'Rule', targetOrderStatusId: 7 },
        'Reason',
      ),
    ).toThrow('Выберите хотя бы один исходный статус');
    expect(() =>
      buildTransitionRuleCreatePayload(
        {
          ...emptyTransitionRuleDraft(),
          ruleName: 'Rule',
          targetOrderStatusId: 7,
          allowedFromOrderStatusIds: [7],
        },
        'Reason',
      ),
    ).toThrow('Целевой статус должен отличаться от исходных');
    expect(() =>
      buildTransitionRuleCreatePayload(
        {
          ...emptyTransitionRuleDraft(),
          ruleName: 'Rule',
          targetOrderStatusId: 7,
          allowedFromOrderStatusIds: [1],
          excludeOrderStatusIds: [1],
        },
        'Reason',
      ),
    ).toThrow('Исходные и исключённые статусы не должны пересекаться');
    expect(() =>
      buildTransitionRuleCreatePayload(
        {
          ...emptyTransitionRuleDraft(),
          ruleName: 'Rule',
          targetOrderStatusId: 7,
          allowedFromOrderStatusIds: [1],
          excludeOrderStatusIds: [7],
        },
        'Reason',
      ),
    ).toThrow('Целевой статус не должен быть исключён');
  });

  it.each([
    {
      expected: 'Автоматическое выполнение настроено',
      readiness: readiness({ inProcessAutomaticReady: true }),
    },
    {
      expected: 'Выбран внешний планировщик',
      readiness: readiness({
        schedulerOwner: 'external',
        manualMutationReady: true,
        externalSchedulerOwnerSelected: true,
      }),
    },
    {
      expected: 'изменение статусов глобально выключено',
      readiness: readiness(),
    },
  ])('renders readiness state: $expected', ({ expected, readiness: value }) => {
    expect(renderToString(createElement(ReadinessAlert, { readiness: value }))).toContain(expected);
  });
});

function readiness(
  overrides: Partial<DeadlineTransitionRulesReadinessDto> = {},
): DeadlineTransitionRulesReadinessDto {
  return {
    deadlinesEnabled: true,
    deadlinesReadOnly: false,
    workerEnabled: true,
    actionsEnabled: false,
    schedulerOwner: 'none',
    manualMutationReady: false,
    inProcessAutomaticReady: false,
    externalSchedulerOwnerSelected: false,
    automaticExecutionConfigured: false,
    ...overrides,
  };
}

function rule(overrides: Partial<DeadlineActionRuleDto> = {}): DeadlineActionRuleDto {
  return {
    actionRuleId,
    policyId: '22222222-2222-4222-8222-222222222222',
    scopeType: 'order',
    eventType: 'DEADLINE_EXPIRED',
    actionType: 'change_order_status',
    isEnabled: true,
    priority: 10,
    config: {
      ruleName: 'Просрочена выдача',
      ruleCode: 'overdue-issue',
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

function policy(): DeadlinePolicyDto {
  return {
    policyId: '22222222-2222-4222-8222-222222222222',
    policyCode: 'order.final',
    policyName: 'Финальная выдача',
    scopeType: 'order',
    isEnabled: true,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
  };
}
