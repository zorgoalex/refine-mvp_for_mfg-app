import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { DeadlineCommandService } from '../application/deadline-command.service';
import type { DeadlineQueryService } from '../application/deadline-query.service';
import {
  DeadlineRulesController,
  parseDeadlineActionRuleId,
  parseOrderDeadlineActionPreviewRequest,
  parseRetireDeadlineOrderOverrideRequest,
  parseUpdateGlobalTransitionRuleRequest,
  parseUpsertDeadlineOrderOverrideRequest,
} from './deadline-rules.controller';
import type { DeadlinesRuntimeConfigService } from './deadlines-runtime-config.service';

describe('DeadlineRulesController', () => {
  it('uses an unversioned root path so global API_PREFIX publishes order/admin rule APIs', () => {
    expect(Reflect.getMetadata(PATH_METADATA, DeadlineRulesController)).toBe('');
  });

  it('allows effective rule reads in read-only mode and blocks override writes', async () => {
    const controller = createController({
      flags: { deadlinesEnabled: true, deadlinesReadOnly: true },
      queries: {
        async listOrderEffectiveRules(command) {
          return { orderId: command.orderId, policies: [], actionRules: [], overrides: [] };
        },
      },
    });

    await expect(controller.listOrderEffectiveRules({ user: currentUser() }, '42')).resolves.toEqual({
      orderId: 42,
      policies: [],
      actionRules: [],
      overrides: [],
    });
    await expect(
      controller.upsertOrderOverride({ user: currentUser() }, '42', {
        targetType: 'action_rule',
        actionRuleId: '11111111-1111-4111-8111-111111111111',
        isDisabled: true,
        reason: 'Pause automation for exception',
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEADLINES_READ_ONLY',
    } satisfies Partial<ApiError>);
  });

  it('delegates preview and write APIs with parsed ids and request id propagation', async () => {
    const calls: string[] = [];
    const controller = createController({
      flags: { deadlinesEnabled: true, deadlinesReadOnly: false },
      queries: {
        async previewOrderActionRules(command) {
          calls.push(`preview:${command.currentUser.id}:${command.orderId}:${command.dto.eventType}`);
          return {
            orderId: command.orderId,
            eventType: command.dto.eventType,
            candidateActionRules: [],
            selectedActionRuleId: null,
            selectionReason: 'no_applicable_rules',
          };
        },
        async listGlobalTransitionRules(command) {
          calls.push(`listGlobal:${command.currentUser.id}`);
          return { data: [] };
        },
      },
      commands: {
        async upsertOrderOverride(command) {
          calls.push(`upsert:${command.currentUser.id}:${command.requestId}:${command.dto.orderId}:${command.dto.reason}`);
          return { override: orderOverride({ orderId: command.dto.orderId, reason: command.dto.reason }) };
        },
        async retireOrderOverride(command) {
          calls.push(`retire:${command.currentUser.id}:${command.requestId}:${command.orderId}:${command.overrideId}:${command.reason}`);
          return { override: orderOverride({ retiredAt: '2026-05-25T10:00:00.000Z' }) };
        },
        async updateGlobalTransitionRule(command) {
          calls.push(`updateGlobal:${command.currentUser.id}:${command.requestId}:${command.actionRuleId}:${command.dto.reason}`);
          return { rule: actionRule({ actionRuleId: command.actionRuleId }) };
        },
      },
    });

    await controller.previewOrderActionRules({ user: currentUser() }, '42', {
      eventType: 'DEADLINE_EXPIRED',
    });
    await controller.listGlobalTransitionRules({ user: currentUser() });
    await controller.upsertOrderOverride({ user: currentUser(), requestId: 'req-upsert' }, '42', {
      targetType: 'action_rule',
      actionRuleId: '11111111-1111-4111-8111-111111111111',
      isDisabled: true,
      reason: 'Manual customer exception',
    });
    await controller.retireOrderOverride(
      { user: currentUser(), requestId: 'req-retire' },
      '42',
      '22222222-2222-4222-8222-222222222222',
      { reason: 'Exception cleared' },
    );
    await controller.updateGlobalTransitionRule(
      { user: currentUser(), requestId: 'req-global' },
      '33333333-3333-4333-8333-333333333333',
      transitionRulePatch(),
    );

    expect(calls).toEqual([
      'preview:admin-id:42:DEADLINE_EXPIRED',
      'listGlobal:admin-id',
      'upsert:admin-id:req-upsert:42:Manual customer exception',
      'retire:admin-id:req-retire:42:22222222-2222-4222-8222-222222222222:Exception cleared',
      'updateGlobal:admin-id:req-global:33333333-3333-4333-8333-333333333333:Change escalation target',
    ]);
  });

  it('validates rule ids, override targets, preview event and required audit reasons', () => {
    expect(parseDeadlineActionRuleId('11111111-1111-4111-8111-111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(
      parseUpsertDeadlineOrderOverrideRequest(42, {
        targetType: 'policy',
        policyId: '11111111-1111-4111-8111-111111111111',
        isDisabled: true,
        reason: 'Disable timer for customer hold',
      }),
    ).toMatchObject({
      orderId: 42,
      targetType: 'policy',
      policyId: '11111111-1111-4111-8111-111111111111',
      reason: 'Disable timer for customer hold',
    });
    expect(parseOrderDeadlineActionPreviewRequest({})).toEqual({
      eventType: 'DEADLINE_EXPIRED',
    });
    expect(parseOrderDeadlineActionPreviewRequest({ fixtureKey: 'deadline-canary' })).toEqual({
      eventType: 'DEADLINE_EXPIRED',
      fixtureKey: 'deadline-canary',
    });
    expect(() => parseOrderDeadlineActionPreviewRequest({ fixtureKey: '' })).toThrow(ApiError);
    expect(() =>
      parseUpsertDeadlineOrderOverrideRequest(42, {
        targetType: 'action_rule',
        actionRuleId: '11111111-1111-4111-8111-111111111111',
        isDisabled: true,
      }),
    ).toThrow(ApiError);
    expect(() => parseRetireDeadlineOrderOverrideRequest({ reason: '' })).toThrow(ApiError);
    expect(() =>
      parseUpdateGlobalTransitionRuleRequest({
        enabled: true,
        priority: 10,
        targetOrderStatusId: 7,
        allowedFromOrderStatusIds: [],
        reason: 'Missing allowed statuses',
      }),
    ).toThrow(ApiError);
  });
});

function createController(options: {
  flags: { deadlinesEnabled: boolean; deadlinesReadOnly: boolean };
  commands?: Partial<DeadlineCommandService>;
  queries?: Partial<DeadlineQueryService>;
}): DeadlineRulesController {
  const commands = {
    async upsertOrderOverride() {
      throw new Error('upsertOrderOverride should not be called');
    },
    async retireOrderOverride() {
      throw new Error('retireOrderOverride should not be called');
    },
    async updateGlobalTransitionRule() {
      throw new Error('updateGlobalTransitionRule should not be called');
    },
    ...options.commands,
  } as unknown as DeadlineCommandService;
  const queries = {
    async listOrderEffectiveRules() {
      throw new Error('listOrderEffectiveRules should not be called');
    },
    async previewOrderActionRules() {
      throw new Error('previewOrderActionRules should not be called');
    },
    async listGlobalTransitionRules() {
      throw new Error('listGlobalTransitionRules should not be called');
    },
    ...options.queries,
  } as unknown as DeadlineQueryService;
  const runtimeConfig = {
    getFeatureFlags() {
      return {
        ...options.flags,
        deadlineWorkerEnabled: false,
        deadlineActionsEnabled: false,
        deadlineNotificationsEnabled: false,
        deadlineWorkerPollIntervalMs: 60000,
        deadlineWorkerBatchSize: 100,
        deadlineWorkerId: 'backend-local',
      };
    },
  } as DeadlinesRuntimeConfigService;

  return new DeadlineRulesController(commands, queries, runtimeConfig);
}

function currentUser(): CurrentUser {
  return {
    id: 'admin-id',
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: getPermissionsForRole('admin'),
  };
}

function transitionRulePatch() {
  return {
    enabled: true,
    priority: 10,
    eventType: 'DEADLINE_EXPIRED',
    actionType: 'change_order_status',
    targetOrderStatusId: 7,
    allowedFromOrderStatusIds: [1, 2],
    excludeOrderStatusIds: [8],
    excludeCompletedOrders: true,
    requireCurrentDeadlineEvent: true,
    reason: 'Change escalation target',
  };
}

function actionRule(overrides: Record<string, unknown> = {}) {
  return {
    actionRuleId: '33333333-3333-4333-8333-333333333333',
    policyId: null,
    scopeType: 'order',
    eventType: 'DEADLINE_EXPIRED',
    actionType: 'change_order_status',
    isEnabled: true,
    priority: 10,
    config: {
      scope: { type: 'global_orders' },
      conditions: { allowedFromOrderStatusIds: [1, 2] },
      actionConfig: { targetOrderStatusId: 7 },
    },
    createdAt: '2026-05-25T10:00:00.000Z',
    updatedAt: '2026-05-25T10:00:00.000Z',
    ...overrides,
  };
}

function orderOverride(overrides: Record<string, unknown> = {}) {
  return {
    overrideId: '22222222-2222-4222-8222-222222222222',
    orderId: 42,
    targetType: 'action_rule',
    policyId: null,
    actionRuleId: '11111111-1111-4111-8111-111111111111',
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
