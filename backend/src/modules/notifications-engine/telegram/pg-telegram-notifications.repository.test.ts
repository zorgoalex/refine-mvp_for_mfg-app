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
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM notification_channel_deliveries')) {
        return { rows: [{ user_id: '7', required_permission: null, expired: false }], rowCount: 1 };
      }
      return { rows: [{ notification_channel_delivery_id: 'delivery-1' }], rowCount: 1 };
    });
    const repository = new PgTelegramNotificationsRepository({
      query,
    } as unknown as DatabaseClient);

    await expect(repository.markSendStarted('delivery-1')).resolves.toEqual({ kind: 'started' });
    const statements = query.mock.calls.map((call) => String(call[0]));
    expect(statements[0]).toContain('FROM permissions_state WHERE id = true FOR SHARE');
    expect(statements.at(-1)).toContain('SET send_started_at = now()');
    // Без требуемого права пользователь не перепроверяется — прежнее поведение прочих источников.
    expect(statements.some((sql) => sql.includes('FROM users u'))).toBe(false);
  });

  it('skips an expired delivery and a recipient without the required permission, without starting the send', async () => {
    const run = async (target: Record<string, unknown>, user?: Record<string, unknown>) => {
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('FROM notification_channel_deliveries')) return { rows: [target], rowCount: 1 };
        if (sql.includes('FROM users u')) return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
        return { rows: [{ notification_channel_delivery_id: 'delivery-1' }], rowCount: 1 };
      });
      const result = await new PgTelegramNotificationsRepository({ query } as unknown as DatabaseClient).markSendStarted('delivery-1');
      return { result, started: query.mock.calls.some((call) => String(call[0]).includes('SET send_started_at = now()')) };
    };
    const base = { user_id: '7', required_permission: 'onec.view', expired: false };
    expect(await run({ ...base, expired: true })).toEqual({ result: expect.objectContaining({ kind: 'skip', code: 'EXPIRED' }), started: false });
    expect(await run(base, { is_active: false, allowed: true })).toEqual({ result: expect.objectContaining({ kind: 'skip', code: 'USER_INACTIVE' }), started: false });
    expect(await run(base, undefined)).toEqual({ result: expect.objectContaining({ kind: 'skip', code: 'USER_INACTIVE' }), started: false });
    expect(await run(base, { is_active: true, allowed: false })).toEqual({ result: expect.objectContaining({ kind: 'skip', code: 'PERMISSION_MISSING' }), started: false });
    expect(await run(base, { is_active: true, allowed: true })).toEqual({ result: { kind: 'started' }, started: true });
  });

  it('runs the check in its own transaction when given the database service', async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes('FROM notification_channel_deliveries')
        ? { rows: [], rowCount: 0 }
        : { rows: [], rowCount: 0 });
    const transaction = vi.fn(async (handler: (client: DatabaseClient) => Promise<unknown>) => handler({ query } as unknown as DatabaseClient));
    const repository = new PgTelegramNotificationsRepository({ query: vi.fn(), transaction } as unknown as DatabaseClient);
    await expect(repository.markSendStarted('delivery-1')).resolves.toEqual({ kind: 'lost' });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
