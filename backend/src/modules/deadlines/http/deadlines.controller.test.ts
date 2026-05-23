import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { DeadlineCommandService } from '../application/deadline-command.service';
import type { DeadlineQueryService } from '../application/deadline-query.service';
import type { DeadlineInstanceDto } from '../dto/deadline-instance.dto';
import { DeadlinesController, parseDeadlineId, parseDeadlineListQuery } from './deadlines.controller';
import type { DeadlinesRuntimeConfigService } from './deadlines-runtime-config.service';

describe('DeadlinesController', () => {
  it('does not embed api prefix in controller path; global API_PREFIX supplies /api/v1', () => {
    expect(Reflect.getMetadata(PATH_METADATA, DeadlinesController)).toBe('/');
  });

  it('fails closed when deadlines feature flag is disabled', async () => {
    const controller = createController({
      flags: {
        deadlinesEnabled: false,
        deadlinesReadOnly: true,
      },
    });

    await expect(controller.list({ user: currentUser() }, {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEADLINES_DISABLED',
    } satisfies Partial<ApiError>);
  });

  it('allows reads in read-only mode', async () => {
    const calls: string[] = [];
    const controller = createController({
      flags: {
        deadlinesEnabled: true,
        deadlinesReadOnly: true,
      },
      queries: {
        async list(command) {
          calls.push(`list:${command.query.page}:${command.currentUser.id}`);
          return {
            data: [],
            pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
          };
        },
      },
    });

    await expect(controller.list({ user: currentUser('viewer-id') }, {})).resolves.toEqual({
      data: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
    });
    expect(calls).toEqual(['list:1:viewer-id']);
  });

  it('blocks writes in read-only mode', async () => {
    const controller = createController({
      flags: {
        deadlinesEnabled: true,
        deadlinesReadOnly: true,
      },
    });

    await expect(
      controller.create(
        { user: currentUser() },
        {
          entityType: 'order',
          entityId: '42',
          deadlineAt: '2026-05-02T10:00:00.000Z',
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEADLINES_READ_ONLY',
    } satisfies Partial<ApiError>);
  });

  it('delegates cancel with request id only when write mode is enabled', async () => {
    const calls: string[] = [];
    const deadline = createDeadline({ status: 'cancelled' });
    const controller = createController({
      flags: {
        deadlinesEnabled: true,
        deadlinesReadOnly: false,
      },
      commands: {
        async cancel(command) {
          calls.push(`${command.deadlineId}:${command.currentUser.id}:${command.requestId}:${command.dto.reason}`);
          return deadline;
        },
      },
    });

    await expect(
      controller.cancel(
        { user: currentUser('admin-id'), requestId: 'req-deadline-cancel' },
        '11111111-1111-4111-8111-111111111111',
        { reason: 'Заказ отменен' },
      ),
    ).resolves.toEqual({ deadline });
    expect(calls).toEqual([
      '11111111-1111-4111-8111-111111111111:admin-id:req-deadline-cancel:Заказ отменен',
    ]);
  });

  it('allows pause and resume in write mode and propagates request id', async () => {
    const calls: string[] = [];
    const deadline = createDeadline();
    const controller = createController({
      flags: {
        deadlinesEnabled: true,
        deadlinesReadOnly: false,
      },
      commands: {
        async pause(command) {
          calls.push(
            `pause:${command.deadlineId}:${command.currentUser.id}:${command.requestId}:${command.dto.pauseMode}:${command.dto.pauseReason}:${command.dto.notes}`,
          );
          return { ...deadline, status: 'paused' };
        },
        async resume(command) {
          calls.push(
            `resume:${command.deadlineId}:${command.currentUser.id}:${command.requestId}:${command.dto.notes}`,
          );
          return { ...deadline, status: 'active' };
        },
      },
    });

    const deadlineId = '11111111-1111-4111-8111-111111111111';

    await expect(
      controller.pause(
        { user: currentUser('admin-id'), requestId: 'req-deadline-pause' },
        deadlineId,
        {
          pauseMode: 'pause_without_shift',
          pauseReason: 'Ожидание клиента',
          notes: 'Client confirmed delay',
        },
      ),
    ).resolves.toEqual({ deadline: { ...deadline, status: 'paused' } });

    await expect(
      controller.resume(
        { user: currentUser('admin-id'), requestId: 'req-deadline-resume' },
        deadlineId,
        { notes: 'Client replied' },
      ),
    ).resolves.toEqual({ deadline });

    expect(calls).toEqual([
      'pause:11111111-1111-4111-8111-111111111111:admin-id:req-deadline-pause:pause_without_shift:Ожидание клиента:Client confirmed delay',
      'resume:11111111-1111-4111-8111-111111111111:admin-id:req-deadline-resume:Client replied',
    ]);
  });

  it('allows create and override in write mode and propagates request id', async () => {
    const calls: string[] = [];
    const createdDeadline = createDeadline({
      deadlineId: '22222222-2222-4222-8222-222222222222',
      deadlineAt: '2026-05-02T10:00:00.000Z',
    });
    const overriddenDeadline = createDeadline({
      deadlineId: '33333333-3333-4333-8333-333333333333',
      deadlineAt: '2026-05-03T10:00:00.000Z',
      isManuallyOverridden: true,
    });
    const controller = createController({
      flags: {
        deadlinesEnabled: true,
        deadlinesReadOnly: false,
      },
      commands: {
        async create(command) {
          calls.push(
            `create:${command.currentUser.id}:${command.requestId}:${command.dto.entityType}:${command.dto.entityId}:${command.dto.deadlineAt}:${command.dto.source}`,
          );
          return createdDeadline;
        },
        async override(command) {
          calls.push(
            `override:${command.deadlineId}:${command.currentUser.id}:${command.requestId}:${command.dto.deadlineAt}:${command.dto.reason}`,
          );
          return overriddenDeadline;
        },
      },
    });

    await expect(
      controller.create(
        { user: currentUser('admin-id'), requestId: 'req-deadline-create' },
        {
          entityType: 'order',
          entityId: '42',
          deadlineAt: '2026-05-02T10:00:00.000Z',
        },
      ),
    ).resolves.toEqual({ deadline: createdDeadline });

    await expect(
      controller.override(
        { user: currentUser('admin-id'), requestId: 'req-deadline-override' },
        '11111111-1111-4111-8111-111111111111',
        { deadlineAt: '2026-05-03T10:00:00.000Z', reason: 'Manual correction' },
      ),
    ).resolves.toEqual({ deadline: overriddenDeadline });

    expect(calls).toEqual([
      'create:admin-id:req-deadline-create:order:42:2026-05-02T10:00:00.000Z:manual',
      'override:11111111-1111-4111-8111-111111111111:admin-id:req-deadline-override:2026-05-03T10:00:00.000Z:Manual correction',
    ]);
  });

  it('keeps pause and resume blocked in read-only mode', async () => {
    const calls: string[] = [];
    const controller = createController({
      flags: {
        deadlinesEnabled: true,
        deadlinesReadOnly: true,
      },
      commands: {
        async pause() {
          calls.push('pause');
          return createDeadline({ status: 'paused' });
        },
        async resume() {
          calls.push('resume');
          return createDeadline();
        },
      },
    });

    const deadlineId = '11111111-1111-4111-8111-111111111111';

    await expect(
      controller.pause(
        { user: currentUser('admin-id'), requestId: 'req-read-only-pause' },
        deadlineId,
        { pauseMode: 'pause_without_shift', pauseReason: 'Ожидание клиента' },
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEADLINES_READ_ONLY',
    } satisfies Partial<ApiError>);

    await expect(
      controller.resume(
        { user: currentUser('admin-id'), requestId: 'req-read-only-resume' },
        deadlineId,
        {},
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEADLINES_READ_ONLY',
    } satisfies Partial<ApiError>);

    expect(calls).toEqual([]);
  });

  it('normalizes list query and validates whitelisted values', () => {
    expect(
      parseDeadlineListQuery({
        page: '2',
        pageSize: '50',
        sortBy: 'status',
        sortOrder: 'desc',
        entityType: 'order',
        entityId: '42',
        orderId: '42',
        status: 'active',
        responsibleUserId: '7',
        dateFrom: '2026-05-01',
        dateTo: '2026-05-31',
        onlyOverdue: 'true',
      }),
    ).toEqual({
      page: 2,
      pageSize: 50,
      sortBy: 'status',
      sortOrder: 'desc',
      entityType: 'order',
      entityId: '42',
      orderId: 42,
      status: 'active',
      responsibleUserId: 7,
      dateFrom: '2026-05-01',
      dateTo: '2026-05-31',
      onlyOverdue: true,
    });
    expect(() => parseDeadlineListQuery({ sortBy: 'raw_sql' })).toThrow(ApiError);
    expect(() => parseDeadlineListQuery({ pageSize: '201' })).toThrow(ApiError);
    expect(() => parseDeadlineListQuery({ dateFrom: '01.05.2026' })).toThrow(ApiError);
  });

  it('validates deadline uuid path parameters', () => {
    expect(parseDeadlineId('11111111-1111-4111-8111-111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(() => parseDeadlineId('42')).toThrow(ApiError);
  });
});

function createController(options: {
  flags: { deadlinesEnabled: boolean; deadlinesReadOnly: boolean };
  commands?: Partial<DeadlineCommandService>;
  queries?: Partial<DeadlineQueryService>;
}): DeadlinesController {
  const commands = {
    async create() {
      throw new Error('create should not be called');
    },
    async override() {
      throw new Error('override should not be called');
    },
    async pause() {
      throw new Error('pause should not be called');
    },
    async resume() {
      throw new Error('resume should not be called');
    },
    async cancel() {
      throw new Error('cancel should not be called');
    },
    ...options.commands,
  } as unknown as DeadlineCommandService;
  const queries = {
    async list() {
      throw new Error('list should not be called');
    },
    async getById() {
      throw new Error('getById should not be called');
    },
    async listOrderDeadlines() {
      throw new Error('listOrderDeadlines should not be called');
    },
    async listOrderDeadlineEvents() {
      throw new Error('listOrderDeadlineEvents should not be called');
    },
    async getOrderDeadlineSummary() {
      throw new Error('getOrderDeadlineSummary should not be called');
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

  return new DeadlinesController(commands, queries, runtimeConfig);
}

function currentUser(id = 'admin-id'): CurrentUser {
  return {
    id,
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: getPermissionsForRole('admin'),
  };
}

function createDeadline(overrides: Partial<DeadlineInstanceDto> = {}): DeadlineInstanceDto {
  return {
    deadlineId: '11111111-1111-4111-8111-111111111111',
    entityType: 'order',
    entityId: '42',
    orderId: 42,
    deadlineAt: '2026-05-02T10:00:00.000Z',
    status: 'active',
    source: 'manual',
    isManuallyOverridden: false,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}
