import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_WORKER_HEARTBEAT_STALE_MS,
  telegramWorkerHealthState,
  telegramWorkerHealthTransition,
} from './WarningNotificationBridge';

describe('Telegram worker global health notification', () => {
  const now = Date.parse('2026-08-28T10:00:00.000Z');

  it('marks a missing, invalid, or older-than-90-seconds heartbeat stale', () => {
    expect(telegramWorkerHealthState(null, now)).toBe('stale');
    expect(telegramWorkerHealthState('invalid', now)).toBe('stale');
    expect(telegramWorkerHealthState(
      new Date(now - TELEGRAM_WORKER_HEARTBEAT_STALE_MS - 1).toISOString(),
      now,
    )).toBe('stale');
  });

  it('keeps the exact 90-second boundary healthy', () => {
    expect(telegramWorkerHealthState(
      new Date(now - TELEGRAM_WORKER_HEARTBEAT_STALE_MS).toISOString(),
      now,
    )).toBe('healthy');
  });

  it('notifies once per outage and once on recovery', () => {
    expect(telegramWorkerHealthTransition(null, 'healthy')).toBeNull();
    expect(telegramWorkerHealthTransition(null, 'stale')).toBe('stale');
    expect(telegramWorkerHealthTransition('stale', 'stale')).toBeNull();
    expect(telegramWorkerHealthTransition('stale', 'healthy')).toBe('recovered');
    expect(telegramWorkerHealthTransition('healthy', 'healthy')).toBeNull();
  });
});
