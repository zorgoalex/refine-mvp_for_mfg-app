import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrderVersionCatchUp } from './orderVersionCatchUp';

describe('order card catch-up to the live order version', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };

  it('re-reads once when the live version is newer and stops when the card caught up', async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    const sync = createOrderVersionCatchUp({ refetch, retryMs: 5000 });
    sync.update(10, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(refetch).not.toHaveBeenCalled();
    sync.update(11, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(refetch).toHaveBeenCalledTimes(1);
    // Snapshots repeat the same version (304) while the read is running: no second read.
    sync.update(11, 10);
    sync.update(11, 10);
    await flush();
    sync.update(11, 11);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('after a failed read the same version is retried later, without a storm, until the card catches up', async () => {
    const refetch = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(undefined);
    const sync = createOrderVersionCatchUp({ refetch, retryMs: 5000 });
    sync.update(11, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(refetch).toHaveBeenCalledTimes(1);
    // The snapshot stays the same (304): the version does not change, yet the read is retried — once per retryMs.
    sync.update(11, 10);
    await vi.advanceTimersByTimeAsync(4999);
    expect(refetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(refetch).toHaveBeenCalledTimes(3);
    // The third read succeeded: the card now shows 11 — nothing more.
    sync.update(11, 11);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refetch).toHaveBeenCalledTimes(3);
  });

  it('a read that returned an older version is retried too; the own command refetch catching up cancels it', async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    const sync = createOrderVersionCatchUp({ refetch, retryMs: 5000 });
    sync.update(12, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(refetch).toHaveBeenCalledTimes(1);
    sync.update(12, 11);
    await vi.advanceTimersByTimeAsync(2000);
    // The card's own refetch (after a command) brought 12 before the retry: the pending retry is dropped.
    sync.update(12, 12);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('pauses in a hidden/inactive card: no reads (also after an in-flight one fails), catches up after activation', async () => {
    let fail = true;
    let rejectRunning: (error: Error) => void = () => undefined;
    const refetch = vi.fn(() => (fail
      ? new Promise<void>((_, reject) => { rejectRunning = reject; })
      : Promise.resolve(undefined)));
    const sync = createOrderVersionCatchUp({ refetch, retryMs: 5000 });
    sync.update(11, 10);
    // The first read is still running when the tab is hidden; it fails only afterwards.
    await vi.advanceTimersByTimeAsync(0);
    expect(refetch).toHaveBeenCalledTimes(1);
    sync.setActive(false);
    rejectRunning(new Error('network'));
    await vi.advanceTimersByTimeAsync(60_000);
    sync.update(11, 10);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refetch).toHaveBeenCalledTimes(1);
    // Back in front: the read is repeated at once (the interval since the last attempt has passed) and succeeds.
    fail = false;
    sync.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(refetch).toHaveBeenCalledTimes(2);
    sync.update(11, 11);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it('a pending retry is dropped when the card is hidden', async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    const sync = createOrderVersionCatchUp({ refetch, retryMs: 5000 });
    sync.update(11, 10);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    sync.setActive(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a live version (older backend) and after dispose', async () => {
    const refetch = vi.fn().mockRejectedValue(new Error('x'));
    const sync = createOrderVersionCatchUp({ refetch, retryMs: 5000 });
    sync.update(null, 10);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refetch).not.toHaveBeenCalled();
    sync.update(11, 10);
    await vi.advanceTimersByTimeAsync(0);
    sync.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
