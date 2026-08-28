import { describe, expect, it, vi } from 'vitest';
import { FrontendVersionMonitor } from './frontendVersionMonitor';

describe('FrontendVersionMonitor', () => {
  it('does not add a request before the background interval', async () => {
    const readLatestSha = vi.fn().mockResolvedValue('new-sha');
    const onVersionAvailable = vi.fn();
    const monitor = new FrontendVersionMonitor({
      currentSha: 'old-sha',
      readLatestSha,
      onVersionAvailable,
      intervalMs: 60_000,
      startedAt: 1_000,
    });

    await monitor.check(60_999);

    expect(readLatestSha).not.toHaveBeenCalled();
    expect(onVersionAvailable).not.toHaveBeenCalled();
  });

  it('reports a different deployed build once', async () => {
    const readLatestSha = vi.fn().mockResolvedValue('new-sha');
    const onVersionAvailable = vi.fn();
    const monitor = new FrontendVersionMonitor({
      currentSha: 'old-sha',
      readLatestSha,
      onVersionAvailable,
      intervalMs: 60_000,
      startedAt: 0,
    });

    await monitor.check(60_000);
    await monitor.check(120_000);

    expect(readLatestSha).toHaveBeenCalledTimes(1);
    expect(onVersionAvailable).toHaveBeenCalledOnce();
    expect(onVersionAvailable).toHaveBeenCalledWith('new-sha');
  });

  it('ignores equal, missing, failed and hidden checks', async () => {
    const readLatestSha = vi.fn()
      .mockResolvedValueOnce('same-sha')
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('offline'));
    const onVersionAvailable = vi.fn();
    const monitor = new FrontendVersionMonitor({
      currentSha: 'same-sha',
      readLatestSha,
      onVersionAvailable,
      intervalMs: 10,
      startedAt: 0,
    });

    await monitor.check(10, false);
    await monitor.check(10);
    await monitor.check(20);
    await monitor.check(30);

    expect(readLatestSha).toHaveBeenCalledTimes(3);
    expect(onVersionAvailable).not.toHaveBeenCalled();
  });

  it('shares an in-flight request between simultaneous checks', async () => {
    let resolveRead: ((sha: string) => void) | undefined;
    const readLatestSha = vi.fn(() => new Promise<string>((resolve) => {
      resolveRead = resolve;
    }));
    const onVersionAvailable = vi.fn();
    const monitor = new FrontendVersionMonitor({
      currentSha: 'old-sha',
      readLatestSha,
      onVersionAvailable,
      intervalMs: 10,
      startedAt: 0,
    });

    const first = monitor.check(10);
    const second = monitor.check(11);
    resolveRead?.('new-sha');
    await Promise.all([first, second]);

    expect(readLatestSha).toHaveBeenCalledTimes(1);
    expect(onVersionAvailable).toHaveBeenCalledOnce();
  });
});
