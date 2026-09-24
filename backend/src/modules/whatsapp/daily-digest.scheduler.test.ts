import { afterEach, describe, expect, it, vi } from 'vitest';
import { DailyDigestScheduler } from './daily-digest.scheduler';

describe('DailyDigestScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('runs digest ticks every 30 seconds and independent cleanup every minute', async () => {
    vi.useFakeTimers();
    const service = { tick: vi.fn().mockResolvedValue(undefined), cleanupImages: vi.fn().mockResolvedValue(true) };
    const scheduler = new DailyDigestScheduler(service as never);
    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.tick).toHaveBeenCalledTimes(1);
    expect(service.cleanupImages).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.tick).toHaveBeenCalledTimes(2);
    expect(service.cleanupImages).toHaveBeenCalledTimes(1);
    scheduler.onModuleDestroy();
  });

  it('swallows a failed digest tick so the next tick still runs', async () => {
    vi.useFakeTimers();
    const service = { tick: vi.fn().mockRejectedValueOnce(new Error('isolated failure')).mockResolvedValue(undefined), cleanupImages: vi.fn().mockResolvedValue(true) };
    const scheduler = new DailyDigestScheduler(service as never);
    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.tick).toHaveBeenCalledTimes(2);
    scheduler.onModuleDestroy();
  });
});
