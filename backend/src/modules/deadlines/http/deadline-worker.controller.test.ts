import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { REQUIRED_PERMISSIONS_METADATA_KEY } from '../../../permissions/require-permissions.decorator';
import { DeadlineWorkerController, parseProcessDueNowRequest } from './deadline-worker.controller';
import type { DeadlinesFeatureFlags } from './deadlines-runtime-config.service';

describe('DeadlineWorkerController', () => {
  it('fails closed when deadlines are disabled', async () => {
    const controller = createController({
      flags: flags({ deadlinesEnabled: false }),
    });

    await expect(controller.processDueNow({ user: currentUser() }, {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEADLINES_DISABLED',
    });
  });

  it('fails closed in read-only mode', async () => {
    const controller = createController({
      flags: flags({ deadlinesReadOnly: true }),
    });

    await expect(controller.processDueNow({ user: currentUser() }, {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEADLINES_READ_ONLY',
    });
  });

  it('fails closed when worker manual processing is disabled', async () => {
    const controller = createController({
      flags: flags({ deadlineWorkerEnabled: false }),
    });

    await expect(controller.processDueNow({ user: currentUser() }, {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEADLINE_WORKER_DISABLED',
    });
  });

  it('requires authentication before processing a manual worker batch', async () => {
    const controller = createController();

    await expect(controller.processDueNow({}, {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('requires deadline worker management permission', async () => {
    const controller = createController();

    await expect(
      controller.processDueNow(
        {
          user: {
            ...currentUser(),
            role: 'manager',
            roleId: 10,
            permissions: [],
          },
        },
        {},
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
  });

  it('does not allow superadmin role without explicit worker permission', async () => {
    const controller = createController();

    await expect(
      controller.processDueNow(
        {
          user: {
            ...currentUser(),
            permissions: [],
          },
        },
        {},
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
  });

  it('delegates one manual batch using runtime flags and configured batch cap', async () => {
    const calls: unknown[] = [];
    const controller = createController({
      worker: {
        async processDueDeadlines(command: unknown) {
          calls.push(command);
          return { scanned: 2, processed: 2, expired: 1, completed: 1 };
        },
      },
      flags: flags({
        deadlineWorkerBatchSize: 25,
        deadlineWorkerId: 'worker-acceptance',
        deadlineActionsEnabled: false,
        deadlineNotificationsEnabled: false,
      }),
    });

    await expect(
      controller.processDueNow(
        { user: currentUser() },
        {
          now: '2026-05-21T10:00:00.000Z',
          limit: 100,
          deadlineId: '11111111-1111-4111-8111-111111111111',
        },
      ),
    ).resolves.toEqual({ scanned: 2, processed: 2, expired: 1, completed: 1 });

    expect(calls).toEqual([
      {
        now: '2026-05-21T10:00:00.000Z',
        limit: 25,
        workerId: 'worker-acceptance',
        deadlineId: '11111111-1111-4111-8111-111111111111',
        trigger: 'manual',
        actorUserId: '42',
        requestId: undefined,
        config: {
          actionsEnabled: false,
          notificationsEnabled: false,
          engineOwnsDeadline: undefined,
        },
      },
    ]);
  });

  it('passes enabled action and notification flags to the manual worker batch', async () => {
    const calls: unknown[] = [];
    const controller = createController({
      worker: {
        async processDueDeadlines(command: unknown) {
          calls.push(command);
          return { scanned: 1, processed: 1, expired: 1, completed: 0 };
        },
      },
      flags: flags({
        deadlineActionsEnabled: true,
        deadlineNotificationsEnabled: true,
      }),
    });

    await controller.processDueNow({ user: currentUser(), requestId: 'req-flags' }, {});

    expect(calls[0]).toMatchObject({
      requestId: 'req-flags',
      config: {
        actionsEnabled: true,
        notificationsEnabled: true,
      },
    });
  });

  it('uses current time and configured batch size when request body is empty', async () => {
    const calls: Array<{ now: string; limit: number }> = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T11:00:00.000Z'));
    const controller = createController({
      worker: {
        async processDueDeadlines(command: { now: string; limit: number }) {
          calls.push(command);
          return { scanned: 0, processed: 0, expired: 0, completed: 0 };
        },
      },
      flags: flags({ deadlineWorkerBatchSize: 10 }),
    });

    try {
      await controller.processDueNow({ user: currentUser() }, {});
    } finally {
      vi.useRealTimers();
    }

    expect(calls[0]).toMatchObject({
      now: '2026-05-21T11:00:00.000Z',
      limit: 10,
    });
  });

  it('uses defaults when request body is omitted', async () => {
    const calls: Array<{ now: string; limit: number }> = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T12:00:00.000Z'));
    const controller = createController({
      worker: {
        async processDueDeadlines(command: { now: string; limit: number }) {
          calls.push(command);
          return { scanned: 0, processed: 0, expired: 0, completed: 0 };
        },
      },
      flags: flags({ deadlineWorkerBatchSize: 11 }),
    });

    try {
      await controller.processDueNow({ user: currentUser() }, undefined);
    } finally {
      vi.useRealTimers();
    }

    expect(calls[0]).toMatchObject({
      now: '2026-05-21T12:00:00.000Z',
      limit: 11,
    });
  });

  it('validates manual worker request body at runtime', () => {
    expect(() => parseProcessDueNowRequest({ now: 'not-a-date' })).toThrow(
      /Deadline worker request validation failed/,
    );
    expect(() => parseProcessDueNowRequest({ limit: 0 })).toThrow(
      /Deadline worker request validation failed/,
    );
    expect(parseProcessDueNowRequest({ limit: 5 })).toEqual({ limit: 5 });
  });

  it('rejects scheduled processing when scheduler owner is none', async () => {
    const controller = createController({
      flags: flags({ deadlineWorkerSchedulerOwner: 'none' }),
    });

    await expect(
      controller.processDueScheduled(
        { user: currentUser({ permissions: ['deadlines.worker.schedule'] }) },
        {},
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEADLINE_WORKER_SCHEDULER_OWNER_MISMATCH',
    });
  });

  it('rejects scheduled processing when scheduler owner is in_process', async () => {
    const controller = createController({
      flags: flags({ deadlineWorkerSchedulerOwner: 'in_process' }),
    });

    await expect(
      controller.processDueScheduled(
        { user: currentUser({ permissions: ['deadlines.worker.schedule'] }) },
        {},
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEADLINE_WORKER_SCHEDULER_OWNER_MISMATCH',
    });
  });

  it('delegates scheduled processing for external scheduler owner', async () => {
    const calls: unknown[] = [];
    const controller = createController({
      worker: {
        async processDueDeadlines(command: unknown) {
          calls.push(command);
          return { scanned: 3, processed: 2, expired: 1, completed: 1 };
        },
      },
      flags: flags({
        deadlineWorkerSchedulerOwner: 'external',
        deadlineWorkerBatchSize: 20,
        deadlineWorkerId: 'worker-scheduled',
        deadlineActionsEnabled: true,
        deadlineNotificationsEnabled: false,
      }),
    });

    await expect(
      controller.processDueScheduled(
        {
          user: currentUser({ permissions: ['deadlines.worker.schedule'] }),
          requestId: 'req-scheduler-1',
        },
        {
          now: '2026-05-21T13:00:00.000Z',
          limit: 99,
        },
      ),
    ).resolves.toEqual({ scanned: 3, processed: 2, expired: 1, completed: 1 });

    expect(calls).toEqual([
      {
        now: '2026-05-21T13:00:00.000Z',
        limit: 20,
        workerId: 'worker-scheduled',
        trigger: 'scheduler',
        schedulerRunId: 'deadline-worker-scheduled-req-scheduler-1',
        actorUserId: '42',
        requestId: 'req-scheduler-1',
        config: {
          actionsEnabled: true,
          notificationsEnabled: false,
        },
      },
    ]);
  });

  it('rejects scheduled processing without scheduled worker permission even with manual worker permission', async () => {
    const calls: unknown[] = [];
    const controller = createController({
      worker: {
        async processDueDeadlines(command: unknown) {
          calls.push(command);
          return { scanned: 0, processed: 0, expired: 0, completed: 0 };
        },
      },
      flags: flags({ deadlineWorkerSchedulerOwner: 'external' }),
    });

    await expect(
      controller.processDueScheduled(
        { user: currentUser({ permissions: ['deadlines.worker.manage'] }) },
        {},
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(calls).toEqual([]);
  });

  it('requires scheduled worker permission metadata without manual worker manage permission', async () => {
    const controller = createController({
      flags: flags({ deadlineWorkerSchedulerOwner: 'external' }),
    });

    const requiredPermissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_METADATA_KEY,
      DeadlineWorkerController.prototype.processDueScheduled,
    );

    expect(requiredPermissions).toEqual(['deadlines.worker.schedule']);
    await expect(
      controller.processDueScheduled(
        { user: currentUser({ permissions: ['deadlines.worker.schedule'] }) },
        {},
      ),
    ).resolves.toEqual({ scanned: 0, processed: 0, expired: 0, completed: 0 });
  });
});

function createController(overrides: {
  flags?: DeadlinesFeatureFlags;
  worker?: { processDueDeadlines(command: unknown): Promise<unknown> };
} = {}) {
  return new DeadlineWorkerController(
    (overrides.worker ?? {
      async processDueDeadlines() {
        return { scanned: 0, processed: 0, expired: 0, completed: 0 };
      },
    }) as never,
    {
      getFeatureFlags: () => overrides.flags ?? flags(),
    } as never,
  );
}

function flags(overrides: Partial<DeadlinesFeatureFlags> = {}): DeadlinesFeatureFlags {
  return {
    deadlinesEnabled: true,
    deadlinesReadOnly: false,
    deadlineWorkerEnabled: true,
    deadlineActionsEnabled: false,
    deadlineNotificationsEnabled: false,
    deadlineWorkerPollIntervalMs: 60000,
    deadlineWorkerBatchSize: 100,
    deadlineWorkerId: 'backend-local',
    deadlineWorkerSchedulerOwner: 'none',
    ...overrides,
  };
}

function currentUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: '42',
    username: 'superadmin',
    role: 'superadmin',
    roleId: 2,
    permissions: ['deadlines.worker.manage'],
    ...overrides,
  };
}
