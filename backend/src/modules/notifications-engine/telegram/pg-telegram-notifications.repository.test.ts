import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { PgTelegramNotificationsRepository } from './pg-telegram-notifications.repository';

describe('PgTelegramNotificationsRepository delivery recovery', () => {
  it('retries stale pre-send claims and isolates uncertain post-send claims', async () => {
    const query = vi.fn(async () => ({
      rows: [{ rescheduled: '2', failed: '1', unknown: '3' }],
      rowCount: 1,
    }));
    const repository = new PgTelegramNotificationsRepository({
      query,
    } as unknown as DatabaseClient);

    await expect(
      repository.recoverStaleProcessing(new Date('2026-07-28T12:00:00Z'), 10),
    ).resolves.toEqual({
      rescheduled: 2,
      failed: 1,
      unknown: 3,
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("WHEN send_started_at IS NOT NULL THEN 'unknown'");
    expect(sql).toContain("ELSE 'pending'");
    expect(sql).toContain('WHEN attempts >= $2');
  });

  it('persists the send boundary before the Telegram request', async () => {
    const query = vi.fn(async () => ({
      rows: [{ notification_channel_delivery_id: 'delivery-1' }],
      rowCount: 1,
    }));
    const repository = new PgTelegramNotificationsRepository({
      query,
    } as unknown as DatabaseClient);

    await expect(repository.markSendStarted('delivery-1')).resolves.toBe(true);
    expect(String(query.mock.calls[0]?.[0])).toContain('SET send_started_at = now()');
  });
});
