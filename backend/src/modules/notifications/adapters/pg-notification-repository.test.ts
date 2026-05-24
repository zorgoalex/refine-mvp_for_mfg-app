import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { PgNotificationRepository } from './pg-notification-repository';

describe('PgNotificationRepository', () => {
  it('lists current-user notifications with unread filter and unread count', async () => {
    const database = databaseClient([
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
            total_count: '1',
            unread_count: '1',
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
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('WHERE user_id = $1'), [
      '42',
      true,
      10,
      10,
    ]);
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
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE notifications'),
      ['11111111-1111-4111-8111-111111111111', '42'],
    );
  });

  it('marks all unread current-user notifications read', async () => {
    const database = databaseClient([{ rows: [{ updated_count: '3' }] }]);
    const repository = new PgNotificationRepository(database);

    await expect(repository.markAllReadForUser('42')).resolves.toBe(3);
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('read_at IS NULL'), ['42']);
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
