import { useNotificationStore } from '../stores/notificationStore';
import type { NotificationLevel } from '../stores/notificationStore';
import { authStorage } from './auth';

/**
 * Утилита для логирования ошибок и сообщений в систему уведомлений
 */

/**
 * Логирует ошибку GraphQL/Hasura в систему уведомлений
 */
export const logGraphQLError = (error: any, context?: string) => {
  const { addNotification } = useNotificationStore.getState();
  const user = authStorage.getUser();

  const message = error?.message || 'Неизвестная ошибка GraphQL';
  const fullMessage = context ? `${context}: ${message}` : message;

  addNotification(fullMessage, 'error', user?.id ? { userId: user.id } : { isSystem: false });
};

/**
 * Логирует ошибку авторизации в систему уведомлений
 */
export const logAuthError = (error: any, context?: string) => {
  const { addNotification } = useNotificationStore.getState();
  const user = authStorage.getUser();

  const message = error?.message || 'Ошибка авторизации';
  const fullMessage = context ? `${context}: ${message}` : message;

  addNotification(fullMessage, 'error', user?.id ? { userId: user.id } : { isSystem: false });
};

/**
 * Логирует общую ошибку в систему уведомлений
 */
export const logError = (
  message: string,
  level: NotificationLevel = 'error',
  isSystemWide: boolean = false
) => {
  const { addNotification } = useNotificationStore.getState();
  const user = authStorage.getUser();

  if (isSystemWide) {
    addNotification(message, level, { isSystem: true });
  } else {
    addNotification(message, level, user?.id ? { userId: user.id } : { isSystem: false });
  }
};

/**
 * Логирует успешную операцию
 */
export const logSuccess = (message: string, isSystemWide: boolean = false) => {
  logError(message, 'info', isSystemWide);
};

/**
 * Логирует предупреждение
 */
export const logWarning = (message: string, isSystemWide: boolean = false) => {
  logError(message, 'warning', isSystemWide);
};
