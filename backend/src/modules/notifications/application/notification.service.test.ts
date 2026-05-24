import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { NotificationService } from './notification.service';
import type { NotificationRepositoryPort } from './notification.types';

describe('NotificationService', () => {
  it('requires an authenticated user for list reads', async () => {
    const service = new NotificationService({ repository: createRepository() });

    await expect(
      service.list({
        currentUser: undefined,
        query: { page: 1, pageSize: 50, unreadOnly: false },
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    } satisfies Partial<ApiError>);
  });

  it('lists only notifications owned by the current user', async () => {
    const repository = createRepository();
    const listSpy = vi.spyOn(repository, 'listForUser');
    const service = new NotificationService({ repository });

    const result = await service.list({
      currentUser: currentUser('42'),
      query: { page: 1, pageSize: 50, unreadOnly: true },
    });

    expect(result).toEqual({
      data: [],
      pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 },
      unreadCount: 0,
    });
    expect(listSpy).toHaveBeenCalledWith({
      userId: '42',
      unreadOnly: true,
      page: 1,
      pageSize: 50,
    });
  });

  it('marks a single current-user notification as read', async () => {
    const repository = createRepository({
      async markReadForUser(input) {
        expect(input).toEqual({
          notificationId: '11111111-1111-4111-8111-111111111111',
          userId: '42',
        });
        return createNotification({
          notificationId: input.notificationId,
          userId: input.userId,
          readAt: '2026-05-23T10:00:00.000Z',
        });
      },
    });
    const service = new NotificationService({ repository });

    await expect(
      service.markRead({
        currentUser: currentUser('42'),
        notificationId: '11111111-1111-4111-8111-111111111111',
      }),
    ).resolves.toMatchObject({
      notification: {
        notificationId: '11111111-1111-4111-8111-111111111111',
        userId: '42',
        readAt: '2026-05-23T10:00:00.000Z',
      },
    });
  });

  it('returns 404 when marking a notification that does not belong to the current user', async () => {
    const repository = createRepository({
      async markReadForUser() {
        return null;
      },
    });
    const service = new NotificationService({ repository });

    await expect(
      service.markRead({
        currentUser: currentUser('42'),
        notificationId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOTIFICATION_NOT_FOUND',
    } satisfies Partial<ApiError>);
  });

  it('marks all current-user notifications as read', async () => {
    const repository = createRepository({
      async markAllReadForUser(userId) {
        expect(userId).toBe('42');
        return 3;
      },
    });
    const service = new NotificationService({ repository });

    await expect(service.markAllRead({ currentUser: currentUser('42') })).resolves.toEqual({
      updatedCount: 3,
    });
  });

  it('deletes only a current-user notification', async () => {
    const repository = createRepository({
      async deleteForUser(input) {
        expect(input).toEqual({
          notificationId: '11111111-1111-4111-8111-111111111111',
          userId: '42',
        });
        return true;
      },
    });
    const service = new NotificationService({ repository });

    await expect(
      service.delete({
        currentUser: currentUser('42'),
        notificationId: '11111111-1111-4111-8111-111111111111',
      }),
    ).resolves.toEqual({
      notificationId: '11111111-1111-4111-8111-111111111111',
      deleted: true,
    });
  });
});

function currentUser(id: string): CurrentUser {
  return {
    id,
    username: `user-${id}`,
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
}

function createRepository(
  overrides: Partial<NotificationRepositoryPort> = {},
): NotificationRepositoryPort {
  return {
    async listForUser() {
      return { data: [], total: 0, unreadCount: 0 };
    },
    async markReadForUser(input) {
      return createNotification({ notificationId: input.notificationId, userId: input.userId });
    },
    async markAllReadForUser() {
      return 0;
    },
    async deleteForUser() {
      return true;
    },
    ...overrides,
  };
}

function createNotification(overrides = {}) {
  return {
    notificationId: '11111111-1111-4111-8111-111111111111',
    userId: '42',
    level: 'warning' as const,
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
