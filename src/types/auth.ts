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
  roleId?: number;
  role_id?: number; // Legacy DB role id: 2=superadmin, 1=admin, 10=manager, 11=operator, 15=top_manager, 20=worker, 100=viewer
  permissions?: string[];
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
