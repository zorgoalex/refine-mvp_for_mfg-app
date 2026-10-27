import { ApiError } from '../api/httpClient';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NOTIFICATIONS_CHANGED_EVENT } from '../notifications/balloons/notificationEvents';
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
  /** false — обязательный балун ещё не показан: удалить нельзя (план 2026-10-19 §2.7). */
  deletable: boolean;
}

export interface BackendNotificationsState {
  notifications: PanelNotification[];
  unreadCount: number;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  markAsRead: (ids: string | string[]) => Promise<void>;
  /** «Все прочитаны» — только уведомления, показанные в списке (их id передаёт панель). */
  markAllAsRead: (shownIds: string[]) => Promise<void>;
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
  const snapshotRef = useRef<BackendNotificationsSnapshot>(EMPTY_SNAPSHOT);
  snapshotRef.current = snapshot;
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
    // Центр балунов показал новые уведомления (или клик отметил прочитанным) — перечитать список колокольчика.
    const onChanged = () => { void refresh(); };
    if (typeof window !== 'undefined') window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    };
  }, [enabled, refresh]);

  const markAsRead = useCallback(async (ids: string | string[]) => {
    invalidatePendingRefresh();
    const idList = Array.isArray(ids) ? ids : [ids];

    for (const id of idList) {
      const response = await notificationsApi.markRead(id);
      const next = toPanelNotification(response.notification);
      invalidatePendingRefresh();
      setSnapshot((current) => replaceNotificationInSnapshot(current, next));
    }
  }, [invalidatePendingRefresh]);

  // «Все прочитаны» — только то, что показано в списке: уведомление, пришедшее после последней загрузки, остаётся
  // непрочитанным (и ещё всплывёт балуном), а не гасится вслепую.
  const markAllAsRead = useCallback(async (shownIds: string[]) => {
    const shown = new Set(shownIds);
    const shownUnread = snapshotRef.current.notifications
      .filter((notification) => shown.has(notification.id) && !notification.read)
      .map((notification) => notification.id);
    if (shownUnread.length === 0) return;
    invalidatePendingRefresh();
    await notificationsApi.markAllRead(shownUnread);
    invalidatePendingRefresh();
    const marked = new Set(shownUnread);
    setSnapshot((current) => {
      // Вычитаем только то, что в текущем снимке ещё непрочитано: если обновление списка успело прийти раньше ответа,
      // оно уже учло эти строки — второго вычитания нет.
      const stillUnread = current.notifications.filter((notification) => marked.has(notification.id) && !notification.read).length;
      return {
        notifications: current.notifications.map((notification) =>
          marked.has(notification.id) ? { ...notification, read: true } : notification),
        unreadCount: Math.max(0, current.unreadCount - stillUnread),
      };
    });
    // Точный счётчик — с сервера: отмеченная строка могла уйти за первую страницу, пока шёл запрос.
    void refresh();
  }, [invalidatePendingRefresh, refresh]);

  const deleteNotification = useCallback(async (ids: string | string[]) => {
    invalidatePendingRefresh();
    const idList = Array.isArray(ids) ? ids : [ids];

    for (const id of idList) {
      try {
        await notificationsApi.delete(id);
      } catch (error) {
        // Обязательный балун ещё не показан (409): строка остаётся, остальные удаляются.
        if (error instanceof ApiError && error.status === 409) continue;
        throw error;
      }
      invalidatePendingRefresh();
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
    deletable: notification.balloonPending !== true,
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
