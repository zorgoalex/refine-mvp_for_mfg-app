import type { AuthBindings } from '@refinedev/core';
import type { LoginCredentials, LoginResponse } from './types/auth';
import { authStorage, isTokenExpired, refreshAccessToken } from './utils/auth';

/**
 * AuthProvider для Refine
 * Управляет аутентификацией пользователей через JWT токены
 */
export const authProvider: AuthBindings = {
  /**
   * Выполняет вход пользователя
   * Вызывает /api/login и сохраняет токены в localStorage
   */
  login: async ({ username, password }: LoginCredentials) => {
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        const error = await response.json();
        return {
          success: false,
          error: {
            message: error.error || 'Неверный логин или пароль',
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
   * Очищает токены из localStorage
   */
  logout: async () => {
    authStorage.clear();
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
        return {
          logout: true,
          redirectTo: '/login',
          error,
        };
      }

      // Токен обновлён, запрос может быть повторен
      return {};
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
