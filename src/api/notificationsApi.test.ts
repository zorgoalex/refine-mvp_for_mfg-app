import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationsApi, validateNotificationId } from './notificationsApi';

const notificationId = '11111111-1111-4111-8111-111111111111';

describe('notificationsApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('lists notifications through the versioned endpoint', async () => {
    const fetchMock = mockFetch({
      data: [],
      pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 },
      unreadCount: 0,
    });

    await notificationsApi.list({ page: 1, pageSize: 50, unreadOnly: true });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/notifications?page=1&pageSize=50&unreadOnly=true',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('marks one notification as read', async () => {
    const fetchMock = mockFetch({
      notification: createNotification({ readAt: '2026-05-23T10:00:00.000Z' }),
    });

    await notificationsApi.markRead(notificationId);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/notifications/${notificationId}/read`,
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('marks all notifications as read', async () => {
    const fetchMock = mockFetch({ updatedCount: 2 });

    await notificationsApi.markAllRead();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/notifications/read-all',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('deletes one notification', async () => {
    const fetchMock = mockFetch({ notificationId, deleted: true });

    await notificationsApi.delete(notificationId);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/notifications/${notificationId}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('rejects invalid notification ids before fetch', async () => {
    const fetchMock = mockFetch({ notification: createNotification() });

    expect(() => validateNotificationId('not-uuid')).toThrow('Invalid notificationId');
    expect(() => notificationsApi.markRead('not-uuid')).toThrow('Invalid notificationId');
    expect(() => notificationsApi.delete('not-uuid')).toThrow('Invalid notificationId');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function mockFetch(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function createNotification(overrides = {}) {
  return {
    notificationId,
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
    ...overrides,
  };
}
