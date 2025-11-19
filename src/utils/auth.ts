import type { AuthTokens, UserIdentity } from '../types/auth';

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
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  },

  /**
   * Сохранить Access Token в localStorage
   */
  setAccessToken(token: string): void {
    localStorage.setItem(ACCESS_TOKEN_KEY, token);
  },

  /**
   * Получить Refresh Token из localStorage
   */
  getRefreshToken(): string | null {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  },

  /**
   * Сохранить Refresh Token в localStorage
   */
  setRefreshToken(token: string): void {
    localStorage.setItem(REFRESH_TOKEN_KEY, token);
  },

  /**
   * Получить данные пользователя из localStorage
   */
  getUser(): UserIdentity | null {
    const user = localStorage.getItem(USER_KEY);
    return user ? JSON.parse(user) : null;
  },

  /**
   * Сохранить данные пользователя в localStorage
   */
  setUser(user: UserIdentity): void {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },

  /**
   * Сохранить все данные аутентификации (токены + пользователь)
   */
  setTokens(data: AuthTokens & { user: UserIdentity }): void {
    this.setAccessToken(data.accessToken);
    this.setRefreshToken(data.refreshToken);
    this.setUser(data.user);
  },

  /**
   * Очистить все данные аутентификации
   */
  clear(): void {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

/**
 * Проверяет, истек ли срок действия JWT токена
 * @param token JWT токен
 * @returns true если токен истек или невалиден
 */
export function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));

    // exp в JWT указан в секундах, Date.now() возвращает миллисекунды
    return payload.exp * 1000 < Date.now();
  } catch (error) {
    console.error('Token validation failed:', error);
    return true;
  }
}

/**
 * Обновляет Access Token используя Refresh Token
 * Вызывает /api/refresh endpoint
 * @returns новый Access Token или null при ошибке
 */
export async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = authStorage.getRefreshToken();

  if (!refreshToken) {
    console.warn('No refresh token available');
    return null;
  }

  try {
    const response = await fetch('/api/refresh', {
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
