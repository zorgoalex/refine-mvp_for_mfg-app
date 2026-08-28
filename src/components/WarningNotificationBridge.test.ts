import { beforeEach, describe, expect, it } from 'vitest';
import {
  TELEGRAM_WORKER_HEARTBEAT_STALE_MS,
  addBellNotificationOnce,
  canReceiveTelegramWorkerHealthNotification,
  telegramWorkerHealthState,
  telegramWorkerHealthTransition,
} from './WarningNotificationBridge';
import { useNotificationStore } from '../stores/notificationStore';

describe('Telegram worker global health notification', () => {
  const now = Date.parse('2026-08-28T10:00:00.000Z');

  beforeEach(() => {
    useNotificationStore.setState({ notifications: [] });
  });

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

  it('targets top-management capabilities and excludes ordinary managers', () => {
    expect(canReceiveTelegramWorkerHealthNotification({ permissions: ['cut.manage', 'org.view'] })).toBe(true);
    expect(canReceiveTelegramWorkerHealthNotification({ permissions: ['cut.manage'] })).toBe(false);
    expect(canReceiveTelegramWorkerHealthNotification(null)).toBe(false);
  });

  it('stores one bell item per worker incident', () => {
    addBellNotificationOnce('7', 'worker:stale:heartbeat-1', 'Worker stopped', 'error');
    addBellNotificationOnce('7', 'worker:stale:heartbeat-1', 'Worker stopped', 'error');
    addBellNotificationOnce('8', 'worker:stale:heartbeat-1', 'Worker stopped', 'error');

    expect(useNotificationStore.getState().notifications).toHaveLength(2);
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      message: 'Worker stopped',
      dedupeKey: 'worker:stale:heartbeat-1',
      userId: '8',
    });
  });
});
