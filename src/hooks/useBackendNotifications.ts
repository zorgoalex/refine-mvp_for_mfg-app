import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

interface BackendNotificationsSnapshot {
  notifications: PanelNotification[];
  unreadCount: number;
}

const EMPTY_SNAPSHOT: BackendNotificationsSnapshot = {
  notifications: [],
  unreadCount: 0,
};

export function useBackendNotifications(enabled: boolean): BackendNotificationsState {
  const [snapshot, setSnapshot] = useState<BackendNotificationsSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const enabledRef = useRef(enabled);
  const mountedRef = useRef(true);
  const refreshRequestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabledRef.current) {
      setSnapshot(EMPTY_SNAPSHOT);
      setLoading(false);
      setError(null);
      return;
    }

    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const response = await notificationsApi.list({ page: 1, pageSize: 50, unreadOnly: false });
      if (!isCurrentRefresh(requestId, refreshRequestIdRef, enabledRef, mountedRef)) {
        return;
      }

      setSnapshot({
        notifications: response.data.map(toPanelNotification),
        unreadCount: response.unreadCount,
      });
    } catch (caught) {
      if (isCurrentRefresh(requestId, refreshRequestIdRef, enabledRef, mountedRef)) {
        setError(caught);
      }
    } finally {
      if (isCurrentRefresh(requestId, refreshRequestIdRef, enabledRef, mountedRef)) {
        setLoading(false);
      }
    }
  }, []);

  const invalidatePendingRefresh = useCallback(() => {
    refreshRequestIdRef.current += 1;
    setLoading(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      refreshRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    enabledRef.current = enabled;

    if (!enabled) {
      refreshRequestIdRef.current += 1;
      setSnapshot(EMPTY_SNAPSHOT);
      setLoading(false);
      setError(null);
      return;
    }

    void refresh();
  }, [enabled, refresh]);

  const markAsRead = useCallback(async (ids: string | string[]) => {
    invalidatePendingRefresh();
    const idList = Array.isArray(ids) ? ids : [ids];

    for (const id of idList) {
      const response = await notificationsApi.markRead(id);
      const next = toPanelNotification(response.notification);
      setSnapshot((current) => replaceNotificationInSnapshot(current, next));
    }
  }, [invalidatePendingRefresh]);

  const markAllAsRead = useCallback(async () => {
    invalidatePendingRefresh();
    await notificationsApi.markAllRead();
    setSnapshot((current) => ({
      notifications: current.notifications.map((notification) => ({
        ...notification,
        read: true,
      })),
      unreadCount: 0,
    }));
  }, [invalidatePendingRefresh]);

  const deleteNotification = useCallback(async (ids: string | string[]) => {
    invalidatePendingRefresh();
    const idList = Array.isArray(ids) ? ids : [ids];

    for (const id of idList) {
      await notificationsApi.delete(id);
      setSnapshot((current) => removeNotificationFromSnapshot(current, id));
    }
  }, [invalidatePendingRefresh]);

  return useMemo(
    () => ({
      notifications: snapshot.notifications,
      unreadCount: snapshot.unreadCount,
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
      refresh,
      snapshot,
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

function isCurrentRefresh(
  requestId: number,
  refreshRequestIdRef: { current: number },
  enabledRef: { current: boolean },
  mountedRef: { current: boolean },
): boolean {
  return (
    mountedRef.current &&
    enabledRef.current &&
    refreshRequestIdRef.current === requestId
  );
}

function replaceNotificationInSnapshot(
  current: BackendNotificationsSnapshot,
  replacement: PanelNotification,
): BackendNotificationsSnapshot {
  const existing = current.notifications.find(
    (notification) => notification.id === replacement.id,
  );
  const unreadCount =
    existing && !existing.read && replacement.read
      ? Math.max(0, current.unreadCount - 1)
      : current.unreadCount;

  return {
    notifications: replaceNotificationById(current.notifications, replacement),
    unreadCount,
  };
}

function removeNotificationFromSnapshot(
  current: BackendNotificationsSnapshot,
  notificationId: string,
): BackendNotificationsSnapshot {
  const existing = current.notifications.find(
    (notification) => notification.id === notificationId,
  );

  return {
    notifications: removeNotificationById(current.notifications, notificationId),
    unreadCount:
      existing && !existing.read ? Math.max(0, current.unreadCount - 1) : current.unreadCount,
  };
}
