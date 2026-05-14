import { getPermissionsForRole, mapRoleIdToRole } from '../../permissions/permissions';
import type { CurrentUser } from '../../permissions/current-user';
import { InvalidCredentialsError, UnknownRoleError, UserInactiveError } from './auth.errors';
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

export interface AuthServicePorts {
  users: AuthUserRepositoryPort;
  passwords: PasswordVerifierPort;
  sessions: SessionManagerPort;
  tokens: AccessTokenIssuerPort;
  audit: AuthAuditPort;
}

export class AuthService {
  constructor(private readonly ports: AuthServicePorts) {}

  async login(command: LoginCommand): Promise<LoginResult> {
    const username = command.username.trim();
    const user = await this.ports.users.findByUsername(username);

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

    const session = await this.ports.sessions.createLoginSession(user, {
      userAgent: command.userAgent,
      ipAddress: command.ipAddress,
      requestId: command.requestId,
    });
    const currentUser = this.toCurrentUser(user, session.sessionId);
    const accessToken = await this.ports.tokens.issueAccessToken(currentUser);

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
    reason: 'unknown_user' | 'invalid_password' | 'inactive_user',
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
