import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { NotificationsController, parseNotificationListQuery } from './notifications.controller';

describe('NotificationsController', () => {
  it('parses notification list query defaults', () => {
    expect(parseNotificationListQuery({})).toEqual({
      page: 1,
      pageSize: 50,
      unreadOnly: false,
    });
  });

  it('rejects invalid list query values', () => {
    expect(() => parseNotificationListQuery({ page: '0' })).toThrow(ApiError);
    expect(() => parseNotificationListQuery({ pageSize: '101' })).toThrow(ApiError);
    expect(() => parseNotificationListQuery({ unreadOnly: 'sometimes' })).toThrow(ApiError);
  });

  it('passes current user to list service', async () => {
    const service = {
      list: vi.fn(async () => ({
        data: [],
        pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 },
        unreadCount: 0,
      })),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      delete: vi.fn(),
    };
    const controller = new NotificationsController(service);
    const request = currentRequest();

    await controller.list(request, { unreadOnly: 'true' });

    expect(service.list).toHaveBeenCalledWith({
      currentUser: request.user,
      query: { page: 1, pageSize: 50, unreadOnly: true },
    });
  });

  it('passes current user and id to markRead service', async () => {
    const service = {
      list: vi.fn(),
      markRead: vi.fn(async () => ({ notification: notificationDto() })),
      markAllRead: vi.fn(),
      delete: vi.fn(),
    };
    const controller = new NotificationsController(service);
    const request = currentRequest();

    await controller.markRead(request, '11111111-1111-4111-8111-111111111111');

    expect(service.markRead).toHaveBeenCalledWith({
      currentUser: request.user,
      notificationId: '11111111-1111-4111-8111-111111111111',
    });
  });
});

function currentRequest(): RequestWithCurrentUser {
  return {
    requestId: 'req-1',
    user: {
      id: '42',
      username: 'manager',
      role: 'manager',
      roleId: 10,
      permissions: ['deadlines.view'],
    },
  };
}

function notificationDto() {
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
  };
}
