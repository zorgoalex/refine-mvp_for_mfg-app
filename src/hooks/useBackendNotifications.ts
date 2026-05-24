import { useCallback, useEffect, useMemo, useState } from 'react';
import { notificationsApi } from '../api/notificationsApi';
import type { BackendNotificationDto } from '../api/types/notificationApi.types';
import type { NotificationLevel } from '../stores/notificationStore';

export interface PanelNotification {
  id: string;
  message: string;
  level: NotificationLevel;
  timestamp: number;
  read: boolean;
  title: string | null;
  sourceType: string | null;
  sourceId: string | null;
}

export interface BackendNotificationsState {
  notifications: PanelNotification[];
  unreadCount: number;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  markAsRead: (ids: string | string[]) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  deleteNotification: (ids: string | string[]) => Promise<void>;
}

export function useBackendNotifications(enabled: boolean): BackendNotificationsState {
  const [notifications, setNotifications] = useState<PanelNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await notificationsApi.list({ page: 1, pageSize: 50, unreadOnly: false });
      setNotifications(response.data.map(toPanelNotification));
      setUnreadCount(response.unreadCount);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const markAsRead = useCallback(
    async (ids: string | string[]) => {
      const idList = Array.isArray(ids) ? ids : [ids];
      const unreadIds = notifications
        .filter((notification) => idList.includes(notification.id) && !notification.read)
        .map((notification) => notification.id);

      for (const id of idList) {
        const response = await notificationsApi.markRead(id);
        const next = toPanelNotification(response.notification);
        setNotifications((current) => replaceNotificationById(current, next));
      }
      setUnreadCount((current) => Math.max(0, current - unreadIds.length));
    },
    [notifications],
  );

  const markAllAsRead = useCallback(async () => {
    await notificationsApi.markAllRead();
    setNotifications((current) =>
      current.map((notification) => ({ ...notification, read: true })),
    );
    setUnreadCount(0);
  }, []);

  const deleteNotification = useCallback(
    async (ids: string | string[]) => {
      const idList = Array.isArray(ids) ? ids : [ids];
      const unreadDeletedCount = notifications.filter(
        (notification) => idList.includes(notification.id) && !notification.read,
      ).length;

      for (const id of idList) {
        await notificationsApi.delete(id);
        setNotifications((current) => removeNotificationById(current, id));
      }
      setUnreadCount((current) => Math.max(0, current - unreadDeletedCount));
    },
    [notifications],
  );

  return useMemo(
    () => ({
      notifications,
      unreadCount,
      loading,
      error,
      refresh,
      markAsRead,
      markAllAsRead,
      deleteNotification,
    }),
    [
      deleteNotification,
      error,
      loading,
      markAllAsRead,
      markAsRead,
      notifications,
      refresh,
      unreadCount,
    ],
  );
}

export function toPanelNotification(notification: BackendNotificationDto): PanelNotification {
  return {
    id: notification.notificationId,
    message: notification.message,
    level: notification.level,
    timestamp: Date.parse(notification.createdAt),
    read: notification.readAt !== null,
    title: notification.title,
    sourceType: notification.sourceType,
    sourceId: notification.sourceId,
  };
}

export function replaceNotificationById(
  notifications: PanelNotification[],
  replacement: PanelNotification,
): PanelNotification[] {
  return notifications.map((notification) =>
    notification.id === replacement.id ? replacement : notification,
  );
}

export function removeNotificationById(
  notifications: PanelNotification[],
  notificationId: string,
): PanelNotification[] {
  return notifications.filter((notification) => notification.id !== notificationId);
}
