import { describe, expect, it, vi } from 'vitest';
import { DeadlineWorkerSchedulerService } from './deadline-worker-scheduler.service';
import type { DeadlinesFeatureFlags } from '../http/deadlines-runtime-config.service';

describe('DeadlineWorkerSchedulerService', () => {
  it('does not start interval when owner is none', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const scheduler = createScheduler({
      flags: flags({ deadlineWorkerSchedulerOwner: 'none' }),
    });

    try {
      scheduler.onModuleInit();
    } finally {
      setIntervalSpy.mockRestore();
    }

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('does not start interval when owner is external', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const scheduler = createScheduler({
      flags: flags({ deadlineWorkerSchedulerOwner: 'external' }),
    });

    try {
      scheduler.onModuleInit();
    } finally {
      setIntervalSpy.mockRestore();
    }

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('runs one scheduler tick with configured worker command when owner is in_process', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T10:00:00.000Z'));
    const worker = {
      processDueDeadlines: vi.fn().mockResolvedValue({
        scanned: 3,
        processed: 2,
        expired: 1,
        completed: 1,
      }),
    };
    const logger = createLogger();
    const scheduler = createScheduler({
      worker,
      logger,
      flags: flags({
        deadlineWorkerSchedulerOwner: 'in_process',
        deadlineWorkerBatchSize: 25,
        deadlineWorkerId: 'scheduler-worker',
        deadlineActionsEnabled: true,
        deadlineNotificationsEnabled: false,
      }),
    });

    try {
      await scheduler.runTick();
    } finally {
      vi.useRealTimers();
    }

    const command = worker.processDueDeadlines.mock.calls[0][0];
    expect(command).toMatchObject({
      now: '2026-05-22T10:00:00.000Z',
      limit: 25,
      workerId: 'scheduler-worker',
      trigger: 'scheduler',
      config: {
        actionsEnabled: true,
        notificationsEnabled: false,
      },
    });
    expect(command.requestId).toMatch(/^deadline-worker-scheduler-/);
    expect(command.schedulerRunId).toBe(command.requestId);
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'deadline_worker_batch_finished',
        trigger: 'scheduler',
        workerId: 'scheduler-worker',
        requestId: command.requestId,
        schedulerOwner: 'in_process',
        actionsEnabled: true,
        notificationsEnabled: false,
        limit: 25,
        scanned: 3,
        processed: 2,
        expired: 1,
        completed: 1,
        status: 'ok',
        durationMs: expect.any(Number),
      }),
    );
  });

  it('logs failed scheduler ticks without throwing', async () => {
    const failure = new Error('database unavailable');
    const logger = createLogger();
    const scheduler = createScheduler({
      logger,
      worker: {
        processDueDeadlines: vi.fn().mockRejectedValue(failure),
      },
      flags: flags({ deadlineWorkerSchedulerOwner: 'in_process' }),
    });

    await expect(scheduler.runTick()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'deadline_worker_scheduler_tick_failed',
        trigger: 'scheduler',
        schedulerOwner: 'in_process',
        status: 'failed',
        errorMessage: 'database unavailable',
        durationMs: expect.any(Number),
      }),
    );
  });

  it('redacts sensitive scheduler log payloads before writing to the Nest logger sink', async () => {
    const logger = createLogger();
    const scheduler = createScheduler({
      logger,
      worker: {
        processDueDeadlines: vi.fn().mockRejectedValue(
          new Error('Authorization: Bearer abc.def.ghi access_token=token123'),
        ),
      },
      flags: flags({
        deadlineWorkerSchedulerOwner: 'in_process',
        deadlineWorkerId: 'worker-token-secret',
      }),
    });

    await scheduler.runTick();

    const loggedPayload = logger.error.mock.calls[0][0];
    expect(loggedPayload).toMatchObject({
      workerId: 'worker-token-secret',
      errorMessage: 'Authorization: Bearer [REDACTED] access_token=[REDACTED]',
    });
    expect(JSON.stringify(loggedPayload)).not.toContain('abc.def.ghi');
    expect(JSON.stringify(loggedPayload)).not.toContain('token123');
  });

  it('clears the interval on module destroy', () => {
    const interval = 12345 as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(interval);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const scheduler = createScheduler({
      flags: flags({ deadlineWorkerSchedulerOwner: 'in_process' }),
    });

    try {
      scheduler.onModuleInit();
      scheduler.onModuleDestroy();
      expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('starts only one interval when module init runs more than once', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      12345 as unknown as ReturnType<typeof setInterval>,
    );
    const scheduler = createScheduler({
      flags: flags({ deadlineWorkerSchedulerOwner: 'in_process' }),
    });

    try {
      scheduler.onModuleInit();
      scheduler.onModuleInit();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});

function createScheduler(overrides: {
  flags?: DeadlinesFeatureFlags;
  worker?: { processDueDeadlines(command: unknown): Promise<unknown> };
  logger?: { log(message: unknown): void; error(message: unknown): void };
} = {}) {
  return new DeadlineWorkerSchedulerService(
    (overrides.worker ?? {
      async processDueDeadlines() {
        return { scanned: 0, processed: 0, expired: 0, completed: 0 };
      },
    }) as never,
    {
      getFeatureFlags: () => overrides.flags ?? flags(),
    } as never,
    overrides.logger ?? createLogger(),
  );
}

function createLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}

function flags(overrides: Partial<DeadlinesFeatureFlags> = {}): DeadlinesFeatureFlags {
  return {
    deadlinesEnabled: true,
    deadlinesReadOnly: false,
    deadlineWorkerEnabled: true,
    deadlineWorkerSchedulerOwner: 'none',
    deadlineActionsEnabled: false,
    deadlineNotificationsEnabled: false,
    deadlineWorkerPollIntervalMs: 60000,
    deadlineWorkerBatchSize: 100,
    deadlineWorkerId: 'backend-local',
    ...overrides,
  };
}
