import type { AuthTokens, UserIdentity } from '../types/auth';
import { authApi } from '../api/authApi';
import { authSession } from '../api/authSession';
import {
  ACCESS_TOKEN_REFRESH_WINDOW_MS,
  canUseAccessTokenAfterEarlyRefreshFailure,
  getJwtExpirationTime,
} from '../api/httpClient';
import { legacyApiRoutes } from '../api/legacyApiRoutes';
import { featureFlags } from '../config/featureFlags';

/**
 * Ключи для хранения в localStorage
 */
const ACCESS_TOKEN_KEY = 'access_token';
const REFRESH_TOKEN_KEY = 'refresh_token';
const USER_KEY = 'user';

/**
 * Утилиты для работы с аутентификацией и хранением токенов
 */
export const authStorage = {
  /**
   * Получить Access Token из localStorage
   */
  getAccessToken(): string | null {
    if (featureFlags.useBackendAuth) {
      return authSession.getAccessToken();
    }

    return localStorage.getItem(ACCESS_TOKEN_KEY);
  },

  /**
   * Сохранить Access Token в localStorage
   */
  setAccessToken(token: string): void {
    if (featureFlags.useBackendAuth) {
      authSession.setAccessToken(token);
      return;
    }

    localStorage.setItem(ACCESS_TOKEN_KEY, token);
  },

  /**
   * Получить Refresh Token из localStorage
   */
  getRefreshToken(): string | null {
    if (featureFlags.useBackendAuth) {
      return null;
    }

    return localStorage.getItem(REFRESH_TOKEN_KEY);
  },

  /**
   * Сохранить Refresh Token в localStorage
   */
  setRefreshToken(token: string): void {
    if (featureFlags.useBackendAuth) {
      return;
    }

    localStorage.setItem(REFRESH_TOKEN_KEY, token);
  },

  /**
   * Получить данные пользователя из localStorage
   */
  getUser(): UserIdentity | null {
    if (featureFlags.useBackendAuth) {
      return authSession.getUser();
    }

    const user = localStorage.getItem(USER_KEY);
    return user ? JSON.parse(user) : null;
  },

  /**
   * Сохранить данные пользователя в localStorage
   */
  setUser(user: UserIdentity): void {
    if (featureFlags.useBackendAuth) {
      authSession.setUser(user);
      return;
    }

    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },

  /**
   * Сохранить все данные аутентификации (токены + пользователь)
   */
  setTokens(data: AuthTokens & { user: UserIdentity }): void {
    if (featureFlags.useBackendAuth) {
      authSession.setAccessToken(data.accessToken);
      authSession.setUser(data.user);
      return;
    }

    this.setAccessToken(data.accessToken);
    this.setRefreshToken(data.refreshToken);
    this.setUser(data.user);
  },

  /**
   * Очистить все данные аутентификации
   */
  clear(): void {
    authSession.clear();
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

/**
 * Проверяет, истёк ли JWT или вошёл в окно заблаговременного обновления.
 * @param token JWT токен
 * @returns true если токен пора обновить или он невалиден
 */
export function isTokenExpired(token: string): boolean {
  const expiresAt = getJwtExpirationTime(token);
  return expiresAt === null || expiresAt <= Date.now() + ACCESS_TOKEN_REFRESH_WINDOW_MS;
}

/**
 * Обновляет Access Token используя Refresh Token
 * В backend auth режиме использует cookie-backed /api/v1/auth/refresh.
 * Legacy localStorage refresh token flow uses the legacy refresh endpoint only for flag-off mode.
 * @returns новый Access Token или null при ошибке
 */
export async function refreshAccessToken(): Promise<string | null> {
  if (featureFlags.useBackendAuth) {
    try {
      const data = await authApi.refresh();
      return data.accessToken;
    } catch (error) {
      const currentToken = authSession.getAccessToken();
      if (currentToken && canUseAccessTokenAfterEarlyRefreshFailure(currentToken, error)) {
        return currentToken;
      }
      console.error('Backend token refresh error:', error);
      authStorage.clear();
      authSession.expire();
      return null;
    }
  }

  const refreshToken = authStorage.getRefreshToken();

  if (!refreshToken) {
    console.warn('No refresh token available');
    return null;
  }

  try {
    const response = await fetch(legacyApiRoutes.auth.refresh, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      console.error('Token refresh failed:', response.status);
      authStorage.clear();
      return null;
    }

    const data = await response.json();

    // Сохранить новые токены
    authStorage.setAccessToken(data.accessToken);
    authStorage.setRefreshToken(data.refreshToken);

    return data.accessToken;
  } catch (error) {
    console.error('Token refresh error:', error);
    authStorage.clear();
    return null;
  }
}
