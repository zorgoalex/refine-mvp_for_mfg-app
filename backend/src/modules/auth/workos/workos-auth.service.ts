import { createHash, randomBytes, randomUUID } from 'crypto';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import { getPermissionsForRole, mapRoleIdToRole } from '../../../permissions/permissions';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
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
import type {
  DeleteOneOutcome,
  InvitationCreateOutcome,
  InvitationRevokeOutcome,
  PgUserIdentityRepository,
  UserIdentityListItem,
  UserIdentityRecord,
  WorkosUserSettings,
} from './pg-user-identity-repository';
import type {
  WorkosApiClient,
  WorkosAuthorizeOptions,
  WorkosIdentity,
} from './workos-api.client';

export const WORKOS_PROVIDER = 'workos';
const MANAGE_SSO_PERMISSION: Parameters<PermissionsService['canUser']>[1] = 'users.manage_sso';

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

export interface WorkosUnlinkOwnCommand extends WorkosUnlinkCommand {
  identityId: string;
}

export interface WorkosAdminListLinksCommand {
  currentUser: CurrentUser;
  targetUserId: string;
  requestId?: string;
}

export interface WorkosAdminUnlinkCommand extends WorkosAdminListLinksCommand {
  identityId: string;
  reason?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface WorkosAdminUpdateSettingsCommand extends WorkosAdminListLinksCommand {
  settings: Partial<WorkosUserSettings>;
  userAgent?: string;
  ipAddress?: string;
}

export interface WorkosAdminCreateInvitationCommand extends WorkosAdminListLinksCommand {
  userAgent?: string;
  ipAddress?: string;
}

export interface WorkosAdminRevokeInvitationCommand extends WorkosAdminCreateInvitationCommand {}

export interface WorkosInvitationLinkCommand extends WorkosLoginCommand {
  invitationId: string;
}

export interface WorkosAuthServicePorts {
  workos: WorkosApiClient;
  users: AuthUserRepositoryPort;
  identities: PgUserIdentityRepository;
  sessions: SessionManagerPort;
  tokens: AccessTokenIssuerPort;
  audit: AuthAuditPort;
  passwords: PasswordVerifierPort;
  permissions: PermissionsService;
  deniedAudit: Pick<typeof auditService, 'recordDenied'>;
  database: DatabaseService;
  frontendOrigin: string;
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
    let identity: WorkosIdentity;

    try {
      identity = await this.ports.workos.authenticateWithCode(command.code);
    } catch (error) {
      // Audit contract §4.8: code-exchange failures on the LOGIN path are
      // auth.login.failed (source=workos); the actor is not resolved yet.
      await this.ports.audit.writeLoginFailed({
        username: 'unknown',
        reason: 'provider_error',
        requestId: command.requestId,
        userAgent: command.userAgent,
        ipAddress: command.ipAddress,
        authSource: 'workos',
      });
      throw error;
    }

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
      // Stale link (user row deleted mid-race): the account id is still
      // resolved from the link — keep it query-ready in the audit row.
      await this.writeLoginFailed(command, identity, 'identity_not_linked', undefined, link.userId);
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

    let session;

    try {
      session = await this.ports.sessions.createLoginSession(user, {
        userAgent: command.userAgent,
        ipAddress: command.ipAddress,
        requestId: command.requestId,
        authSource: 'workos',
        providerSessionId: identity.providerSessionId ?? undefined,
        // Plan §4.3: email drift never blocks (sub is the anchor) but must be
        // queryable in the auth.login.success audit metadata, not console-only.
        auditMetadata: this.emailDriftMetadata(identity, user, link),
        // Re-proven inside the session transaction: concurrent unlink/relink
        // between the exchange and the insert denies instead of logging in.
        requireLinkedIdentity: { provider: WORKOS_PROVIDER, providerUserId: identity.sub },
      });
    } catch (error) {
      // In-transaction guard denial (deactivated / policy flipped to
      // local-only mid-exchange / link removed mid-exchange) — keep the
      // audit contract.
      if (error instanceof UserInactiveError) {
        await this.writeLoginFailed(command, identity, 'inactive_user', user);
      } else if (error instanceof LoginMethodNotAllowedError) {
        await this.writeLoginFailed(command, identity, 'login_method_not_allowed', user);
      } else if (error instanceof ApiError && error.code === 'IDENTITY_NOT_LINKED') {
        await this.writeLoginFailed(command, identity, 'identity_not_linked', user);
      }
      throw error;
    }
    void this.ports.identities.touchLastLogin(link.identityId).catch(() => undefined);

    const currentUser = this.toCurrentUser(user, session.sessionId, identity, link);
    const accessToken = await this.ports.tokens.issueAccessToken(currentUser, {
      notAfter: session.refreshTokenExpiresAt,
    });

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

    // Plan §4.4(в): the bearer token alone is not enough — the JWT stays
    // valid until TTL after logout/revoke, so the DB session status must be
    // re-checked at callback time before any identity is attached.
    const sessionId = command.currentUser.sessionId;

    if (!sessionId || !(await this.ports.identities.isSessionActive(sessionId))) {
      await this.ports.identities.writeLinkFailed({
        actor,
        reason: 'session_inactive',
        provider: WORKOS_PROVIDER,
      });
      throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново и повторите привязку');
    }

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

    // NO pre-insert findByProviderSub fast-path: every outcome (including
    // the idempotent already-linked one) must pass the guarded insert, which
    // revalidates session/user in the same transaction — a session revoked
    // during the provider round-trip cannot get a 200 on any path.
    const outcome = await this.ports.identities.insertLinkWithAudit({
      actor,
      provider: WORKOS_PROVIDER,
      providerUserId: identity.sub,
      emailAtLink: identity.email,
      emailVerified: identity.emailVerified,
      authMethod: identity.authMethod,
      mode: 'self_serve',
      sessionId,
    });

    switch (outcome.status) {
      case 'linked':
      case 'already_linked':
        return { linked: true };
      case 'conflict':
        await this.ports.identities.writeLinkFailed({
          actor,
          reason: 'identity_conflict',
          provider: WORKOS_PROVIDER,
          providerUserId: identity.sub,
          emailAtIdentity: identity.email,
          conflictUserId: outcome.conflictUserId,
        });
        throw new ApiError(409, 'IDENTITY_CONFLICT', 'Этот внешний аккаунт уже привязан к другому пользователю');
      case 'session_inactive':
        await this.ports.identities.writeLinkFailed({
          actor,
          reason: 'session_inactive',
          provider: WORKOS_PROVIDER,
          providerUserId: identity.sub,
        });
        throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново и повторите привязку');
      case 'user_inactive':
        await this.ports.identities.writeLinkFailed({
          actor,
          reason: 'session_inactive',
          provider: WORKOS_PROVIDER,
          providerUserId: identity.sub,
        });
        throw new UserInactiveError();
      case 'self_link_disabled':
        throw new ApiError(
          403,
          'SSO_SELF_LINK_DISABLED',
          'Самостоятельная привязка SSO отключена администратором',
        );
    }
  }

  async assertSelfLinkAllowed(currentUser: CurrentUser): Promise<void> {
    if (!currentUser.sessionId || !(await this.ports.identities.isSessionActive(currentUser.sessionId))) {
      throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
    }

    const settings = await this.ports.identities.getUserSettings(currentUser.id);
    if (!settings) {
      throw new ApiError(404, 'USER_NOT_FOUND', 'Пользователь не найден');
    }
    if (!settings.selfLinkEnabled) {
      throw new ApiError(
        403,
        'SSO_SELF_LINK_DISABLED',
        'Самостоятельная привязка SSO отключена администратором',
      );
    }
  }

  async listOwnLinks(currentUser: CurrentUser): Promise<UserIdentityListItem[]> {
    // Fail fast on a sid-less/legacy bearer before touching the repo: a token
    // without a sessionId claim must not enumerate identity emails/auth methods.
    if (!currentUser.sessionId) {
      throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
    }
    await this.requireLiveSession(currentUser);
    return this.ports.identities.listLinks(currentUser.id, WORKOS_PROVIDER);
  }

  async getOwnSettings(currentUser: CurrentUser): Promise<WorkosUserSettings> {
    if (!currentUser.sessionId) {
      throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
    }
    await this.requireLiveSession(currentUser);
    const settings = await this.ports.identities.getUserSettings(currentUser.id);
    if (!settings) {
      throw new ApiError(404, 'USER_NOT_FOUND', 'Пользователь не найден');
    }
    return settings;
  }

  async unlinkOwn(command: WorkosUnlinkOwnCommand): Promise<{ unlinked: boolean }> {
    const sessionId = command.currentUser.sessionId;

    if (!sessionId) {
      throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
    }

    const user = await this.ports.loadUserById(command.currentUser.id);

    if (!user || !user.isActive) {
      throw new UserInactiveError();
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

    return this.mapDeleteOneOutcome(
      await this.ports.identities.deleteOneLinkWithAudit({
        identityId: command.identityId,
        targetUserId: command.currentUser.id,
        actor: this.toActor(command),
        actorSessionId: sessionId,
        provider: WORKOS_PROVIDER,
        mode: 'self_serve',
      }),
    );
  }

  async adminListLinks(command: WorkosAdminListLinksCommand): Promise<UserIdentityListItem[]> {
    // Same sid-less fail-fast as adminUnlink: a token without a live session
    // must not read another user's linked identities.
    if (!command.currentUser.sessionId) {
      throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
    }

    await this.requireLiveSession(command.currentUser);

    await this.requireManageSso(command, 'auth.identity.list_denied');

    const user = await this.ports.loadUserById(command.targetUserId);

    if (!user) {
      throw new ApiError(404, 'USER_NOT_FOUND', 'Пользователь не найден');
    }

    return this.ports.identities.listLinks(command.targetUserId, WORKOS_PROVIDER);
  }

  async adminGetSettings(command: WorkosAdminListLinksCommand): Promise<WorkosUserSettings> {
    await this.requireLiveSession(command.currentUser);
    await this.requireManageSso(command, 'auth.identity.settings_read_denied');

    const settings = await this.ports.identities.getUserSettings(command.targetUserId);
    if (!settings) {
      throw new ApiError(404, 'USER_NOT_FOUND', 'Пользователь не найден');
    }
    return settings;
  }

  async adminUpdateSettings(
    command: WorkosAdminUpdateSettingsCommand,
  ): Promise<WorkosUserSettings> {
    const sessionId = this.assertLiveAdminSession(command.currentUser);
    await this.requireManageSso(command, 'auth.identity.settings_update_denied');

    const outcome = await this.ports.identities.updateUserSettingsWithAudit({
      actor: this.toActor(command),
      actorSessionId: sessionId,
      targetUserId: command.targetUserId,
      settings: command.settings,
    });

    switch (outcome.status) {
      case 'updated':
        return outcome.settings;
      case 'not_found':
        throw new ApiError(404, 'USER_NOT_FOUND', 'Пользователь не найден');
      case 'session_inactive':
        throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
      case 'external_requires_identity':
        throw new ApiError(
          409,
          'SSO_IDENTITY_REQUIRED',
          'Для режима «только SSO» нужна хотя бы одна привязанная SSO-учётная запись',
        );
    }
  }

  async adminCreateInvitation(
    command: WorkosAdminCreateInvitationCommand,
  ): Promise<{ invitationUrl: string; expiresAt: string }> {
    const sessionId = this.assertLiveAdminSession(command.currentUser);
    await this.requireManageSso(command, 'auth.identity.invitation_create_denied');

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const outcome = await this.ports.identities.createLinkInvitationWithAudit({
      invitationId: randomUUID(),
      tokenHash: hashInvitationToken(token),
      expiresAt,
      targetUserId: command.targetUserId,
      actor: this.toActor(command),
      actorSessionId: sessionId,
    });
    const invitation = this.mapInvitationCreateOutcome(outcome);
    const invitationUrl = new URL('/auth/workos/invite', this.ports.frontendOrigin);
    invitationUrl.hash = new URLSearchParams({ token }).toString();

    return {
      invitationUrl: invitationUrl.toString(),
      expiresAt: invitation.expiresAt,
    };
  }

  async adminRevokeInvitations(
    command: WorkosAdminRevokeInvitationCommand,
  ): Promise<{ revoked: boolean }> {
    const sessionId = this.assertLiveAdminSession(command.currentUser);
    await this.requireManageSso(command, 'auth.identity.invitation_revoke_denied');

    const outcome = await this.ports.identities.revokeActiveLinkInvitationsWithAudit({
      targetUserId: command.targetUserId,
      actor: this.toActor(command),
      actorSessionId: sessionId,
    });

    return this.mapInvitationRevokeOutcome(outcome);
  }

  async prepareInvitation(token: string): Promise<{ invitationId: string }> {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
      throw invalidInvitationError();
    }
    const invitation = await this.ports.identities.findActiveInvitationByHash(
      hashInvitationToken(token),
    );
    if (!invitation) {
      throw invalidInvitationError();
    }
    return { invitationId: invitation.invitationId };
  }

  async linkWithInvitationCode(
    command: WorkosInvitationLinkCommand,
  ): Promise<{ linked: true }> {
    let identity: WorkosIdentity;
    try {
      identity = await this.ports.workos.authenticateWithCode(command.code);
    } catch (error) {
      throw error;
    }

    if (!identity.emailVerified) {
      throw new ApiError(401, 'EMAIL_NOT_VERIFIED', 'E-mail внешнего аккаунта не подтверждён');
    }

    const outcome = await this.ports.identities.consumeInvitationAndLinkWithAudit({
      invitationId: command.invitationId,
      provider: WORKOS_PROVIDER,
      providerUserId: identity.sub,
      emailAtLink: identity.email,
      emailVerified: identity.emailVerified,
      authMethod: identity.authMethod,
      requestId: command.requestId,
      userAgent: command.userAgent,
      ipAddress: command.ipAddress,
    });

    switch (outcome.status) {
      case 'linked':
      case 'already_linked':
        return { linked: true };
      case 'conflict':
        throw new ApiError(
          409,
          'IDENTITY_CONFLICT',
          'Этот внешний аккаунт уже привязан к другому пользователю',
        );
      case 'invitation_invalid':
        throw invalidInvitationError();
      case 'user_inactive':
        throw new UserInactiveError();
    }
  }

  async adminUnlink(command: WorkosAdminUnlinkCommand): Promise<{ unlinked: boolean }> {
    const sessionId = command.currentUser.sessionId;

    if (!sessionId) {
      throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
    }

    await this.requireManageSso(command, 'auth.identity.unlink_denied');

    return this.mapAdminDeleteOneOutcome(
      await this.ports.identities.deleteOneLinkWithAudit({
        identityId: command.identityId,
        targetUserId: command.targetUserId,
        actor: this.toActor(command),
        actorSessionId: sessionId,
        provider: WORKOS_PROVIDER,
        mode: 'admin',
        reason: command.reason,
      }),
    );
  }

  /** Unlink requires password confirmation: after unlink only the password remains. */
  async unlink(command: WorkosUnlinkCommand): Promise<{ unlinked: boolean }> {
    // Same dead-session window as the link flow: re-check the DB session.
    const sessionId = command.currentUser.sessionId;

    if (!sessionId || !(await this.ports.identities.isSessionActive(sessionId))) {
      throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
    }

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

    // The delete transaction re-proves the live session/user UNDER LOCK: a
    // session revoked between the pre-checks above (or during bcrypt) and
    // the delete cannot unlink.
    const outcome = await this.ports.identities.deleteLinkWithAudit({
      actor: this.toActor(command),
      provider: WORKOS_PROVIDER,
      sessionId,
    });

    switch (outcome) {
      case 'unlinked':
        return { unlinked: true };
      case 'not_linked':
        return { unlinked: false };
      case 'session_inactive':
        throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
      case 'user_inactive':
        throw new UserInactiveError();
      case 'external_policy':
        throw new ApiError(
          409,
          'UNLINK_FORBIDDEN_EXTERNAL_POLICY',
          'Нельзя отвязать SSO: вход по паролю для пользователя отключён',
        );
      case 'self_unlink_disabled':
        throw new ApiError(
          403,
          'SSO_SELF_UNLINK_DISABLED',
          'Самостоятельная отвязка SSO отключена администратором',
        );
    }
  }

  buildAuthorizeUrl(state: string, options: WorkosAuthorizeOptions = {}): string {
    return this.ports.workos.buildAuthorizeUrl(state, options);
  }

  /**
   * Audit contract §4.8: state mismatch in LOGIN mode is auth.login.failed
   * (source=workos, no actor yet) — unlike link mode, which owns
   * auth.identity.link_failed.
   */
  async writeLoginStateMismatch(
    context: Pick<WorkosLoginCommand, 'requestId' | 'userAgent' | 'ipAddress'>,
  ): Promise<void> {
    await this.ports.audit.writeLoginFailed({
      username: 'unknown',
      reason: 'state_mismatch',
      requestId: context.requestId,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
      authSource: 'workos',
    });
  }

  buildProviderLogoutUrl(providerSessionId: string): string {
    return this.ports.workos.buildLogoutUrl(providerSessionId);
  }

  private async requireManageSso(
    command: Pick<WorkosAdminUnlinkCommand, 'currentUser' | 'targetUserId' | 'requestId'>,
    event:
      | 'auth.identity.list_denied'
      | 'auth.identity.unlink_denied'
      | 'auth.identity.settings_read_denied'
      | 'auth.identity.settings_update_denied'
      | 'auth.identity.invitation_create_denied'
      | 'auth.identity.invitation_revoke_denied',
  ): Promise<void> {
    if (this.ports.permissions.canUser(command.currentUser, MANAGE_SSO_PERMISSION)) {
      return;
    }

    try {
      await this.ports.deniedAudit.recordDenied(this.ports.database, {
        event,
        entityType: 'user',
        entityId: command.targetUserId,
        actorUserId: command.currentUser.id,
        actorUsername: command.currentUser.username,
        actorRole: command.currentUser.role,
        relatedUserId: Number(command.targetUserId),
        requiredPermissions: [MANAGE_SSO_PERMISSION],
        requestId: command.requestId ?? '',
        source: 'workos',
        reason: 'PERMISSION_DENIED',
        metadata: { mode: 'admin' },
      });
    } catch {
      // best-effort: sink failure must not change the denial outcome
    }

    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
      requiredPermissions: [MANAGE_SSO_PERMISSION],
    });
  }

  private mapDeleteOneOutcome(outcome: DeleteOneOutcome): { unlinked: true } {
    switch (outcome) {
      case 'unlinked':
        return { unlinked: true };
      case 'not_found':
        throw new ApiError(404, 'IDENTITY_NOT_FOUND', 'Привязка SSO не найдена');
      case 'session_inactive':
        throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
      case 'user_inactive':
        throw new UserInactiveError();
      case 'external_policy':
        throw new ApiError(
          409,
          'UNLINK_FORBIDDEN_EXTERNAL_POLICY',
          'Нельзя отвязать SSO: вход по паролю для пользователя отключён',
        );
      case 'self_unlink_disabled':
        throw new ApiError(
          403,
          'SSO_SELF_UNLINK_DISABLED',
          'Самостоятельная отвязка SSO отключена администратором',
        );
    }
  }

  private mapAdminDeleteOneOutcome(outcome: DeleteOneOutcome): { unlinked: true } {
    switch (outcome) {
      case 'unlinked':
        return { unlinked: true };
      case 'not_found':
        throw new ApiError(404, 'IDENTITY_NOT_FOUND', 'Привязка SSO не найдена');
      case 'session_inactive':
        throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
      case 'user_inactive':
      case 'external_policy':
      case 'self_unlink_disabled':
        throw new Error(`unexpected administrator unlink outcome: ${outcome}`);
    }
  }

  private assertLiveAdminSession(currentUser: CurrentUser): string {
    if (!currentUser.sessionId) {
      throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
    }
    return currentUser.sessionId;
  }

  private async requireLiveSession(currentUser: CurrentUser): Promise<string> {
    const sessionId = this.assertLiveAdminSession(currentUser);
    if (!(await this.ports.identities.isSessionActive(sessionId))) {
      throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
    }
    return sessionId;
  }

  private mapInvitationCreateOutcome(
    outcome: InvitationCreateOutcome,
  ): Extract<InvitationCreateOutcome, { status: 'created' }>['invitation'] {
    switch (outcome.status) {
      case 'created':
        return outcome.invitation;
      case 'not_found':
        throw new ApiError(404, 'USER_NOT_FOUND', 'Пользователь не найден');
      case 'user_inactive':
        throw new UserInactiveError();
      case 'session_inactive':
        throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
    }
  }

  private mapInvitationRevokeOutcome(outcome: InvitationRevokeOutcome): { revoked: boolean } {
    switch (outcome.status) {
      case 'revoked':
        return { revoked: outcome.revoked };
      case 'not_found':
        throw new ApiError(404, 'USER_NOT_FOUND', 'Пользователь не найден');
      case 'session_inactive':
        throw new ApiError(401, 'SESSION_INACTIVE', 'Сессия завершена — войдите заново');
    }
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

  /** Drift of the provider email vs users.email / email_at_link (plan §4.3). */
  private emailDriftMetadata(
    identity: WorkosIdentity,
    user: AuthUserRecord,
    link: UserIdentityRecord,
  ): Record<string, unknown> | undefined {
    const providerEmail = identity.email.toLowerCase();
    const userEmail = typeof user.email === 'string' ? user.email.toLowerCase() : null;
    const driftFromUser = userEmail !== null && providerEmail !== userEmail;
    const driftFromLink = providerEmail !== link.emailAtLink.toLowerCase();

    if (!driftFromUser && !driftFromLink) {
      return undefined;
    }

    return {
      emailDrift: true,
      providerEmail: identity.email,
      userEmail: user.email ?? null,
      emailAtLink: link.emailAtLink,
    };
  }

  private async writeLoginFailed(
    command: WorkosLoginCommand,
    identity: WorkosIdentity,
    reason: 'email_not_verified' | 'identity_not_linked' | 'inactive_user' | 'login_method_not_allowed',
    user?: AuthUserRecord,
    relatedUserId?: string,
  ): Promise<void> {
    await this.ports.audit.writeLoginFailed({
      username: identity.email,
      user,
      relatedUserId,
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

function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function invalidInvitationError(): ApiError {
  return new ApiError(
    410,
    'SSO_INVITATION_INVALID',
    'Ссылка привязки недействительна, истекла или уже использована',
  );
}
