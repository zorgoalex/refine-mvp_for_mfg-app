import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bitrix24ReverseSchedulerService } from './bitrix24-reverse-scheduler.service';

const reverseConfig = (relayOwner: 'in_process' | 'external' = 'in_process') => ({
  getReverseSync: () => ({
    enabled: true,
    relayOwner,
    dryRun: false,
    pollIntervalMs: 1_000,
  }),
});

describe('Bitrix24ReverseSchedulerService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails module initialization before scheduling when prerequisites are invalid', async () => {
    vi.useFakeTimers();
    const processor = {
      assertReady: vi.fn().mockRejectedValue(new Error('invalid service actor')),
      runTick: vi.fn(),
      runReconcileTick: vi.fn(),
    };
    const service = new Bitrix24ReverseSchedulerService(
      processor as never,
      reverseConfig() as never,
      { log: vi.fn(), error: vi.fn() },
    );

    await expect(service.onModuleInit()).rejects.toThrow('invalid service actor');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(processor.runTick).not.toHaveBeenCalled();
  });

  it('validates external-worker configuration without starting an in-process timer', async () => {
    vi.useFakeTimers();
    const processor = {
      assertReady: vi.fn().mockResolvedValue(undefined),
      runTick: vi.fn(),
      runReconcileTick: vi.fn(),
    };
    const service = new Bitrix24ReverseSchedulerService(
      processor as never,
      reverseConfig('external') as never,
      { log: vi.fn(), error: vi.fn() },
    );

    await service.onModuleInit();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(processor.assertReady).toHaveBeenCalledTimes(1);
    expect(processor.runTick).not.toHaveBeenCalled();
  });
});
