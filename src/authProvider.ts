import type { AuthBindings } from '@refinedev/core';
import type { LoginCredentials, LoginResponse } from './types/auth';
import { authStorage, isTokenExpired, refreshAccessToken } from './utils/auth';
import { logAuthError } from './utils/notificationLogger';
import { useNotificationStore } from './stores/notificationStore';

/**
 * AuthProvider для Refine
 * Управляет аутентификацией пользователей через JWT токены
 */
export const authProvider: AuthBindings = {
  /**
   * Выполняет вход пользователя
   * Вызывает /api/login и сохраняет токены в localStorage
   *
   * Примечание: AuthPage передает "email", но API ожидает "username"
   */
  login: async (credentials: any) => {
    try {
      // AuthPage передает "email", но наш API ожидает "username"
      const username = credentials.username || credentials.email;
      const { password } = credentials;

      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        const error = await response.json();
        const errorMessage = error.error || 'Неверный логин или пароль';

        // Логируем ошибку входа
        logAuthError({ message: errorMessage }, 'Вход в систему');

        return {
          success: false,
          error: {
            message: errorMessage,
            name: 'LoginError',
          },
        };
      }

      const data: LoginResponse = await response.json();

      // Сохранить токены и данные пользователя в localStorage
      authStorage.setTokens(data);

      return {
        success: true,
        redirectTo: '/',
      };
    } catch (error) {
      console.error('Login error:', error);

      // Логируем сетевую ошибку
      logAuthError(error, 'Подключение к серверу');

      return {
        success: false,
        error: {
          message: 'Ошибка подключения к серверу',
          name: 'NetworkError',
        },
      };
    }
  },

  /**
   * Выполняет выход пользователя
   * Очищает токены из localStorage и личные уведомления
   */
  logout: async () => {
    // Получаем userId перед очисткой authStorage
    const user = authStorage.getUser();

    // Очищаем токены
    authStorage.clear();

    // Очищаем личные уведомления пользователя (оставляем системные)
    if (user?.id) {
      const { deleteAll } = useNotificationStore.getState();
      deleteAll(user.id);
    }

    return {
      success: true,
      redirectTo: '/login',
    };
  },

  /**
   * Проверяет, аутентифицирован ли пользователь
   * Используется для защиты роутов
   */
  check: async () => {
    const token = authStorage.getAccessToken();

    if (!token) {
      return {
        authenticated: false,
        redirectTo: '/login',
        logout: true,
      };
    }

    // Проверить истечение токена
    if (isTokenExpired(token)) {
      // Попытаться обновить токен
      const newToken = await refreshAccessToken();

      if (!newToken) {
        return {
          authenticated: false,
          redirectTo: '/login',
          logout: true,
        };
      }
    }

    return {
      authenticated: true,
    };
  },

  /**
   * Обработчик ошибок (например, 401 Unauthorized)
   * Пытается обновить токен при 401 ошибке
   */
  onError: async (error) => {
    // Обработка 401 ошибок (Unauthorized)
    if (error?.statusCode === 401 || error?.message?.includes('Unauthorized')) {
      // Попытаться обновить токен
      const newToken = await refreshAccessToken();

      if (!newToken) {
        // Логируем неудачное обновление токена (сессия истекла)
        logAuthError(error, 'Сессия истекла');

        return {
          logout: true,
          redirectTo: '/login',
          error,
        };
      }

      // Токен обновлён, запрос может быть повторен
      return {};
    }

    // Логируем прочие ошибки
    if (error?.message) {
      logAuthError(error, 'Ошибка авторизации');
    }

    return { error };
  },

  /**
   * Возвращает данные текущего пользователя
   * Используется для отображения имени пользователя в UI
   */
  getIdentity: async () => {
    const user = authStorage.getUser();
    return user || null;
  },

  /**
   * Возвращает роль текущего пользователя
   * Используется для проверки прав доступа
   */
  getPermissions: async () => {
    const user = authStorage.getUser();
    return user?.role || null;
  },
};
