import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
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
        },
      ),
    ).resolves.toEqual({ scanned: 2, processed: 2, expired: 1, completed: 1 });

    expect(calls).toEqual([
      {
        now: '2026-05-21T10:00:00.000Z',
        limit: 25,
        workerId: 'worker-acceptance',
        trigger: 'manual',
        actorUserId: '42',
        requestId: undefined,
        config: {
          actionsEnabled: false,
          notificationsEnabled: false,
        },
      },
    ]);
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
