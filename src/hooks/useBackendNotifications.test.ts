import { describe, expect, it } from 'vitest';
import type { BackendNotificationDto } from '../api/types/notificationApi.types';
import {
  removeNotificationById,
  replaceNotificationById,
  toPanelNotification,
} from './useBackendNotifications';

describe('useBackendNotifications helpers', () => {
  it('maps backend rows to panel notifications', () => {
    expect(toPanelNotification(createBackendNotification())).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      message: 'Deadline is near',
      level: 'warning',
      timestamp: Date.parse('2026-05-23T09:00:00.000Z'),
      read: false,
      title: 'Deadline warning',
      sourceType: 'deadline',
      sourceId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('replaces a notification after mark-read mutation', () => {
    const unread = toPanelNotification(createBackendNotification());
    const read = toPanelNotification(
      createBackendNotification({ readAt: '2026-05-23T10:00:00.000Z' }),
    );

    expect(replaceNotificationById([unread], read)).toEqual([read]);
  });

  it('removes a notification after delete mutation', () => {
    const row = toPanelNotification(createBackendNotification());

    expect(removeNotificationById([row], row.id)).toEqual([]);
  });
});

function createBackendNotification(
  overrides: Partial<BackendNotificationDto> = {},
): BackendNotificationDto {
  return {
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
    ...overrides,
  };
}
