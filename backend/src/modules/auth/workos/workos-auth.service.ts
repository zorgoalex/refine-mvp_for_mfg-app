import { ApiError } from '../../../common/errors/api-error';
import { getPermissionsForRole, mapRoleIdToRole } from '../../../permissions/permissions';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  InvalidCredentialsError,
  LoginMethodNotAllowedError,
  UnknownRoleError,
  UserInactiveError,
} from '../auth.errors';
import type {
  AccessTokenIssuerPort,
  AuthAuditPort,
  AuthResponse,
  AuthUserRecord,
  AuthUserRepositoryPort,
  LoginResult,
  PasswordVerifierPort,
  SessionManagerPort,
} from '../auth.types';
import type { PgUserIdentityRepository, UserIdentityRecord } from './pg-user-identity-repository';
import type { WorkosApiClient, WorkosIdentity } from './workos-api.client';

export const WORKOS_PROVIDER = 'workos';

export interface WorkosLoginCommand {
  code: string;
  userAgent?: string;
  ipAddress?: string;
  requestId?: string;
}

export interface WorkosLinkCommand extends WorkosLoginCommand {
  currentUser: CurrentUser;
}

export interface WorkosUnlinkCommand {
  currentUser: CurrentUser;
  password: string;
  userAgent?: string;
  ipAddress?: string;
  requestId?: string;
}

export interface WorkosAuthServicePorts {
  workos: WorkosApiClient;
  users: AuthUserRepositoryPort;
  identities: PgUserIdentityRepository;
  sessions: SessionManagerPort;
  tokens: AccessTokenIssuerPort;
  audit: AuthAuditPort;
  passwords: PasswordVerifierPort;
  /** Loads a user by internal id; used to re-check is_active at link time. */
  loadUserById: (userId: string) => Promise<AuthUserRecord | null>;
}

export class WorkosAuthService {
  constructor(private readonly ports: WorkosAuthServicePorts) {}

  /**
   * Login through an already linked identity. There is deliberately NO
   * email-based auto-link here (pre-account-hijacking): identities are
   * created only by the explicit link flow below or admin provisioning.
   */
  async loginWithCode(command: WorkosLoginCommand): Promise<LoginResult> {
    const identity = await this.ports.workos.authenticateWithCode(command.code);

    if (!identity.emailVerified) {
      await this.writeLoginFailed(command, identity, 'email_not_verified');
      throw new InvalidCredentialsError();
    }

    const link = await this.ports.identities.findByProviderSub(WORKOS_PROVIDER, identity.sub);

    if (!link) {
      await this.writeLoginFailed(command, identity, 'identity_not_linked');
      throw new ApiError(
        401,
        'IDENTITY_NOT_LINKED',
        'Вход через SSO не привязан. Войдите паролем и привяжите SSO в профиле, либо обратитесь к администратору.',
      );
    }

    const user = await this.ports.loadUserById(link.userId);

    if (!user) {
      await this.writeLoginFailed(command, identity, 'identity_not_linked');
      throw new InvalidCredentialsError();
    }

    if (!user.isActive) {
      await this.writeLoginFailed(command, identity, 'inactive_user', user);
      throw new UserInactiveError();
    }

    if (user.loginPolicy === 'local') {
      await this.writeLoginFailed(command, identity, 'login_method_not_allowed', user);
      throw new LoginMethodNotAllowedError();
    }

    const session = await this.ports.sessions.createLoginSession(user, {
      userAgent: command.userAgent,
      ipAddress: command.ipAddress,
      requestId: command.requestId,
      authSource: 'workos',
      providerSessionId: identity.providerSessionId ?? undefined,
    });
    void this.ports.identities.touchLastLogin(link.identityId).catch(() => undefined);

    const currentUser = this.toCurrentUser(user, session.sessionId, identity, link);
    const accessToken = await this.ports.tokens.issueAccessToken(currentUser);

    return {
      response: this.toAuthResponse(currentUser, accessToken),
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    };
  }

  /**
   * Self-serve link: possession is proven by the live bearer session at
   * callback time (the controller enforces bearer + state.sessionId match);
   * this method re-checks user activity and attaches the identity to the
   * CURRENT session's user, never by email match.
   */
  async linkWithCode(command: WorkosLinkCommand): Promise<{ linked: true }> {
    const actor = this.toActor(command);
    let identity: WorkosIdentity;

    try {
      identity = await this.ports.workos.authenticateWithCode(command.code);
    } catch (error) {
      await this.ports.identities.writeLinkFailed({
        actor,
        reason: 'provider_error',
        provider: WORKOS_PROVIDER,
      });
      throw error;
    }

    if (!identity.emailVerified) {
      await this.ports.identities.writeLinkFailed({
        actor,
        reason: 'email_not_verified',
        provider: WORKOS_PROVIDER,
        providerUserId: identity.sub,
        emailAtIdentity: identity.email,
      });
      throw new ApiError(401, 'EMAIL_NOT_VERIFIED', 'E-mail внешнего аккаунта не подтверждён');
    }

    const user = await this.ports.loadUserById(command.currentUser.id);

    if (!user || !user.isActive) {
      await this.ports.identities.writeLinkFailed({
        actor,
        reason: 'session_inactive',
        provider: WORKOS_PROVIDER,
        providerUserId: identity.sub,
      });
      throw new UserInactiveError();
    }

    const existing = await this.ports.identities.findByProviderSub(WORKOS_PROVIDER, identity.sub);

    if (existing && existing.userId !== user.id) {
      await this.ports.identities.writeLinkFailed({
        actor,
        reason: 'identity_conflict',
        provider: WORKOS_PROVIDER,
        providerUserId: identity.sub,
        emailAtIdentity: identity.email,
        conflictUserId: existing.userId,
      });
      throw new ApiError(409, 'IDENTITY_CONFLICT', 'Этот внешний аккаунт уже привязан к другому пользователю');
    }

    if (existing) {
      return { linked: true };
    }

    await this.ports.identities.insertLinkWithAudit({
      actor,
      provider: WORKOS_PROVIDER,
      providerUserId: identity.sub,
      emailAtLink: identity.email,
      emailVerified: identity.emailVerified,
      mode: 'self_serve',
    });

    return { linked: true };
  }

  /** Unlink requires password confirmation: after unlink only the password remains. */
  async unlink(command: WorkosUnlinkCommand): Promise<{ unlinked: boolean }> {
    const user = await this.ports.loadUserById(command.currentUser.id);

    if (!user || !user.isActive) {
      throw new UserInactiveError();
    }

    if (user.loginPolicy === 'external') {
      throw new ApiError(
        409,
        'UNLINK_FORBIDDEN_EXTERNAL_POLICY',
        'Нельзя отвязать SSO: вход по паролю для пользователя отключён',
      );
    }

    const passwordValid = await this.ports.passwords.verify(command.password, user.passwordHash);

    if (!passwordValid) {
      await this.ports.audit.writeLoginFailed({
        username: user.username,
        user,
        reason: 'invalid_password',
        requestId: command.requestId,
        userAgent: command.userAgent,
        ipAddress: command.ipAddress,
        metadata: { context: 'workos_unlink' },
      });
      throw new InvalidCredentialsError();
    }

    const unlinked = await this.ports.identities.deleteLinkWithAudit({
      actor: this.toActor(command),
      provider: WORKOS_PROVIDER,
    });

    return { unlinked };
  }

  buildAuthorizeUrl(state: string): string {
    return this.ports.workos.buildAuthorizeUrl(state);
  }

  buildProviderLogoutUrl(providerSessionId: string): string {
    return this.ports.workos.buildLogoutUrl(providerSessionId);
  }

  private toActor(command: { currentUser: CurrentUser } & Pick<WorkosLoginCommand, 'requestId' | 'userAgent' | 'ipAddress'>) {
    return {
      userId: command.currentUser.id,
      username: command.currentUser.username,
      roleId: command.currentUser.roleId,
      requestId: command.requestId,
      userAgent: command.userAgent,
      ipAddress: command.ipAddress,
    };
  }

  private async writeLoginFailed(
    command: WorkosLoginCommand,
    identity: WorkosIdentity,
    reason: 'email_not_verified' | 'identity_not_linked' | 'inactive_user' | 'login_method_not_allowed',
    user?: AuthUserRecord,
  ): Promise<void> {
    await this.ports.audit.writeLoginFailed({
      username: identity.email,
      user,
      reason,
      requestId: command.requestId,
      userAgent: command.userAgent,
      ipAddress: command.ipAddress,
      authSource: 'workos',
      metadata: { workosSub: identity.sub },
    });
  }

  private toCurrentUser(
    user: AuthUserRecord,
    sessionId: string,
    identity: WorkosIdentity,
    link: UserIdentityRecord,
  ): CurrentUser {
    const role = mapRoleIdToRole(user.roleId);

    if (!role) {
      throw new UnknownRoleError(user.roleId);
    }

    if (identity.email.toLowerCase() !== link.emailAtLink.toLowerCase()) {
      // Email drift at the provider is not a blocker (sub is the anchor) but
      // must stay visible for operations.
      // eslint-disable-next-line no-console
      console.warn(
        `[workos] identity email drift user_id=${user.id} linked=${link.emailAtLink} current=${identity.email}`,
      );
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

  private toAuthResponse(user: CurrentUser, issued: { accessToken: string; expiresAt: Date }): AuthResponse {
    return {
      accessToken: issued.accessToken,
      accessTokenExpiresAt: issued.expiresAt.toISOString(),
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
