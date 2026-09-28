import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { OnecRuntimeConfigService } from '../onec-runtime-config.service';
import { OnecCommandWakeups } from './onec-command-wakeups';

class FakeClient extends EventEmitter {
  released: Array<boolean | undefined> = [];
  constructor(private readonly listen: () => Promise<unknown>) {
    super();
  }
  query = vi.fn((sql: string) => (sql.startsWith('LISTEN') ? this.listen() : Promise.resolve({ rows: [] })));
  release = vi.fn((destroy?: boolean) => {
    this.released.push(destroy);
  });
}

const runtime = { get: () => ({ enabled: true }) } as unknown as OnecRuntimeConfigService;

describe('OnecCommandWakeups LISTEN connection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases the pooled connection when LISTEN fails and reconnects with a fresh one', async () => {
    vi.useFakeTimers();
    const failing = new FakeClient(() => Promise.reject(new Error('LISTEN failed')));
    const healthy = new FakeClient(() => Promise.resolve({ rows: [] }));
    const connectDedicated = vi.fn().mockResolvedValueOnce(failing).mockResolvedValueOnce(healthy);
    const wakeups = new OnecCommandWakeups({ connectDedicated } as unknown as DatabaseService, runtime);
    wakeups.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(failing.released).toEqual([true]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(connectDedicated).toHaveBeenCalledTimes(2);
    expect(healthy.released).toEqual([]);
    // A later error on the live connection releases it exactly once.
    healthy.emit('error', new Error('connection lost'));
    healthy.emit('end');
    expect(healthy.released).toEqual([true]);
    await wakeups.onModuleDestroy();
  });

  it('shutdown during connect releases the late connection and never reconnects', async () => {
    vi.useFakeTimers();
    let resolveConnect: (client: FakeClient) => void = () => undefined;
    const client = new FakeClient(() => Promise.resolve({ rows: [] }));
    const connectDedicated = vi.fn(() => new Promise<FakeClient>((resolve) => (resolveConnect = resolve)));
    const wakeups = new OnecCommandWakeups({ connectDedicated } as unknown as DatabaseService, runtime);
    wakeups.onModuleInit();
    await wakeups.onModuleDestroy();
    resolveConnect(client);
    await vi.advanceTimersByTimeAsync(10000);
    expect(client.released).toHaveLength(1);
    expect(connectDedicated).toHaveBeenCalledTimes(1);
  });

  it('a newer claim supersedes the waiting owner; stale tokens cannot wait', async () => {
    const wakeups = new OnecCommandWakeups({} as DatabaseService, { get: () => ({ enabled: false }) } as unknown as OnecRuntimeConfigService);
    const signal = new AbortController().signal;
    const older = wakeups.claim('a');
    const waiting = wakeups.wait('a', older, 10000, signal);
    const newer = wakeups.claim('a');
    expect(await waiting).toBe('superseded');
    expect(wakeups.isCurrent('a', older)).toBe(false);
    expect(await wakeups.wait('a', older, 10000, signal)).toBe('superseded');
    const pending = wakeups.wait('a', newer, 10000, signal);
    wakeups.wake('a');
    expect(await pending).toBe('notify');
    wakeups.release('a', older);
    expect(wakeups.isCurrent('a', newer)).toBe(true);
    wakeups.release('a', newer);
    expect(wakeups.isCurrent('a', newer)).toBe(false);
  });
});
