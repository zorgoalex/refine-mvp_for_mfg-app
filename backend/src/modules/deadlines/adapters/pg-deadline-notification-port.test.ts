import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { PgDeadlineNotificationPort } from './pg-deadline-notification-port';

describe('PgDeadlineNotificationPort', () => {
  it('inserts notification rows with idempotency key and redacted deadline metadata', async () => {
    const database = new FakeDatabase([
      {
        rows: [
          {
            notification_id: 'notification-1',
            created_at: '2026-05-23T10:00:00.000Z',
          },
        ],
      },
    ]);
    const port = new PgDeadlineNotificationPort(database);

    await expect(
      port.createNotification({
        userId: 10,
        level: 'error',
        title: 'Deadline expired',
        message: 'Order 42 deadline expired at 2026-05-23T09:00:00.000Z',
        entityType: 'order',
        entityId: '42',
        sourceType: 'deadline',
        sourceId: 'event-1',
        idempotencyKey: 'deadline-notification:event-1:notify_assignee:10',
      }),
    ).resolves.toEqual({
      created: true,
      notificationId: 'notification-1',
    });

    expect(normalizeSql(database.queries[0].text)).toContain(
      'INSERT INTO notifications ( user_id, level, title, message, entity_type, entity_id, source_type, source_id, idempotency_key )',
    );
    expect(normalizeSql(database.queries[0].text)).toContain(
      'ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING',
    );
    expect(database.queries[0].params).toEqual([
      10,
      'error',
      'Deadline expired',
      'Order 42 deadline expired at 2026-05-23T09:00:00.000Z',
      'order',
      '42',
      'deadline',
      'event-1',
      'deadline-notification:event-1:notify_assignee:10',
    ]);
  });

  it('returns the existing notification when the idempotency key already exists', async () => {
    const database = new FakeDatabase([
      { rows: [] },
      {
        rows: [
          {
            notification_id: 'notification-existing',
            created_at: '2026-05-23T10:00:00.000Z',
          },
        ],
      },
    ]);
    const port = new PgDeadlineNotificationPort(database);

    await expect(
      port.createNotification({
        userId: 10,
        level: 'warning',
        title: 'Deadline warning',
        message: 'Order 42 deadline needs attention',
        entityType: 'order',
        entityId: '42',
        sourceType: 'deadline',
        sourceId: 'event-1',
        idempotencyKey: 'deadline-notification:event-1:notify_manager:10',
      }),
    ).resolves.toEqual({
      created: false,
      notificationId: 'notification-existing',
    });

    expect(normalizeSql(database.queries[1].text)).toContain(
      'SELECT notification_id, created_at FROM notifications WHERE idempotency_key = $1',
    );
    expect(database.queries[1].params).toEqual([
      'deadline-notification:event-1:notify_manager:10',
    ]);
  });
});

class FakeDatabase implements DatabaseClient {
  readonly queries: Array<{ text: string; params: unknown[] }> = [];

  constructor(private readonly results: Array<{ rows: Record<string, unknown>[] }>) {}

  async query(text: string, params: unknown[] = []) {
    this.queries.push({ text, params });
    return this.results.shift() ?? { rows: [] };
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
