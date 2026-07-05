import type { CurrentUser } from '../../permissions/current-user';
import type { PermissionName, UserRole } from '../../permissions/permissions';

export interface LoginCommand {
  username: string;
  password: string;
  userAgent?: string;
  ipAddress?: string;
  requestId?: string;
}

export type LoginPolicy = 'local' | 'external' | 'both';

export type AuthSource = 'backend' | 'workos';

export interface AuthUserRecord {
  id: string;
  username: string;
  roleId: number;
  passwordHash: string;
  isActive: boolean;
  loginPolicy: LoginPolicy;
  /** Present when the loader selects it (used for SSO email-drift auditing). */
  email?: string | null;
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

export interface LoginSessionContext extends Pick<LoginCommand, 'userAgent' | 'ipAddress' | 'requestId'> {
  /** Written to the first-class audit_log.source column ('backend' when absent). */
  authSource?: AuthSource;
  /** External provider session id, persisted for provider-side logout. */
  providerSessionId?: string;
  /** Extra queryable fields merged into the auth.login.success audit metadata. */
  auditMetadata?: Record<string, unknown>;
  /**
   * SSO login: the identity link is re-proven INSIDE the session transaction
   * (provider+sub still owned by this user) — a concurrent unlink/relink
   * between the exchange and the session insert must deny.
   */
  requireLinkedIdentity?: { provider: string; providerUserId: string };
}

export interface SessionManagerPort {
  createLoginSession(user: AuthUserRecord, context: LoginSessionContext): Promise<AuthSessionRecord>;
}

export type LoginFailedReason =
  | 'unknown_user'
  | 'invalid_password'
  | 'inactive_user'
  | 'login_method_not_allowed'
  | 'email_not_verified'
  | 'identity_not_linked'
  | 'provider_error'
  | 'state_mismatch';

export interface AuthAuditPort {
  writeLoginFailed(input: {
    username: string;
    user?: Pick<AuthUserRecord, 'id' | 'username' | 'roleId' | 'isActive'>;
    /** Resolved account id when known WITHOUT a loadable user row (stale link). */
    relatedUserId?: string;
    reason: LoginFailedReason;
    requestId?: string;
    userAgent?: string;
    ipAddress?: string;
    authSource?: AuthSource;
    metadata?: Record<string, unknown>;
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
