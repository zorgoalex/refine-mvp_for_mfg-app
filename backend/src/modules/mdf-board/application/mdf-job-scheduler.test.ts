import { afterEach, describe, expect, it, vi } from 'vitest';
import { MdfJobScheduler } from './mdf-job-scheduler';
describe('independent bounded MDF queue scheduler', () => {
  afterEach(() => vi.useRealTimers());
  it('disabled flag starts no timer and never touches the database', async () => {
    vi.useFakeTimers(); const processOne = vi.fn();
    const scheduler = new MdfJobScheduler({ processOne },() => false);
    scheduler.onModuleInit(); await vi.advanceTimersByTimeAsync(5000); await scheduler.runTick();
    expect(processOne).not.toHaveBeenCalled(); await scheduler.onModuleDestroy();
  });
  it.each(['disabled','idle'] as const)('stops batch immediately on %s', async status => {
    const processOne = vi.fn().mockResolvedValue({ status });
    const scheduler = new MdfJobScheduler({ processOne },() => true);
    await scheduler.runTick(); expect(processOne).toHaveBeenCalledOnce(); await scheduler.onModuleDestroy();
  });
  it('caps busy batch at ten jobs', async () => {
    const processOne = vi.fn().mockResolvedValue({ status: 'done' });
    const scheduler = new MdfJobScheduler({ processOne },() => true);
    await scheduler.runTick(); expect(processOne).toHaveBeenCalledTimes(10); await scheduler.onModuleDestroy();
  });
  it('overlapping tick shares the same job; shutdown waits without claiming another', async () => {
    let release!: (value: { status: 'done' }) => void;
    const processOne = vi.fn(() => new Promise<{ status: 'done' }>(resolve => { release = resolve; }));
    const scheduler = new MdfJobScheduler({ processOne },() => true);
    const one = scheduler.runTick(), two = scheduler.runTick();
    expect(one).toBe(two); const stop = scheduler.onModuleDestroy(); release({ status: 'done' });
    await Promise.all([one,two,stop]); await scheduler.runTick();
    expect(processOne).toHaveBeenCalledOnce();
  });
  it('connection failure logs only safe code and permits the next poll', async () => {
    const processOne = vi.fn().mockRejectedValueOnce(new Error('password=secret')).mockResolvedValue({ status: 'idle' });
    const logger = { error: vi.fn() }, scheduler = new MdfJobScheduler({ processOne },() => true,logger);
    await scheduler.runTick(); await scheduler.runTick();
    expect(processOne).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith({ event: 'mdf_job_poll_failed',code: 'MDF_POLL_FAILED' });
    await scheduler.onModuleDestroy();
  });
});
