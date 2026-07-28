import { useCallback, useMemo } from 'react';
import {
  type BackendNotificationsState,
  type PanelNotification,
  useBackendNotifications,
} from './useBackendNotifications';
import { useNotificationStore, type Notification } from '../stores/notificationStore';

const MAX_NAVBAR_NOTIFICATIONS = 100;

export function useNavbarNotifications(userId?: string): BackendNotificationsState {
  const backend = useBackendNotifications(Boolean(userId));
  const localNotifications = useNotificationStore((state) => state.notifications);
  const localForUser = useMemo(
    () => localNotifications.filter((item) => item.isSystem || item.userId === userId),
    [localNotifications, userId],
  );
  const localIds = useMemo(
    () => new Set(localForUser.map((notification) => notification.id)),
    [localForUser],
  );

  const markAsRead = useCallback(
    async (ids: string | string[]) => {
      const idList = Array.isArray(ids) ? ids : [ids];
      const local = idList.filter((id) => localIds.has(id));
      const remote = idList.filter((id) => !localIds.has(id));

      if (local.length > 0) {
        useNotificationStore.getState().markAsRead(local, userId);
      }
      if (remote.length > 0) {
        await backend.markAsRead(remote);
      }
    },
    [backend, localIds, userId],
  );

  const markAllAsRead = useCallback(async () => {
    useNotificationStore.getState().markAllAsRead(userId);
    await backend.markAllAsRead();
  }, [backend, userId]);

  const deleteNotification = useCallback(
    async (ids: string | string[]) => {
      const idList = Array.isArray(ids) ? ids : [ids];
      const local = idList.filter((id) => localIds.has(id));
      const remote = idList.filter((id) => !localIds.has(id));

      if (local.length > 0) {
        useNotificationStore.getState().deleteNotification(local, userId);
      }
      if (remote.length > 0) {
        await backend.deleteNotification(remote);
      }
    },
    [backend, localIds, userId],
  );

  return useMemo(
    () => ({
      notifications: mergeNavbarNotifications(
        backend.notifications,
        localForUser.map(toLocalPanelNotification),
      ),
      unreadCount:
        backend.unreadCount + localForUser.filter((notification) => !notification.read).length,
      loading: backend.loading,
      error: backend.error,
      refresh: backend.refresh,
      markAsRead,
      markAllAsRead,
      deleteNotification,
    }),
    [
      backend.error,
      backend.loading,
      backend.notifications,
      backend.refresh,
      backend.unreadCount,
      deleteNotification,
      localForUser,
      markAllAsRead,
      markAsRead,
    ],
  );
}

export function toLocalPanelNotification(notification: Notification): PanelNotification {
  return {
    id: notification.id,
    message: notification.message,
    level: notification.level,
    timestamp: notification.timestamp,
    read: notification.read,
    title: null,
    sourceType: 'frontend-warning',
    sourceId: null,
  };
}

export function mergeNavbarNotifications(
  backend: PanelNotification[],
  local: PanelNotification[],
): PanelNotification[] {
  return [...backend, ...local]
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, MAX_NAVBAR_NOTIFICATIONS);
}
