import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { compareClaimed, PgNotificationRepository } from './pg-notification-repository';

const viewer: CurrentUser = { id: '42', username: 'u', role: 'manager', roleId: 10, permissions: ['orders.view'] };
const SOURCES = ['procurement_order_event', 'procurement_digest'];
const ONEC = 'onec_alert';

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
      repository.listForUser({ viewer, unreadOnly: true, page: 2, pageSize: 10 }),
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
          balloonMode: null,
          balloonPending: false,
        },
      ],
      total: 1,
      unreadCount: 1,
    });
    expect(database.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('count(*) FILTER (WHERE ($2::boolean = false OR is_read = false))'),
      ['42', true, SOURCES, ONEC],
    );
    expect(database.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('AND ($2::boolean = false OR is_read = false)'),
      ['42', true, 10, 10, SOURCES, ONEC],
    );
  });

  it('reports counts when the requested notifications page is empty', async () => {
    const database = databaseClient([
      { rows: [{ total_count: '12', unread_count: '4' }] },
      { rows: [] },
    ]);
    const repository = new PgNotificationRepository(database);

    await expect(
      repository.listForUser({ viewer, unreadOnly: false, page: 3, pageSize: 10 }),
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
      viewer,
    });

    expect(result?.readAt).toBe('2026-05-23T10:00:00.000Z');
    const sql = queriedSql(database, 1);
    expect(sql).toContain('UPDATE notifications');
    expect(sql).toContain('SET is_read = true, read_at = COALESCE(read_at, now())');
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE notifications'),
      ['11111111-1111-4111-8111-111111111111', '42', SOURCES, ONEC],
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
      viewer,
    });

    expect(result?.readAt).toBe('2026-05-23T10:00:00.000Z');
    expect(result?.createdAt).toBe('2026-05-23T09:00:00.000Z');
  });

  it('marks all unread current-user notifications read', async () => {
    const database = databaseClient([{ rows: [{ updated_count: '3' }] }]);
    const repository = new PgNotificationRepository(database);

    await expect(repository.markAllReadForUser(viewer)).resolves.toBe(3);
    const sql = queriedSql(database, 1);
    expect(sql).toContain('SET is_read = true, read_at = COALESCE(read_at, now())');
    expect(sql).toContain('AND is_read = false');
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('is_read = false'), ['42', SOURCES, ONEC]);
  });

  it('deletes only current-user notification rows', async () => {
    const database = databaseClient([{ rowCount: 1, rows: [{ deleted: true, pending: false }] }]);
    const repository = new PgNotificationRepository(database);

    await expect(
      repository.deleteForUser({
        notificationId: '11111111-1111-4111-8111-111111111111',
        viewer,
      }),
    ).resolves.toBe('deleted');
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM notifications'),
      ['11111111-1111-4111-8111-111111111111', '42', SOURCES, ONEC],
    );
  });

  it('procurement notifications: hidden without literal procurement.view; with it — only orders in the current scope', async () => {
    const without = databaseClient([{ rows: [{ updated_count: '0' }] }]);
    await new PgNotificationRepository(without).markAllReadForUser(viewer);
    expect(queriedSql(without, 1)).toContain('AND (n.source_type <> ALL($2::text[])) AND n.source_type IS DISTINCT FROM $3');
    expect(queriedSql(without, 1)).not.toContain('EXISTS');

    const procurementViewer: CurrentUser = { ...viewer, permissions: ['orders.view', 'procurement.view'] };
    const withView = databaseClient([{ rows: [{ updated_count: '1' }] }]);
    await new PgNotificationRepository(withView).markAllReadForUser(procurementViewer);
    const sql = queriedSql(withView, 1);
    expect(sql).toContain("n.source_type <> ALL($2::text[]) OR n.entity_type IS DISTINCT FROM 'order' OR EXISTS");
    expect(sql).toContain('o.delete_flag = false');
    expect(sql).toContain('o.order_id::text = n.entity_id');
  });
});

describe('1C alert notifications (plan 2026-10-19 §2.7–2.8)', () => {
  it('are visible only with literal onec.view at read time', async () => {
    const without = databaseClient([{ rows: [{ updated_count: '0' }] }]);
    await new PgNotificationRepository(without).markAllReadForUser(viewer);
    expect(queriedSql(without, 1)).toContain('AND n.source_type IS DISTINCT FROM $3');
    expect(vi.mocked(without.query).mock.calls[0]?.[1]).toEqual(['42', SOURCES, ONEC]);

    const onecViewer: CurrentUser = { ...viewer, permissions: ['orders.view', 'onec.view'] };
    const withView = databaseClient([{ rows: [{ updated_count: '1' }] }]);
    await new PgNotificationRepository(withView).markAllReadForUser(onecViewer);
    expect(queriedSql(withView, 1)).not.toContain('IS DISTINCT FROM $3');
    expect(vi.mocked(withView.query).mock.calls[0]?.[1]).toEqual(['42', SOURCES]);
  });

  it('refuses to delete a row whose mandatory balloon was not shown yet', async () => {
    const database = databaseClient([{ rows: [{ deleted: false, pending: true }] }]);
    await expect(
      new PgNotificationRepository(database).deleteForUser({ notificationId: '11111111-1111-4111-8111-111111111111', viewer }),
    ).resolves.toBe('balloon_pending');
    expect(queriedSql(database, 1)).toContain("((n.balloon_mode = 'mandatory') IS TRUE AND n.balloon_shown_at IS NULL) AS pending");
    const missing = databaseClient([{ rows: [{ deleted: false, pending: false }] }]);
    await expect(
      new PgNotificationRepository(missing).deleteForUser({ notificationId: '11111111-1111-4111-8111-111111111111', viewer }),
    ).resolves.toBe('not_found');
  });

  it('claims mandatory balloons only for a client that declared them, with no age or read limit', async () => {
    const database = databaseClient([{ rows: [] }]);
    await new PgNotificationRepository(database).claimBalloonsForUser({ viewer, token: '33333333-3333-4333-8333-333333333333', limit: 5, mandatory: true });
    const sql = queriedSql(database, 1);
    expect(sql).toContain("CASE WHEN n.balloon_mode = 'mandatory' THEN $4::boolean ELSE n.is_read = false AND n.created_at > now() - interval '24 hours' END");
    expect(sql).toContain("(CASE WHEN n.balloon_mode = 'mandatory' THEN 1 ELSE 0 END) DESC, (CASE n.level WHEN 'error' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END) DESC, n.created_at, n.notification_id");
    expect(vi.mocked(database.query).mock.calls[0]?.[1]?.[3]).toBe(true);
  });

  it('orders a claimed batch the same way as the SQL: own lease, mandatory, level, time', () => {
    const row = (id: string, extra: Record<string, unknown>) =>
      ({ ...notificationRow({ notification_id: id }), balloon_mode: 'auto', own: false, ...extra }) as never;
    const rows = [
      row('a', { level: 'info', created_at: '2026-10-19T08:00:00Z' }),
      row('b', { level: 'error', created_at: '2026-10-19T09:00:00Z' }),
      row('c', { level: 'warning', balloon_mode: 'mandatory', created_at: '2026-10-19T10:00:00Z' }),
      row('d', { level: 'info', own: true, created_at: '2026-10-19T11:00:00Z' }),
      row('e', { level: 'error', balloon_mode: 'mandatory', created_at: new Date('2026-10-19T12:00:00Z') }),
    ];
    expect([...rows].sort(compareClaimed).map((r: { notification_id: string }) => r.notification_id)).toEqual(['d', 'e', 'c', 'b', 'a']);
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
