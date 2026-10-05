import { describe, expect, it, vi } from 'vitest';
import { ProcurementNotificationsSchedulerService } from './procurement-notifications-scheduler.service';

describe('ProcurementNotificationsSchedulerService (R2-1: every run is logged)', () => {
  it('an empty run with the rules off still logs run_finished with runId, instance, times, counters and rule state', async () => {
    const summary = { demandEvents: 0, digests: 0, unallocated: 0, failed: 0, rulesEnabled: { demandChanged: false, digest: false, unallocated: false } };
    const logger = { log: vi.fn(), error: vi.fn() };
    const scheduler = new ProcurementNotificationsSchedulerService({ runOnce: vi.fn(async () => summary) }, logger, 60_000);
    await scheduler.tick();
    expect(logger.log).toHaveBeenCalledTimes(1);
    const entry = logger.log.mock.calls[0][0];
    expect(entry).toMatchObject({ event: 'procurement_notifications_run_finished', ...summary });
    expect(entry.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.instanceId).toMatch(/:\d+$/);
    expect(Date.parse(entry.finishedAt)).toBeGreaterThanOrEqual(Date.parse(entry.startedAt));
  });

  it('a tick during a running pass logs run_skipped; a failing pass logs run_failed and frees the scheduler', async () => {
    let release!: () => void;
    const logger = { log: vi.fn(), error: vi.fn() };
    const runOnce = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ demandEvents: 0, digests: 0, unallocated: 0, failed: 0 }); }))
      .mockImplementationOnce(async () => { throw new Error('boom'); });
    const scheduler = new ProcurementNotificationsSchedulerService({ runOnce }, logger, 60_000);
    const first = scheduler.tick();
    await scheduler.tick();
    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'procurement_notifications_run_skipped', reason: 'previous_run_in_progress' }));
    release();
    await first;
    await scheduler.tick();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'procurement_notifications_run_failed', errorMessage: 'boom' }));
    expect(runOnce).toHaveBeenCalledTimes(2);
  });
});
