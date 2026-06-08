import { describe, expect, it, vi } from 'vitest';
import { OutboxRelaySchedulerService } from './outbox-relay-scheduler.service';
import type { NotificationsFeatureFlags } from '../http/notifications-runtime-config.service';
import type { OutboxRelaySummary } from './outbox-relay.service';

describe('OutboxRelaySchedulerService', () => {
  it('does not start interval when owner is none', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const scheduler = createScheduler({
      flags: flags({ relayOwner: 'none' }),
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
      flags: flags({ relayOwner: 'external' }),
    });

    try {
      scheduler.onModuleInit();
    } finally {
      setIntervalSpy.mockRestore();
    }

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('does not start interval when the engine is disabled even if owner is in_process', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const scheduler = createScheduler({
      flags: flags({ engineEnabled: false, relayOwner: 'in_process' }),
    });

    try {
      scheduler.onModuleInit();
    } finally {
      setIntervalSpy.mockRestore();
    }

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('starts an interval and runs ticks against the relay when owner is in_process', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(
      12345 as unknown as ReturnType<typeof setInterval>,
    );
    const relay = createRelay({
      processBatchOnce: vi.fn().mockResolvedValue({ claimed: 2, processed: 2, failed: 0 }),
    });
    const logger = createLogger();
    const scheduler = createScheduler({
      relay,
      logger,
      flags: flags({ relayOwner: 'in_process', relayPollIntervalMs: 5000 }),
    });

    try {
      scheduler.onModuleInit();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);

      await scheduler.runTick();
    } finally {
      setIntervalSpy.mockRestore();
    }

    expect(relay.processBatchOnce).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'outbox_relay_batch_finished',
        claimed: 2,
        processed: 2,
        failed: 0,
        status: 'ok',
        durationMs: expect.any(Number),
      }),
    );
  });

  it('catches a throwing processBatchOnce in runTick and logs a structured error', async () => {
    const failure = new Error('database unavailable');
    const logger = createLogger();
    const scheduler = createScheduler({
      relay: createRelay({ processBatchOnce: vi.fn().mockRejectedValue(failure) }),
      logger,
      flags: flags({ relayOwner: 'in_process' }),
    });

    await expect(scheduler.runTick()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'outbox_relay_scheduler_tick_failed',
        status: 'failed',
        errorMessage: 'database unavailable',
        durationMs: expect.any(Number),
      }),
    );
  });

  it('redacts sensitive scheduler log payloads before writing to the Nest logger sink', async () => {
    const logger = createLogger();
    const scheduler = createScheduler({
      relay: createRelay({
        processBatchOnce: vi.fn().mockRejectedValue(
          new Error('Authorization: Bearer abc.def.ghi access_token=token123'),
        ),
      }),
      logger,
      flags: flags({ relayOwner: 'in_process', relayWorkerId: 'worker-token-secret' }),
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
      flags: flags({ relayOwner: 'in_process' }),
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
      flags: flags({ relayOwner: 'in_process' }),
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
  flags?: NotificationsFeatureFlags;
  relay?: { processBatchOnce(): Promise<OutboxRelaySummary> };
  logger?: { log(message: unknown): void; error(message: unknown): void };
} = {}) {
  return new OutboxRelaySchedulerService(
    (overrides.relay ?? createRelay()) as never,
    {
      getFeatureFlags: () => overrides.flags ?? flags(),
    } as never,
    overrides.logger ?? createLogger(),
  );
}

function createRelay(overrides: { processBatchOnce?: () => Promise<OutboxRelaySummary> } = {}) {
  return {
    processBatchOnce:
      overrides.processBatchOnce ??
      vi.fn().mockResolvedValue({ claimed: 0, processed: 0, failed: 0 } satisfies OutboxRelaySummary),
  };
}

function createLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}

function flags(overrides: Partial<NotificationsFeatureFlags> = {}): NotificationsFeatureFlags {
  return {
    engineEnabled: true,
    rulesReadOnly: false,
    relayOwner: 'none',
    relayPollIntervalMs: 60000,
    relayBatchSize: 100,
    relayWorkerId: 'backend-local',
    relayMaxAttempts: 10,
    ...overrides,
  };
}
