import type { CurrentUser } from '../../permissions/current-user';
import type { PermissionName, UserRole } from '../../permissions/permissions';

export interface LoginCommand {
  username: string;
  password: string;
  userAgent?: string;
  ipAddress?: string;
  requestId?: string;
}

export interface AuthUserRecord {
  id: string;
  username: string;
  roleId: number;
  passwordHash: string;
  isActive: boolean;
}

export interface AuthSessionRecord {
  sessionId: string;
  userId: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface AuthUserRepositoryPort {
  findByUsername(username: string): Promise<AuthUserRecord | null>;
}

export interface PasswordVerifierPort {
  verify(password: string, passwordHash: string): Promise<boolean>;
}

export interface SessionManagerPort {
  createLoginSession(
    user: AuthUserRecord,
    context: Pick<LoginCommand, 'userAgent' | 'ipAddress' | 'requestId'>,
  ): Promise<AuthSessionRecord>;
}

export interface AuthAuditPort {
  writeLoginFailed(input: {
    username: string;
    user?: Pick<AuthUserRecord, 'id' | 'username' | 'roleId' | 'isActive'>;
    reason: 'unknown_user' | 'invalid_password' | 'inactive_user';
    requestId?: string;
    userAgent?: string;
    ipAddress?: string;
  }): Promise<void>;
}

export interface AccessTokenIssuerPort {
  issueAccessToken(user: CurrentUser): Promise<IssuedAccessToken>;
}

export interface IssuedAccessToken {
  accessToken: string;
  expiresAt: Date;
}

export interface AuthResponseUser {
  id: string;
  username: string;
  role: UserRole;
  roleId: number;
  permissions: readonly PermissionName[];
}

export interface AuthResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  user: AuthResponseUser;
}

export interface LoginResult {
  response: AuthResponse;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}
