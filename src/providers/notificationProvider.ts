import { NotificationProvider } from '@refinedev/core';
import { notificationProvider as antdNotificationProvider } from '@refinedev/antd';
import { useNotificationStore } from '../stores/notificationStore';
import type { NotificationLevel } from '../stores/notificationStore';

/**
 * Кастомный notificationProvider который дублирует все сообщения
 * в систему уведомлений (колокольчик в header)
 */
export const createNotificationProvider = (
  userId?: string
): NotificationProvider => {
  // Получаем стандартный provider от Ant Design
  const defaultProvider = antdNotificationProvider;

  return {
    open: (params) => {
      // Вызываем стандартное поведение (всплывающее уведомление)
      defaultProvider.open?.(params);

      // Добавляем в persistent лог уведомлений
      const { message, description, type } = params;

      // Определяем уровень для нашей системы
      let level: NotificationLevel = 'info';
      if (type === 'error') {
        level = 'error';
      } else if (type === 'progress') {
        level = 'warning';
      }

      // Формируем текст сообщения
      const fullMessage = description
        ? `${message}: ${description}`
        : message;

      // Добавляем в store
      const addNotification = useNotificationStore.getState().addNotification;
      addNotification(fullMessage, level, userId ? { userId } : { isSystem: true });
    },

    close: (key) => {
      defaultProvider.close?.(key);
    },
  };
};
