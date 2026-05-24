import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { DeadlineCommandService } from '../application/deadline-command.service';
import type { DeadlineQueryService } from '../application/deadline-query.service';
import {
  DeadlinePoliciesController,
  parseCreateDeadlinePolicyRequest,
  parsePolicyId,
} from './deadline-policies.controller';
import type { DeadlinesRuntimeConfigService } from './deadlines-runtime-config.service';

describe('DeadlinePoliciesController', () => {
  it('uses unversioned controller path so global API_PREFIX publishes /api/v1/deadline-policies', () => {
    expect(Reflect.getMetadata(PATH_METADATA, DeadlinePoliciesController)).toBe('deadline-policies');
  });

  it('fails closed when deadlines are disabled', async () => {
    const controller = createController({
      flags: { deadlinesEnabled: false, deadlinesReadOnly: true },
    });

    await expect(controller.list({ user: currentUser() })).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEADLINES_DISABLED',
    } satisfies Partial<ApiError>);
  });

  it('blocks writes in read-only mode', async () => {
    const controller = createController({
      flags: { deadlinesEnabled: true, deadlinesReadOnly: true },
    });

    await expect(
      controller.create(
        { user: currentUser() },
        {
          policyCode: 'order.final',
          policyName: 'Final order deadline',
          scopeType: 'order',
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEADLINES_READ_ONLY',
    } satisfies Partial<ApiError>);
  });

  it('validates policy request and uuid params', () => {
    expect(
      parseCreateDeadlinePolicyRequest({
        policyCode: 'order.final',
        policyName: 'Final order deadline',
        scopeType: 'order',
        durationValue: 14,
        durationUnit: 'working_day',
      }),
    ).toMatchObject({
      policyCode: 'order.final',
      scopeType: 'order',
      durationValue: 14,
    });
    expect(parsePolicyId('11111111-1111-4111-8111-111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(() => parsePolicyId('not-uuid')).toThrow(ApiError);
    expect(() =>
      parseCreateDeadlinePolicyRequest({
        policyCode: 'x',
        policyName: '',
        scopeType: 'raw',
      }),
    ).toThrow(ApiError);
  });

  it('delegates policy writes in deadline write mode with request id propagation', async () => {
    const calls: string[] = [];
    const controller = createController({
      flags: { deadlinesEnabled: true, deadlinesReadOnly: false },
      commands: {
        async createPolicy(command) {
          calls.push(`create:${command.currentUser.id}:${command.requestId}:${command.dto.policyCode}`);
          return policy();
        },
        async updatePolicy(command) {
          calls.push(`update:${command.currentUser.id}:${command.requestId}:${command.policyId}:${command.dto.policyName}`);
          return policy({ policyName: command.dto.policyName ?? 'Final order deadline' });
        },
      },
    });

    await expect(
      controller.create(
        { user: currentUser(), requestId: 'req-policy-create' },
        {
          policyCode: 'order.final',
          policyName: 'Final order deadline',
          scopeType: 'order',
        },
      ),
    ).resolves.toEqual({ policy: policy() });

    await expect(
      controller.update(
        { user: currentUser(), requestId: 'req-policy-update' },
        '11111111-1111-4111-8111-111111111111',
        { policyName: 'Updated deadline policy' },
      ),
    ).resolves.toEqual({ policy: policy({ policyName: 'Updated deadline policy' }) });

    expect(calls).toEqual([
      'create:admin-id:req-policy-create:order.final',
      'update:admin-id:req-policy-update:11111111-1111-4111-8111-111111111111:Updated deadline policy',
    ]);
  });
});

function createController(options: {
  flags: { deadlinesEnabled: boolean; deadlinesReadOnly: boolean };
  commands?: Partial<DeadlineCommandService>;
  queries?: Partial<DeadlineQueryService>;
}): DeadlinePoliciesController {
  const commands = {
    async createPolicy() {
      throw new Error('createPolicy should not be called');
    },
    async updatePolicy() {
      throw new Error('updatePolicy should not be called');
    },
    ...options.commands,
  } as unknown as DeadlineCommandService;
  const queries = {
    async listPolicies() {
      throw new Error('listPolicies should not be called');
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

  return new DeadlinePoliciesController(commands, queries, runtimeConfig);
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

function policy(overrides: Record<string, unknown> = {}) {
  return {
    policyId: '11111111-1111-4111-8111-111111111111',
    policyCode: 'order.final',
    policyName: 'Final order deadline',
    scopeType: 'order',
    targetType: null,
    targetCode: null,
    durationValue: null,
    durationUnit: null,
    startPoint: null,
    isEnabled: true,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}
