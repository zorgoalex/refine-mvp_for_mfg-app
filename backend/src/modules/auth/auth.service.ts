import { getPermissionsForRole, mapRoleIdToRole } from '../../permissions/permissions';
import type { CurrentUser } from '../../permissions/current-user';
import {
  InvalidCredentialsError,
  LoginMethodNotAllowedError,
  UnknownRoleError,
  UserInactiveError,
} from './auth.errors';
import type {
  AccessTokenIssuerPort,
  AuthResponse,
  AuthAuditPort,
  AuthUserRecord,
  AuthUserRepositoryPort,
  LoginCommand,
  LoginResult,
  PasswordVerifierPort,
  SessionManagerPort,
} from './auth.types';
import type { RateLimitConsumeInput } from '../../rate-limit/rate-limit.types';

export interface LoginRateLimitPort {
  /** Throws 429 when the budget is spent. */
  assertAllowed(input: RateLimitConsumeInput): Promise<void>;
  /** Best-effort return of one consumed attempt. */
  refund(input: RateLimitConsumeInput): Promise<void>;
}

export interface AuthServicePorts {
  users: AuthUserRepositoryPort;
  passwords: PasswordVerifierPort;
  sessions: SessionManagerPort;
  tokens: AccessTokenIssuerPort;
  audit: AuthAuditPort;
  rateLimits: LoginRateLimitPort;
}

export class AuthService {
  constructor(private readonly ports: AuthServicePorts) {}

  async login(command: LoginCommand): Promise<LoginResult> {
    const username = command.username.trim();
    const user = await this.ports.users.findByUsername(username);

    // Per-account fail budget on the CANONICAL account key: the lookup
    // accepts username OR email, so both aliases of one account must share
    // one bucket (user_id); unknown identifiers bucket on the submitted
    // value. Consumed before the password check, refunded on success — only
    // failures accumulate (20 fails/hour).
    const accountLimit: RateLimitConsumeInput = {
      rule: { feature: 'auth_login_account', maxRequests: 20, windowMs: 3_600_000 },
      subject: user
        ? { route: 'auth/login', userId: user.id }
        : { route: 'auth/login', username: username.toLowerCase() },
    };
    await this.ports.rateLimits.assertAllowed(accountLimit);

    if (!user) {
      await this.writeLoginFailed(command, username, 'unknown_user');
      throw new InvalidCredentialsError();
    }

    const passwordValid = await this.ports.passwords.verify(command.password, user.passwordHash);

    if (!passwordValid) {
      await this.writeLoginFailed(command, username, 'invalid_password', user);
      throw new InvalidCredentialsError();
    }

    if (!user.isActive) {
      await this.writeLoginFailed(command, username, 'inactive_user', user);
      throw new UserInactiveError();
    }

    if (user.loginPolicy === 'external') {
      await this.writeLoginFailed(command, username, 'login_method_not_allowed', user);
      throw new LoginMethodNotAllowedError();
    }

    let session;

    try {
      session = await this.ports.sessions.createLoginSession(user, {
        userAgent: command.userAgent,
        ipAddress: command.ipAddress,
        requestId: command.requestId,
      });
    } catch (error) {
      // The in-transaction guard denied at the last moment (account
      // deactivated / tightened to external-only during bcrypt) — keep the
      // audit contract for these denials too.
      if (error instanceof UserInactiveError) {
        await this.writeLoginFailed(command, username, 'inactive_user', user);
      } else if (error instanceof LoginMethodNotAllowedError) {
        await this.writeLoginFailed(command, username, 'login_method_not_allowed', user);
      }
      throw error;
    }
    await this.ports.rateLimits.refund(accountLimit);
    const currentUser = this.toCurrentUser(user, session.sessionId);
    const accessToken = await this.ports.tokens.issueAccessToken(currentUser, {
      notAfter: session.refreshTokenExpiresAt,
    });

    return {
      response: this.toAuthResponse(currentUser, accessToken),
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    };
  }

  private toCurrentUser(user: AuthUserRecord, sessionId: string): CurrentUser {
    const role = mapRoleIdToRole(user.roleId);

    if (!role) {
      throw new UnknownRoleError(user.roleId);
    }

    return {
      id: user.id,
      username: user.username,
      role,
      roleId: user.roleId,
      permissions: getPermissionsForRole(role),
      sessionId,
    };
  }

  private async writeLoginFailed(
    command: LoginCommand,
    username: string,
    reason: 'unknown_user' | 'invalid_password' | 'inactive_user' | 'login_method_not_allowed',
    user?: AuthUserRecord,
  ): Promise<void> {
    await this.ports.audit.writeLoginFailed({
      username,
      user,
      reason,
      requestId: command.requestId,
      userAgent: command.userAgent,
      ipAddress: command.ipAddress,
    });
  }

  private toAuthResponse(
    user: CurrentUser,
    issuedAccessToken: { accessToken: string; expiresAt: Date },
  ): AuthResponse {
    return {
      accessToken: issuedAccessToken.accessToken,
      accessTokenExpiresAt: issuedAccessToken.expiresAt.toISOString(),
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        roleId: user.roleId,
        permissions: user.permissions,
      },
    };
  }
}
