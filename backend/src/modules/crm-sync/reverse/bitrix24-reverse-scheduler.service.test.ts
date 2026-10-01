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

  function tickingProcessor() {
    return {
      assertReady: vi.fn().mockResolvedValue(undefined),
      runTick: vi.fn().mockResolvedValue({ claimed: 0, processed: 0, failed: 0 }),
      runReconcileTick: vi.fn().mockResolvedValue(0),
      runRetentionTick: vi.fn().mockResolvedValue({ auditDeleted: 3, inboundDeleted: 2, backlog: false }),
    };
  }

  it('prunes reconcile records on the first tick and then at most once per half an hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const processor = tickingProcessor();
    const logger = { log: vi.fn(), error: vi.fn() };
    const service = new Bitrix24ReverseSchedulerService(processor as never, reverseConfig() as never, logger);

    await service.tick();
    await service.tick();
    expect(processor.runRetentionTick).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      event: 'bitrix24_reconcile_retention_finished', auditDeleted: 3, inboundDeleted: 2,
    }));

    vi.setSystemTime(new Date('2026-10-01T00:29:59Z'));
    await service.tick();
    expect(processor.runRetentionTick).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-01T00:30:00Z'));
    await service.tick();
    expect(processor.runRetentionTick).toHaveBeenCalledTimes(2);
    expect(processor.runTick).toHaveBeenCalledTimes(4);
  });

  it('drains a backlog a minute apart instead of waiting a whole interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const processor = tickingProcessor();
    processor.runRetentionTick
      .mockResolvedValueOnce({ auditDeleted: 2_000, inboundDeleted: 2_000, backlog: true })
      .mockResolvedValue({ auditDeleted: 10, inboundDeleted: 10, backlog: false });
    const service = new Bitrix24ReverseSchedulerService(
      processor as never, reverseConfig() as never, { log: vi.fn(), error: vi.fn() },
    );

    await service.tick();
    vi.setSystemTime(new Date('2026-10-01T00:00:59Z'));
    await service.tick();
    expect(processor.runRetentionTick).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-01T00:01:00Z'));
    await service.tick();
    expect(processor.runRetentionTick).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date('2026-10-01T00:02:00Z'));
    await service.tick();
    expect(processor.runRetentionTick).toHaveBeenCalledTimes(2);
  });

  it('keeps processing events when the retention run fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const processor = tickingProcessor();
    processor.runRetentionTick.mockRejectedValue(new Error('function prune_bitrix24_reconcile_noise does not exist'));
    const logger = { log: vi.fn(), error: vi.fn() };
    const service = new Bitrix24ReverseSchedulerService(processor as never, reverseConfig() as never, logger);

    await expect(service.tick()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'bitrix24_reconcile_retention_failed' }));
    await service.tick();
    expect(processor.runTick).toHaveBeenCalledTimes(2);
    expect(processor.runRetentionTick).toHaveBeenCalledTimes(1);
  });

  it('still prunes when the event tick itself failed, and stays silent when nothing was removed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const processor = tickingProcessor();
    processor.runTick.mockRejectedValue(new Error('E2E tick failure'));
    processor.runRetentionTick.mockResolvedValue({ auditDeleted: 0, inboundDeleted: 0, backlog: false });
    const logger = { log: vi.fn(), error: vi.fn() };
    const service = new Bitrix24ReverseSchedulerService(processor as never, reverseConfig() as never, logger);

    await service.tick();
    expect(processor.runRetentionTick).toHaveBeenCalledTimes(1);
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'bitrix24_reverse_batch_failed' }));
  });
});
