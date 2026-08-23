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

export type AuthorizationScope = 'all' | 'own' | 'assigned' | 'none';

export interface AuthorizationPolicyScopes {
  orders: Record<'view' | 'update' | 'export' | 'delete', AuthorizationScope>;
  payments: Record<'view' | 'create' | 'update' | 'delete', AuthorizationScope>;
  productionTasks: Record<'view' | 'update', AuthorizationScope>;
}

/**
 * Информация о пользователе
 */
export interface UserIdentity {
  id: string;
  username: string;
  role: string;
  roleId?: number;
  role_id?: number; // Legacy DB role id: 2=superadmin, 1=admin, 10=manager, 11=operator, 15=top_manager, 20=worker, 30=packer, 100=viewer
  permissions?: string[];
  permissionsVersion?: number;
  policyScopes?: AuthorizationPolicyScopes;
}

/**
 * Ответ от legacy login endpoint
 */
export interface LoginResponse extends AuthTokens {
  user: UserIdentity;
}

/**
 * Ответ от legacy refresh endpoint
 */
export interface RefreshResponse extends AuthTokens {}
