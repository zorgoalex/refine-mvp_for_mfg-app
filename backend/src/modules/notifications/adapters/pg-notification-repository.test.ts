import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { PgNotificationRepository } from './pg-notification-repository';

describe('PgNotificationRepository', () => {
  it('lists current-user notifications with unread filter and unread count', async () => {
    const database = databaseClient([
      {
        rows: [
          {
            total_count: '1',
            unread_count: '1',
          },
        ],
      },
      {
        rows: [
          {
            notification_id: '11111111-1111-4111-8111-111111111111',
            user_id: '42',
            level: 'warning',
            title: 'Deadline warning',
            message: 'Deadline is near',
            entity_type: 'order',
            entity_id: '1001',
            source_type: 'deadline',
            source_id: '22222222-2222-4222-8222-222222222222',
            read_at: null,
            created_at: '2026-05-23T09:00:00.000Z',
          },
        ],
      },
    ]);
    const repository = new PgNotificationRepository(database);

    await expect(
      repository.listForUser({ userId: '42', unreadOnly: true, page: 2, pageSize: 10 }),
    ).resolves.toEqual({
      data: [
        {
          notificationId: '11111111-1111-4111-8111-111111111111',
          userId: '42',
          level: 'warning',
          title: 'Deadline warning',
          message: 'Deadline is near',
          entityType: 'order',
          entityId: '1001',
          sourceType: 'deadline',
          sourceId: '22222222-2222-4222-8222-222222222222',
          readAt: null,
          createdAt: '2026-05-23T09:00:00.000Z',
        },
      ],
      total: 1,
      unreadCount: 1,
    });
    expect(database.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('count(*) FILTER (WHERE ($2::boolean = false OR is_read = false))'),
      ['42', true],
    );
    expect(database.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('AND ($2::boolean = false OR is_read = false)'),
      ['42', true, 10, 10],
    );
  });

  it('reports counts when the requested notifications page is empty', async () => {
    const database = databaseClient([
      { rows: [{ total_count: '12', unread_count: '4' }] },
      { rows: [] },
    ]);
    const repository = new PgNotificationRepository(database);

    await expect(
      repository.listForUser({ userId: '42', unreadOnly: false, page: 3, pageSize: 10 }),
    ).resolves.toEqual({
      data: [],
      total: 12,
      unreadCount: 4,
    });
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it('marks one current-user notification read', async () => {
    const database = databaseClient([
      { rows: [notificationRow({ read_at: '2026-05-23T10:00:00.000Z' })] },
    ]);
    const repository = new PgNotificationRepository(database);

    const result = await repository.markReadForUser({
      notificationId: '11111111-1111-4111-8111-111111111111',
      userId: '42',
    });

    expect(result?.readAt).toBe('2026-05-23T10:00:00.000Z');
    const sql = queriedSql(database, 1);
    expect(sql).toContain('UPDATE notifications');
    expect(sql).toContain('SET is_read = true, read_at = COALESCE(read_at, now())');
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE notifications'),
      ['11111111-1111-4111-8111-111111111111', '42'],
    );
  });

  it('maps Date timestamp columns to ISO strings', async () => {
    const database = databaseClient([
      {
        rows: [
          notificationRow({
            read_at: new Date('2026-05-23T10:00:00.000Z'),
            created_at: new Date('2026-05-23T09:00:00.000Z'),
          }),
        ],
      },
    ]);
    const repository = new PgNotificationRepository(database);

    const result = await repository.markReadForUser({
      notificationId: '11111111-1111-4111-8111-111111111111',
      userId: '42',
    });

    expect(result?.readAt).toBe('2026-05-23T10:00:00.000Z');
    expect(result?.createdAt).toBe('2026-05-23T09:00:00.000Z');
  });

  it('marks all unread current-user notifications read', async () => {
    const database = databaseClient([{ rows: [{ updated_count: '3' }] }]);
    const repository = new PgNotificationRepository(database);

    await expect(repository.markAllReadForUser('42')).resolves.toBe(3);
    const sql = queriedSql(database, 1);
    expect(sql).toContain('SET is_read = true, read_at = COALESCE(read_at, now())');
    expect(sql).toContain('AND is_read = false');
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('is_read = false'), ['42']);
  });

  it('deletes only current-user notification rows', async () => {
    const database = databaseClient([{ rowCount: 1, rows: [] }]);
    const repository = new PgNotificationRepository(database);

    await expect(
      repository.deleteForUser({
        notificationId: '11111111-1111-4111-8111-111111111111',
        userId: '42',
      }),
    ).resolves.toBe(true);
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM notifications'),
      ['11111111-1111-4111-8111-111111111111', '42'],
    );
  });
});

function databaseClient(results: Array<{ rows: unknown[]; rowCount?: number }>): DatabaseClient {
  return {
    query: vi.fn(async () => results.shift() ?? { rows: [], rowCount: 0 }),
  };
}

function notificationRow(overrides = {}) {
  return {
    notification_id: '11111111-1111-4111-8111-111111111111',
    user_id: '42',
    level: 'warning',
    title: 'Deadline warning',
    message: 'Deadline is near',
    entity_type: 'order',
    entity_id: '1001',
    source_type: 'deadline',
    source_id: '22222222-2222-4222-8222-222222222222',
    read_at: null,
    created_at: '2026-05-23T09:00:00.000Z',
    ...overrides,
  };
}

function queriedSql(database: DatabaseClient, callNumber: number): string {
  const query = vi.mocked(database.query);
  const sql = query.mock.calls[callNumber - 1]?.[0];
  return String(sql).replace(/\s+/g, ' ').trim();
}
