import { NotificationProvider } from '@refinedev/core';
import { notificationProvider as antdNotificationProvider } from '@refinedev/antd';
import { useNotificationStore } from '../stores/notificationStore';
import type { NotificationLevel } from '../stores/notificationStore';
import { authStorage } from '../utils/auth';

/**
 * Кастомный notificationProvider который дублирует все сообщения
 * в систему уведомлений (колокольчик в header)
 */
export const createNotificationProvider = (): NotificationProvider => {
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

      // Получаем текущего пользователя динамически
      const currentUser = authStorage.getUser();

      // Добавляем в store
      const addNotification = useNotificationStore.getState().addNotification;
      // Все уведомления - личные (привязаны к текущему пользователю)
      addNotification(fullMessage, level, currentUser?.id ? { userId: currentUser.id } : { isSystem: false });
    },

    close: (key) => {
      defaultProvider.close?.(key);
    },
  };
};
