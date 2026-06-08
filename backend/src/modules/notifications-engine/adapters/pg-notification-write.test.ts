import { describe, expect, it, vi } from 'vitest';
import type { InsertNotificationInput } from '../ports/notification-write.port';
import { PgNotificationWriteAdapter } from './pg-notification-write';

function fakeInput(overrides: Partial<InsertNotificationInput> = {}): InsertNotificationInput {
  return {
    userId: 7,
    level: 'info',
    title: 'E2E-title',
    message: 'E2E-message',
    entityType: 'order',
    entityId: '123',
    sourceType: 'notification_rule',
    sourceId: 'rule-1',
    idempotencyKey: 'notif-rule:E2E-key-1',
    ...overrides,
  };
}

describe('PgNotificationWriteAdapter', () => {
  it('returns created:true with the inserted id when the INSERT returns a row', async () => {
    const query = vi.fn(async () => ({ rows: [{ notification_id: 'new-id-1' }] }));
    const client = { query };
    const adapter = new PgNotificationWriteAdapter();

    const result = await adapter.insertIfAbsent(client as any, fakeInput());

    expect(result).toEqual({ created: true, notificationId: 'new-id-1' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('falls back to SELECT and returns created:false with the existing id when the INSERT returns no row', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ notification_id: 'existing-id-1' }] });
    const client = { query };
    const adapter = new PgNotificationWriteAdapter();

    const result = await adapter.insertIfAbsent(client as any, fakeInput());

    expect(result).toEqual({ created: false, notificationId: 'existing-id-1' });
    expect(query).toHaveBeenCalledTimes(2);

    const selectSql = query.mock.calls[1][0] as string;
    expect(selectSql).toMatch(/SELECT notification_id FROM notifications WHERE idempotency_key = \$1/);
    expect(query.mock.calls[1][1]).toEqual(['notif-rule:E2E-key-1']);
  });

  it('issues an INSERT with ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING and the expected params', async () => {
    const query = vi.fn(async () => ({ rows: [{ notification_id: 'new-id-2' }] }));
    const client = { query };
    const adapter = new PgNotificationWriteAdapter();
    const input = fakeInput({ userId: 42, sourceId: null, entityId: null });

    await adapter.insertIfAbsent(client as any, input);

    const insertSql = query.mock.calls[0][0] as string;
    const insertParams = query.mock.calls[0][1] as unknown[];
    expect(insertSql).toMatch(/INSERT INTO notifications/);
    expect(insertSql).toContain('ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING');
    expect(insertSql).toMatch(/RETURNING notification_id/);
    expect(insertParams).toEqual([
      input.userId,
      input.level,
      input.title,
      input.message,
      input.entityType,
      input.entityId,
      input.sourceType,
      input.sourceId,
      input.idempotencyKey,
    ]);
  });
});
