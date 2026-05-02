import type { AuthBindings } from '@refinedev/core';
import type { LoginCredentials, LoginResponse } from './types/auth';
import { authStorage, isTokenExpired, refreshAccessToken } from './utils/auth';
import { logAuthError } from './utils/notificationLogger';
import { useNotificationStore } from './stores/notificationStore';
import { authApi } from './api/authApi';
import { authSession } from './api/authSession';
import { featureFlags } from './config/featureFlags';

/**
 * AuthProvider для Refine
 * Управляет аутентификацией пользователей через JWT токены
 */
export const authProvider: AuthBindings = {
  /**
   * Выполняет вход пользователя
   * Вызывает /api/login и сохраняет токены в localStorage
   */
  login: async (credentials: any) => {
    if (featureFlags.useBackendAuth) {
      return loginWithBackend(credentials);
    }

    try {
      const { username, password } = credentials;

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
    if (featureFlags.useBackendAuth) {
      return logoutFromBackend();
    }

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
    if (featureFlags.useBackendAuth) {
      return checkBackendAuth();
    }

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
    if (featureFlags.useBackendAuth) {
      return handleBackendAuthError(error);
    }

    // Проверка на ошибку отсутствия авторизации от Hasura
    const isAuthMissingError =
      error?.message?.includes('Missing') && error?.message?.includes('Authorization') ||
      error?.message?.includes('JWT') ||
      error?.statusCode === 400 && error?.message?.includes('authentication');

    // Обработка 401 ошибок (Unauthorized) или ошибок отсутствия токена
    if (error?.statusCode === 401 || error?.message?.includes('Unauthorized') || isAuthMissingError) {
      // Попытаться обновить токен
      const newToken = await refreshAccessToken();

      if (!newToken) {
        // Создаём понятную ошибку для пользователя
        const userFriendlyError = {
          message: 'Сессия истекла',
          name: 'SessionExpired',
          statusCode: error?.statusCode,
        };

        // Логируем неудачное обновление токена (сессия истекла)
        logAuthError(userFriendlyError, 'Сессия истекла. Пожалуйста, войдите в систему заново.');

        return {
          logout: true,
          redirectTo: '/login',
          error: userFriendlyError,
        };
      }

      // Токен обновлён, запрос может быть повторен
      return {};
    }

    // Логируем прочие ошибки с понятным сообщением
    if (error?.message) {
      // Преобразуем технические сообщения в понятные
      let userMessage = error.message;
      if (error.message.includes('network') || error.message.includes('fetch')) {
        userMessage = 'Ошибка сети. Проверьте подключение к интернету.';
      } else if (error.message.includes('timeout')) {
        userMessage = 'Сервер не отвечает. Попробуйте позже.';
      }

      logAuthError({ ...error, message: userMessage }, 'Ошибка');
    }

    return { error };
  },

  /**
   * Возвращает данные текущего пользователя
   * Используется для отображения имени пользователя в UI
   */
  getIdentity: async () => {
    if (featureFlags.useBackendAuth) {
      return ensureBackendUser();
    }

    const user = authStorage.getUser();
    return user || null;
  },

  /**
   * Возвращает роль текущего пользователя
   * Используется для проверки прав доступа
   */
  getPermissions: async () => {
    if (featureFlags.useBackendAuth) {
      const user = await ensureBackendUser();
      return user?.permissions || [];
    }

    const user = authStorage.getUser();
    return user?.role || null;
  },
};

async function loginWithBackend(credentials: LoginCredentials) {
  try {
    const { username, password } = credentials;
    await authApi.login({ username, password });

    return {
      success: true,
      redirectTo: '/',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неверный логин или пароль';
    logAuthError({ message: errorMessage }, 'Вход в систему');

    return {
      success: false,
      error: {
        message: errorMessage,
        name: 'LoginError',
      },
    };
  }
}

async function logoutFromBackend() {
  const user = authSession.getUser();

  try {
    await authApi.logout();
  } catch (error) {
    logAuthError(error, 'Выход из системы');
  } finally {
    authSession.clear();
    authStorage.clear();

    if (user?.id) {
      const { deleteAll } = useNotificationStore.getState();
      deleteAll(user.id);
    }
  }

  return {
    success: true,
    redirectTo: '/login',
  };
}

async function checkBackendAuth() {
  if (authSession.getAccessToken()) {
    return {
      authenticated: true,
    };
  }

  try {
    await authApi.refresh();
    return {
      authenticated: true,
    };
  } catch {
    authSession.clear();
    authStorage.clear();
    return {
      authenticated: false,
      redirectTo: '/login',
      logout: true,
    };
  }
}

async function handleBackendAuthError(error: any) {
  const isAuthError =
    error?.status === 401 ||
    error?.statusCode === 401 ||
    error?.message?.includes('Unauthorized') ||
    error?.message?.includes('JWT') ||
    error?.message?.includes('Missing');

  if (!isAuthError) {
    return { error };
  }

  try {
    await authApi.refresh();
    return {};
  } catch {
    const userFriendlyError = {
      message: 'Сессия истекла',
      name: 'SessionExpired',
      statusCode: error?.statusCode ?? error?.status,
    };
    logAuthError(userFriendlyError, 'Сессия истекла. Пожалуйста, войдите в систему заново.');

    return {
      logout: true,
      redirectTo: '/login',
      error: userFriendlyError,
    };
  }
}

async function ensureBackendUser() {
  const cachedUser = authSession.getUser();
  if (cachedUser) return cachedUser;

  try {
    const { user } = await authApi.me();
    return user;
  } catch {
    try {
      const { user } = await authApi.refresh();
      return user;
    } catch {
      authSession.clear();
      authStorage.clear();
      return null;
    }
  }
}
