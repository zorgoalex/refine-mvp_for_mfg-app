/**
 * Типы для системы аутентификации
 */

/**
 * Учетные данные для входа
 */
export interface LoginCredentials {
  username: string;
  password: string;
}

/**
 * Пара JWT токенов
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Информация о пользователе
 */
export interface UserIdentity {
  id: string;
  username: string;
  role: string;
  role_id?: number; // Опциональный ID роли (1=admin, 2=manager, 3=viewer)
}

/**
 * Ответ от endpoint /api/login
 */
export interface LoginResponse extends AuthTokens {
  user: UserIdentity;
}

/**
 * Ответ от endpoint /api/refresh
 */
export interface RefreshResponse extends AuthTokens {}
