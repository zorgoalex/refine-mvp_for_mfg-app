import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type NotificationLevel = 'info' | 'warning' | 'error';

export interface Notification {
  id: string;
  message: string;
  level: NotificationLevel;
  timestamp: number;
  read: boolean;
  userId?: string; // для персональных уведомлений (undefined = системное)
  isSystem?: boolean; // системное уведомление (видно всем)
}

interface NotificationStore {
  notifications: Notification[];
  addNotification: (
    message: string,
    level: NotificationLevel,
    options?: { userId?: string; isSystem?: boolean }
  ) => void;
  getNotificationsForUser: (userId?: string) => Notification[];
  markAsRead: (ids: string | string[], userId?: string) => void;
  markAllAsRead: (userId?: string) => void;
  deleteNotification: (ids: string | string[], userId?: string) => void;
  deleteAll: (userId?: string) => void;
  getUnreadCount: (userId?: string) => number;
}

const MAX_NOTIFICATIONS = 100;

export const useNotificationStore = create<NotificationStore>()(
  persist(
    (set, get) => ({
      notifications: [],

      addNotification: (
        message: string,
        level: NotificationLevel,
        options?: { userId?: string; isSystem?: boolean }
      ) => {
        const notification: Notification = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          message,
          level,
          timestamp: Date.now(),
          read: false,
          userId: options?.userId,
          isSystem: options?.isSystem ?? false,
        };

        set((state) => {
          const updated = [notification, ...state.notifications];

          // Ограничение до 100 сообщений (удаляем старые)
          if (updated.length > MAX_NOTIFICATIONS) {
            return { notifications: updated.slice(0, MAX_NOTIFICATIONS) };
          }

          return { notifications: updated };
        });
      },

      getNotificationsForUser: (userId?: string) => {
        const { notifications } = get();

        if (!userId) {
          // Если пользователь не указан, показываем только системные
          return notifications.filter((n) => n.isSystem);
        }

        // Показываем системные + персональные для этого пользователя
        return notifications.filter(
          (n) => n.isSystem || n.userId === userId
        );
      },

      markAsRead: (ids: string | string[], userId?: string) => {
        const idsArray = Array.isArray(ids) ? ids : [ids];

        set((state) => ({
          notifications: state.notifications.map((n) => {
            // Помечаем только те уведомления которые доступны пользователю
            if (idsArray.includes(n.id)) {
              const canAccess = n.isSystem || !userId || n.userId === userId;
              return canAccess ? { ...n, read: true } : n;
            }
            return n;
          }),
        }));
      },

      markAllAsRead: (userId?: string) => {
        set((state) => ({
          notifications: state.notifications.map((n) => {
            // Помечаем только доступные пользователю уведомления
            const canAccess = n.isSystem || !userId || n.userId === userId;
            return canAccess ? { ...n, read: true } : n;
          }),
        }));
      },

      deleteNotification: (ids: string | string[], userId?: string) => {
        const idsArray = Array.isArray(ids) ? ids : [ids];

        set((state) => ({
          notifications: state.notifications.filter((n) => {
            // Если это не тот ID который мы хотим удалить, оставляем
            if (!idsArray.includes(n.id)) {
              return true;
            }

            // Если это ID который мы хотим удалить:
            // - Системные уведомления НЕ удаляем (только если userId не указан - admin mode)
            if (n.isSystem && userId) {
              return true; // не удаляем системные для обычных пользователей
            }

            // - Персональные уведомления удаляем только если они принадлежат этому пользователю
            if (n.userId && n.userId !== userId) {
              return true; // не удаляем чужие уведомления
            }

            // Удаляем
            return false;
          }),
        }));
      },

      deleteAll: (userId?: string) => {
        if (!userId) {
          // Если userId не указан, удаляем ВСЕ уведомления (только для admin)
          set({ notifications: [] });
        } else {
          // Удаляем только личные уведомления пользователя
          // Оставляем: системные + чужие личные
          set((state) => ({
            notifications: state.notifications.filter(
              (n) => n.isSystem || (n.userId && n.userId !== userId)
            ),
          }));
        }
      },

      getUnreadCount: (userId?: string) => {
        const userNotifications = get().getNotificationsForUser(userId);
        return userNotifications.filter((n) => !n.read).length;
      },
    }),
    {
      name: 'notification-storage', // localStorage key
      version: 1,
    }
  )
);
