import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole, mapRoleIdToRole } from '../../../permissions/permissions';
import { ROLE_POLICIES } from '../../../permissions/policies/role-policies';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import { LoginMethodNotAllowedError } from '../auth.errors';
import type { AuthUserRecord } from '../auth.types';
import type { WorkosIdentity } from './workos-api.client';
import { WorkosAuthService, type WorkosAuthServicePorts } from './workos-auth.service';
import { ROLE_POLICIES } from '../../../permissions/policies/role-policies';

const IDENTITY: WorkosIdentity = {
  sub: 'workos-sub-1',
  email: 'user@example.com',
  emailVerified: true,
  authMethod: null,
  firstName: null,
  lastName: null,
  providerSessionId: 'sid-1',
};

const USER: AuthUserRecord = {
  id: '42',
  username: 'manager',
  roleId: 10,
  passwordHash: 'bcrypt-hash',
  isActive: true,
  loginPolicy: 'both',
};

const CURRENT_USER: CurrentUser = {
  id: '42',
  username: 'manager',
  role: 'manager',
  roleId: 10,
  permissions: [],
  sessionId: 'session-1',
};

interface Harness {
  service: WorkosAuthService;
  ports: {
    identity: WorkosIdentity;
    identityError?: Error;
    linkRecord: { identityId: string; userId: string; provider: string; providerUserId: string; emailAtLink: string } | null;
    links: Array<{
      identityId: string;
      authMethod: string | null;
      emailAtLink: string;
      linkedAt: string;
      lastLoginAt: string | null;
    }>;
    userById: AuthUserRecord | null;
    sessions: ReturnType<typeof vi.fn>;
    issueAccessToken: ReturnType<typeof vi.fn>;
    loginFailed: ReturnType<typeof vi.fn>;
    linkFailed: ReturnType<typeof vi.fn>;
    insertLink: ReturnType<typeof vi.fn>;
    deleteOne: ReturnType<typeof vi.fn>;
    deleteLink: ReturnType<typeof vi.fn>;
    getSettings: ReturnType<typeof vi.fn>;
    updateSettings: ReturnType<typeof vi.fn>;
    createInvitation: ReturnType<typeof vi.fn>;
    revokeInvitations: ReturnType<typeof vi.fn>;
    findInvitation: ReturnType<typeof vi.fn>;
    consumeInvitation: ReturnType<typeof vi.fn>;
    recordDenied: ReturnType<typeof vi.fn>;
    canUser: ReturnType<typeof vi.fn>;
    database: DatabaseService;
    passwordValid: boolean;
    sessionActive: boolean;
  };
}

function createHarness(overrides: Partial<Harness['ports']> = {}): Harness {
  const state: Harness['ports'] = {
    identity: IDENTITY,
    linkRecord: {
      identityId: 'ident-1',
      userId: '42',
      provider: 'workos',
      providerUserId: IDENTITY.sub,
      emailAtLink: IDENTITY.email,
    },
    links: [],
    userById: USER,
    sessions: vi.fn(async () => ({
      sessionId: 'session-1',
      userId: '42',
      refreshToken: 'refresh-1',
      refreshTokenExpiresAt: new Date('2026-08-01T00:00:00Z'),
    })),
    issueAccessToken: vi.fn(async () => ({
      accessToken: 'access-1',
      expiresAt: new Date('2026-07-03T13:00:00Z'),
    })),
    loginFailed: vi.fn(async () => undefined),
    linkFailed: vi.fn(async () => undefined),
    insertLink: vi.fn(async () => ({
      status: 'linked' as const,
      record: {
        identityId: 'ident-new',
        userId: '42',
        provider: 'workos',
        providerUserId: IDENTITY.sub,
        emailAtLink: IDENTITY.email,
      },
    })),
    deleteOne: vi.fn(async () => 'unlinked' as const),
    deleteLink: vi.fn(async () => 'unlinked' as const),
    getSettings: vi.fn(async () => ({
      loginPolicy: 'both' as const,
      selfLinkEnabled: true,
      selfUnlinkEnabled: true,
    })),
    updateSettings: vi.fn(async () => ({
      status: 'updated' as const,
      settings: {
        loginPolicy: 'both' as const,
        selfLinkEnabled: false,
        selfUnlinkEnabled: false,
      },
    })),
    createInvitation: vi.fn(async () => ({
      status: 'created' as const,
      invitation: {
        invitationId: '02bed022-f183-487b-8e2f-4603665a2add',
        targetUserId: '42',
        expiresAt: '2026-07-26T20:00:00.000Z',
      },
    })),
    revokeInvitations: vi.fn(async () => ({
      status: 'revoked' as const,
      revoked: true,
    })),
    findInvitation: vi.fn(async () => ({
      invitationId: '02bed022-f183-487b-8e2f-4603665a2add',
      targetUserId: '42',
      expiresAt: '2026-07-26T20:00:00.000Z',
    })),
    consumeInvitation: vi.fn(async () => ({ status: 'linked' as const })),
    recordDenied: vi.fn(async () => 'audit-1'),
    canUser: vi.fn((user: CurrentUser | null | undefined, permission: string) => Boolean(user?.permissions.includes(permission))),
    database: {
      query: vi.fn(),
      transaction: vi.fn(),
      ping: vi.fn(),
      onModuleDestroy: vi.fn(),
      isConfigured: true,
    } as DatabaseService,
    passwordValid: true,
    sessionActive: true,
    ...overrides,
  };

  const ports: WorkosAuthServicePorts = {
    workos: {
      buildAuthorizeUrl: (s: string) => `https://api.workos.test/authorize?state=${s}`,
      buildLogoutUrl: (sid: string) => `https://api.workos.test/logout?session_id=${sid}`,
      authenticateWithCode: async () => {
        if (state.identityError) {
          throw state.identityError;
        }
        return state.identity;
      },
    } as never,
    users: { findByUsername: async () => state.userById },
    identities: {
      findByProviderSub: async () => state.linkRecord,
      findByUserId: async () => state.linkRecord,
      listLinks: async () => state.links,
      insertLinkWithAudit: state.insertLink,
      deleteOneLinkWithAudit: state.deleteOne,
      deleteLinkWithAudit: state.deleteLink,
      getUserSettings: state.getSettings,
      updateUserSettingsWithAudit: state.updateSettings,
      createLinkInvitationWithAudit: state.createInvitation,
      revokeActiveLinkInvitationsWithAudit: state.revokeInvitations,
      findActiveInvitationByHash: state.findInvitation,
      consumeInvitationAndLinkWithAudit: state.consumeInvitation,
      writeLinkFailed: state.linkFailed,
      touchLastLogin: async () => undefined,
      isSessionActive: async () => state.sessionActive,
    } as never,
    sessions: { createLoginSession: state.sessions },
    tokens: {
      issueAccessToken: state.issueAccessToken,
    },
    audit: { writeLoginFailed: state.loginFailed },
    passwords: { verify: async () => state.passwordValid },
    permissions: {
      canUser: state.canUser,
      loadRoleAuthorization: vi.fn(async (roleId: number) => {
        const role = mapRoleIdToRole(roleId);
        if (!role) {
          return {
            permissions: [],
            scopes: ROLE_POLICIES.viewer,
            version: 7,
          };
        }
        return {
          permissions: getPermissionsForRole(role),
          scopes: ROLE_POLICIES[role],
          version: 7,
        };
      }),
    } as WorkosAuthServicePorts['permissions'],
    deniedAudit: { recordDenied: state.recordDenied },
    database: state.database,
    frontendOrigin: 'https://erp.example.test',
    loadUserById: async () => state.userById,
  };

  return { service: new WorkosAuthService(ports), ports: state };
}

describe('WorkosAuthService.loginWithCode', () => {
  it('logs in a linked active user with workos auth source and provider session id', async () => {
    const harness = createHarness();
    const result = await harness.service.loginWithCode({ code: 'code-1', requestId: 'req-1' });

    expect(result.response.user).toMatchObject({
      id: '42',
      permissionsVersion: 7,
      policyScopes: ROLE_POLICIES.manager,
    });
    expect(harness.ports.sessions).toHaveBeenCalledWith(
      expect.objectContaining({ id: '42' }),
      expect.objectContaining({ authSource: 'workos', providerSessionId: 'sid-1', requestId: 'req-1' }),
    );
    expect(harness.ports.issueAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: '42', sessionId: 'session-1' }),
      { notAfter: new Date('2026-08-01T00:00:00.000Z') },
    );
    expect(harness.ports.loginFailed).not.toHaveBeenCalled();
  });

  it('denies unverified provider email', async () => {
    const harness = createHarness({ identity: { ...IDENTITY, emailVerified: false } });

    await expect(harness.service.loginWithCode({ code: 'c' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(harness.ports.loginFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'email_not_verified', authSource: 'workos' }),
    );
  });

  it('denies unlinked identity without creating any link (no email auto-link)', async () => {
    const harness = createHarness({ linkRecord: null });

    await expect(harness.service.loginWithCode({ code: 'c' })).rejects.toMatchObject({
      code: 'IDENTITY_NOT_LINKED',
    });
    expect(harness.ports.insertLink).not.toHaveBeenCalled();
    expect(harness.ports.loginFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'identity_not_linked' }),
    );
  });

  it('writes email drift into the success-audit metadata when the provider email diverges', async () => {
    const harness = createHarness({ userById: { ...USER, email: 'other@example.com' } });
    await harness.service.loginWithCode({ code: 'c' });

    expect(harness.ports.sessions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        auditMetadata: expect.objectContaining({
          emailDrift: true,
          providerEmail: IDENTITY.email,
          userEmail: 'other@example.com',
          emailAtLink: IDENTITY.email,
        }),
      }),
    );
  });

  it('omits drift metadata when the provider email matches user and link', async () => {
    const harness = createHarness({ userById: { ...USER, email: IDENTITY.email } });
    await harness.service.loginWithCode({ code: 'c' });

    expect(harness.ports.sessions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ auditMetadata: undefined }),
    );
  });

  it('keeps the resolved account id in the audit when the linked user row is gone (stale link race)', async () => {
    const harness = createHarness({ userById: null });

    await expect(harness.service.loginWithCode({ code: 'c' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(harness.ports.loginFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'identity_not_linked', relatedUserId: '42' }),
    );
  });

  it('audits provider_error as auth.login.failed when the code exchange fails', async () => {
    const harness = createHarness({ identityError: new Error('workos down') });

    await expect(harness.service.loginWithCode({ code: 'c', requestId: 'req-9' })).rejects.toThrow(
      'workos down',
    );
    expect(harness.ports.loginFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'provider_error', authSource: 'workos', requestId: 'req-9' }),
    );
  });

  it('denies inactive users and local-only policy', async () => {
    const inactive = createHarness({ userById: { ...USER, isActive: false } });
    await expect(inactive.service.loginWithCode({ code: 'c' })).rejects.toMatchObject({
      code: 'USER_INACTIVE',
    });

    const localOnly = createHarness({ userById: { ...USER, loginPolicy: 'local' } });
    await expect(localOnly.service.loginWithCode({ code: 'c' })).rejects.toMatchObject({
      code: 'LOGIN_METHOD_NOT_ALLOWED',
    });
    expect(localOnly.ports.loginFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'login_method_not_allowed' }),
    );
  });
});

describe('WorkosAuthService.linkWithCode', () => {
  const command = { code: 'c', currentUser: CURRENT_USER, requestId: 'req-2' };

  it('links a new identity to the current session user with audit', async () => {
    const harness = createHarness({ linkRecord: null });
    const result = await harness.service.linkWithCode(command);

    expect(result).toEqual({ linked: true });
    expect(harness.ports.insertLink).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'workos',
        providerUserId: IDENTITY.sub,
        emailAtLink: IDENTITY.email,
        mode: 'self_serve',
        sessionId: 'session-1',
        actor: expect.objectContaining({ userId: '42', requestId: 'req-2' }),
      }),
    );
  });

  it('treats a concurrent same-user insert race as idempotent success', async () => {
    const harness = createHarness({
      linkRecord: null,
      insertLink: vi.fn(async () => ({
        status: 'already_linked' as const,
        record: {
          identityId: 'ident-1',
          userId: '42',
          provider: 'workos',
          providerUserId: IDENTITY.sub,
          emailAtLink: IDENTITY.email,
        },
      })),
    });

    await expect(harness.service.linkWithCode(command)).resolves.toEqual({ linked: true });
    expect(harness.ports.linkFailed).not.toHaveBeenCalled();
  });

  it('maps a concurrent other-user insert race to identity_conflict with audit', async () => {
    const harness = createHarness({
      linkRecord: null,
      insertLink: vi.fn(async () => ({ status: 'conflict' as const, conflictUserId: '99' })),
    });

    await expect(harness.service.linkWithCode(command)).rejects.toMatchObject({
      code: 'IDENTITY_CONFLICT',
    });
    expect(harness.ports.linkFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'identity_conflict', conflictUserId: '99' }),
    );
  });

  it('denies when the guarded insert sees the session died during the WorkOS round-trip', async () => {
    const harness = createHarness({
      linkRecord: null,
      insertLink: vi.fn(async () => ({ status: 'session_inactive' as const })),
    });

    await expect(harness.service.linkWithCode(command)).rejects.toMatchObject({
      code: 'SESSION_INACTIVE',
    });
    expect(harness.ports.linkFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'session_inactive' }),
    );
  });

  it('routes the idempotent already-linked case through the guarded insert (no fast-path)', async () => {
    // The guarded insert is the ONLY authority: even an already-linked
    // identity must pass the in-transaction session/user revalidation, so a
    // session revoked during the provider round-trip can never 200.
    const harness = createHarness({
      insertLink: vi.fn(async () => ({
        status: 'already_linked' as const,
        record: {
          identityId: 'ident-1',
          userId: '42',
          provider: 'workos',
          providerUserId: IDENTITY.sub,
          emailAtLink: IDENTITY.email,
        },
      })),
    });

    await expect(harness.service.linkWithCode(command)).resolves.toEqual({ linked: true });
    expect(harness.ports.insertLink).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
    );
  });

  it('writes link_failed on unverified email and inactive session user', async () => {
    const unverified = createHarness({ identity: { ...IDENTITY, emailVerified: false } });
    await expect(unverified.service.linkWithCode(command)).rejects.toMatchObject({
      code: 'EMAIL_NOT_VERIFIED',
    });
    expect(unverified.ports.linkFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'email_not_verified' }),
    );

    const inactive = createHarness({ userById: { ...USER, isActive: false } });
    await expect(inactive.service.linkWithCode(command)).rejects.toMatchObject({ code: 'USER_INACTIVE' });
    expect(inactive.ports.linkFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'session_inactive' }),
    );
  });

  it('writes link_failed with provider_error when the exchange fails', async () => {
    const harness = createHarness({ identityError: new Error('workos down') });

    await expect(harness.service.linkWithCode(command)).rejects.toThrow('workos down');
    expect(harness.ports.linkFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'provider_error' }),
    );
  });

  it('denies linking from a revoked/expired DB session even with a valid bearer token', async () => {
    const harness = createHarness({ sessionActive: false });

    await expect(harness.service.linkWithCode(command)).rejects.toMatchObject({
      code: 'SESSION_INACTIVE',
    });
    expect(harness.ports.insertLink).not.toHaveBeenCalled();
    expect(harness.ports.linkFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'session_inactive' }),
    );
  });
});

describe('WorkosAuthService.writeLoginStateMismatch', () => {
  it('audits login-mode state mismatch as auth.login.failed with workos source', async () => {
    const harness = createHarness();
    await harness.service.writeLoginStateMismatch({ requestId: 'req-sm' });

    expect(harness.ports.loginFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'state_mismatch', authSource: 'workos', requestId: 'req-sm' }),
    );
  });
});

describe('WorkosAuthService.unlink', () => {
  const command = { currentUser: CURRENT_USER, password: 'secret' };

  it('unlinks after password confirmation with audit', async () => {
    const harness = createHarness();
    await expect(harness.service.unlink(command)).resolves.toEqual({ unlinked: true });
    expect(harness.ports.deleteLink).toHaveBeenCalled();
  });

  it('rejects wrong password and audits it', async () => {
    const harness = createHarness({ passwordValid: false });

    await expect(harness.service.unlink(command)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(harness.ports.deleteLink).not.toHaveBeenCalled();
    expect(harness.ports.loginFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'invalid_password', metadata: { context: 'workos_unlink' } }),
    );
  });

  it('refuses unlink from a revoked/expired DB session', async () => {
    const harness = createHarness({ sessionActive: false });

    await expect(harness.service.unlink(command)).rejects.toMatchObject({ code: 'SESSION_INACTIVE' });
    expect(harness.ports.deleteLink).not.toHaveBeenCalled();
  });

  it('refuses unlink when the delete tx sees the session died after the pre-check (race)', async () => {
    // Pre-check passed, but the session was revoked during bcrypt: the
    // locked re-check inside the delete transaction is the authority.
    const harness = createHarness({ deleteLink: vi.fn(async () => 'session_inactive' as const) });

    await expect(harness.service.unlink(command)).rejects.toMatchObject({ code: 'SESSION_INACTIVE' });
    expect(harness.ports.deleteLink).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
    );
  });

  it('maps the locked-delete external_policy race outcome to 409', async () => {
    const harness = createHarness({ deleteLink: vi.fn(async () => 'external_policy' as const) });

    await expect(harness.service.unlink(command)).rejects.toMatchObject({
      code: 'UNLINK_FORBIDDEN_EXTERNAL_POLICY',
    });
  });

  it('passes the identity link for in-transaction re-proof and audits an unlink race', async () => {
    const happy = createHarness();
    await happy.service.loginWithCode({ code: 'c' });
    expect(happy.ports.sessions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requireLinkedIdentity: { provider: 'workos', providerUserId: IDENTITY.sub },
      }),
    );

    const raced = createHarness({
      sessions: vi.fn(async () => {
        throw new ApiError(401, 'IDENTITY_NOT_LINKED', 'gone');
      }),
    });
    await expect(raced.service.loginWithCode({ code: 'c' })).rejects.toMatchObject({
      code: 'IDENTITY_NOT_LINKED',
    });
    expect(raced.ports.loginFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'identity_not_linked', authSource: 'workos' }),
    );
  });

  it('audits an in-transaction guard denial during the session insert (policy flip mid-exchange)', async () => {
    const harness = createHarness({
      sessions: vi.fn(async () => {
        throw new LoginMethodNotAllowedError();
      }),
    });

    await expect(harness.service.loginWithCode({ code: 'c' })).rejects.toMatchObject({
      code: 'LOGIN_METHOD_NOT_ALLOWED',
    });
    expect(harness.ports.loginFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'login_method_not_allowed', authSource: 'workos' }),
    );
  });

  it('refuses unlink when login policy is external-only', async () => {
    const harness = createHarness({ userById: { ...USER, loginPolicy: 'external' } });

    await expect(harness.service.unlink(command)).rejects.toMatchObject({
      code: 'UNLINK_FORBIDDEN_EXTERNAL_POLICY',
    });
    expect(harness.ports.deleteLink).not.toHaveBeenCalled();
  });
});

describe('WorkosAuthService.multilink task 5', () => {
  it('lists own links', async () => {
    const harness = createHarness({
      links: [{ identityId: '1', authMethod: 'GoogleOAuth', emailAtLink: 'a@c', linkedAt: 'x', lastLoginAt: null }],
    });
    await expect(harness.service.listOwnLinks(CURRENT_USER)).resolves.toHaveLength(1);
  });

  it('self AND admin LIST fail-fast 401 when currentUser.sessionId is absent (before repo)', async () => {
    const harness = createHarness({ links: [] });
    const noSession = { ...CURRENT_USER, sessionId: undefined };
    await expect(harness.service.listOwnLinks(noSession)).rejects.toMatchObject({
      code: 'SESSION_INACTIVE',
      statusCode: 401,
    });
    const adminNoSession = {
      ...noSession,
      id: '7',
      role: 'admin' as const,
      roleId: 1,
      permissions: ['users.manage_sso'] as const,
    };
    await expect(
      harness.service.adminListLinks({ currentUser: adminNoSession, targetUserId: '42' }),
    ).rejects.toMatchObject({ code: 'SESSION_INACTIVE', statusCode: 401 });
    // A reached repo listLinks would RESOLVE with the (empty) list, so a 401
    // rejection proves the fail-fast fires before any repo/permission work.
  });

  it('self and admin reads reject a revoked DB session even while the JWT is valid', async () => {
    const harness = createHarness({ sessionActive: false });
    const admin = {
      ...CURRENT_USER,
      id: '7',
      role: 'admin' as const,
      roleId: 1,
      permissions: ['users.manage_sso'] as const,
      sessionId: 'revoked-admin-session',
    };

    await expect(harness.service.listOwnLinks(CURRENT_USER)).rejects.toMatchObject({
      code: 'SESSION_INACTIVE',
      statusCode: 401,
    });
    await expect(
      harness.service.adminListLinks({ currentUser: admin, targetUserId: '42' }),
    ).rejects.toMatchObject({ code: 'SESSION_INACTIVE', statusCode: 401 });
    await expect(
      harness.service.adminGetSettings({ currentUser: admin, targetUserId: '42' }),
    ).rejects.toMatchObject({ code: 'SESSION_INACTIVE', statusCode: 401 });
    expect(harness.ports.canUser).not.toHaveBeenCalled();
    expect(harness.ports.getSettings).not.toHaveBeenCalled();
  });

  it('self AND admin unlink fail-fast 401 when currentUser.sessionId is absent (R12-MINOR)', async () => {
    const harness = createHarness({});
    const noSession = { ...CURRENT_USER, sessionId: undefined };
    await expect(
      harness.service.unlinkOwn({ currentUser: noSession, identityId: '1', password: 'x' }),
    ).rejects.toMatchObject({ code: 'SESSION_INACTIVE', statusCode: 401 });
    const adminNoSession = {
      ...noSession,
      id: '7',
      role: 'admin' as const,
      roleId: 1,
      permissions: ['users.manage_sso'] as const,
    };
    await expect(
      harness.service.adminUnlink({ currentUser: adminNoSession, targetUserId: '42', identityId: '1' }),
    ).rejects.toMatchObject({ code: 'SESSION_INACTIVE', statusCode: 401 });
    expect(harness.ports.deleteOne).not.toHaveBeenCalled();
  });

  it('admin list returns 404 for a nonexistent target user, 200 [] for an existing one (R7-MINOR)', async () => {
    const admin = {
      ...CURRENT_USER,
      id: '7',
      username: 'admin',
      role: 'admin' as const,
      roleId: 1,
      permissions: ['users.manage_sso'] as const,
      sessionId: 'as',
    };
    const missing = createHarness({ userById: null });
    await expect(
      missing.service.adminListLinks({ currentUser: admin, targetUserId: '99' }),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND', statusCode: 404 });
    const empty = createHarness({ userById: { ...USER, id: '99' }, links: [] });
    await expect(empty.service.adminListLinks({ currentUser: admin, targetUserId: '99' })).resolves.toEqual([]);
  });

  it('unlinks own link after password check via deleteOne (actorSessionId = own)', async () => {
    const harness = createHarness({ deleteOne: vi.fn(async () => 'unlinked' as const) });
    await expect(
      harness.service.unlinkOwn({ currentUser: CURRENT_USER, identityId: '1', password: 'secret' }),
    ).resolves.toEqual({ unlinked: true });
    expect(harness.ports.deleteOne).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'self_serve', identityId: '1', targetUserId: '42', actorSessionId: 'session-1' }),
    );
  });

  it('maps deleteOne external_policy to 409 on self unlink', async () => {
    const harness = createHarness({ deleteOne: vi.fn(async () => 'external_policy' as const) });
    await expect(
      harness.service.unlinkOwn({ currentUser: CURRENT_USER, identityId: '1', password: 'secret' }),
    ).rejects.toMatchObject({ code: 'UNLINK_FORBIDDEN_EXTERNAL_POLICY' });
  });

  it('maps deleteOne not_found to 404', async () => {
    const harness = createHarness({ deleteOne: vi.fn(async () => 'not_found' as const) });
    await expect(
      harness.service.unlinkOwn({ currentUser: CURRENT_USER, identityId: '9', password: 'secret' }),
    ).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
  });

  it('admin list/unlink deny writes a denied-audit BEFORE the 403 (canUser on permissions claim)', async () => {
    const harness = createHarness({});
    const noPerm = { ...CURRENT_USER, role: 'worker' as const, permissions: [] as const };
    await expect(
      harness.service.adminListLinks({ currentUser: noPerm, targetUserId: '99' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    await expect(
      harness.service.adminUnlink({ currentUser: noPerm, targetUserId: '99', identityId: '1' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    const fullDenied = (event: string) =>
      expect.objectContaining({
        event,
        entityType: 'user',
        entityId: '99',
        relatedUserId: 99,
        actorUserId: noPerm.id,
        actorUsername: noPerm.username,
        actorRole: noPerm.role,
        requestId: expect.anything(),
        source: 'workos',
        reason: 'PERMISSION_DENIED',
        requiredPermissions: ['users.manage_sso'],
        metadata: expect.objectContaining({ mode: 'admin' }),
      });
    expect(harness.ports.recordDenied).toHaveBeenCalledWith(expect.anything(), fullDenied('auth.identity.list_denied'));
    expect(harness.ports.recordDenied).toHaveBeenCalledWith(expect.anything(), fullDenied('auth.identity.unlink_denied'));
    expect(harness.ports.deleteOne).not.toHaveBeenCalled();
  });

  it('enforces the PERMISSIONS CLAIM, not the role (R7-MAJOR anti-bypass)', async () => {
    const strippedAdmin = createHarness({});
    const admin0 = {
      ...CURRENT_USER,
      id: '7',
      username: 'admin',
      role: 'admin' as const,
      roleId: 1,
      permissions: [] as const,
    };
    await expect(
      strippedAdmin.service.adminUnlink({ currentUser: admin0, targetUserId: '42', identityId: '1' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(strippedAdmin.ports.recordDenied).toHaveBeenCalled();
    expect(strippedAdmin.ports.deleteOne).not.toHaveBeenCalled();

    const granted = createHarness({ deleteOne: vi.fn(async () => 'unlinked' as const) });
    const worker1 = {
      ...CURRENT_USER,
      id: '5',
      username: 'w',
      role: 'worker' as const,
      roleId: 6,
      permissions: ['users.manage_sso'] as const,
      sessionId: 'ws',
    };
    await expect(
      granted.service.adminUnlink({ currentUser: worker1, targetUserId: '42', identityId: '1' }),
    ).resolves.toEqual({ unlinked: true });
  });

  it('a failing denied-audit sink STILL yields 403, not 500 (R6-MAJOR best-effort)', async () => {
    const harness = createHarness({ recordDenied: vi.fn(async () => { throw new Error('audit sink down'); }) });
    const noPerm = { ...CURRENT_USER, role: 'worker' as const, permissions: [] as const };
    await expect(
      harness.service.adminListLinks({ currentUser: noPerm, targetUserId: '99' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    await expect(
      harness.service.adminUnlink({ currentUser: noPerm, targetUserId: '99', identityId: '1' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
  });

  it('admin unlink passes actor≠target, reason, and the ADMIN session to deleteOne', async () => {
    const harness = createHarness({ deleteOne: vi.fn(async () => 'unlinked' as const) });
    const admin = {
      ...CURRENT_USER,
      id: '7',
      username: 'admin',
      role: 'admin' as const,
      roleId: 1,
      permissions: ['users.manage_sso'] as const,
      sessionId: 'admin-session',
    };
    await expect(
      harness.service.adminUnlink({
        currentUser: admin,
        targetUserId: '42',
        identityId: '1',
        reason: 'уволен',
      }),
    ).resolves.toEqual({ unlinked: true });
    expect(harness.ports.deleteOne).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'admin',
        targetUserId: '42',
        identityId: '1',
        reason: 'уволен',
        actorSessionId: 'admin-session',
        actor: expect.objectContaining({ userId: '7' }),
      }),
    );
  });

  it('admin unlink maps deleteOne not_found→404 and session_inactive→401', async () => {
    const admin = {
      ...CURRENT_USER,
      id: '7',
      username: 'admin',
      role: 'admin' as const,
      roleId: 1,
      permissions: ['users.manage_sso'] as const,
      sessionId: 'admin-session',
    };
    const notFound = createHarness({ deleteOne: vi.fn(async () => 'not_found' as const) });
    await expect(
      notFound.service.adminUnlink({ currentUser: admin, targetUserId: '42', identityId: '9' }),
    ).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND', statusCode: 404 });
    const revoked = createHarness({ deleteOne: vi.fn(async () => 'session_inactive' as const) });
    await expect(
      revoked.service.adminUnlink({ currentUser: admin, targetUserId: '42', identityId: '1' }),
    ).rejects.toMatchObject({ code: 'SESSION_INACTIVE', statusCode: 401 });
  });

  it('links propagate identity.authMethod into insertLinkWithAudit (BLOCKER1)', async () => {
    const harness = createHarness({ linkRecord: null, identity: { ...IDENTITY, authMethod: 'GoogleOAuth' } });
    await harness.service.linkWithCode({ code: 'c', currentUser: CURRENT_USER, requestId: 'r' });
    expect(harness.ports.insertLink).toHaveBeenCalledWith(expect.objectContaining({ authMethod: 'GoogleOAuth' }));
  });

  it('enforces the per-user self-link toggle from the guarded insert', async () => {
    const harness = createHarness({
      linkRecord: null,
      insertLink: vi.fn(async () => ({ status: 'self_link_disabled' as const })),
    });

    await expect(
      harness.service.linkWithCode({ code: 'c', currentUser: CURRENT_USER }),
    ).rejects.toMatchObject({ code: 'SSO_SELF_LINK_DISABLED', statusCode: 403 });
  });

  it('enforces the per-user self-unlink toggle from the guarded delete', async () => {
    const harness = createHarness({
      deleteOne: vi.fn(async () => 'self_unlink_disabled' as const),
    });

    await expect(
      harness.service.unlinkOwn({
        currentUser: CURRENT_USER,
        identityId: '1',
        password: 'valid-password',
      }),
    ).rejects.toMatchObject({ code: 'SSO_SELF_UNLINK_DISABLED', statusCode: 403 });
  });
});

describe('WorkosAuthService administrator controls', () => {
  const admin: CurrentUser = {
    id: '7',
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: ['users.manage_sso'],
    sessionId: 'admin-session',
  };

  it('updates independent user settings only with manage_sso permission', async () => {
    const harness = createHarness();

    await expect(
      harness.service.adminUpdateSettings({
        currentUser: admin,
        targetUserId: '42',
        settings: {
          loginPolicy: 'both',
          selfLinkEnabled: false,
          selfUnlinkEnabled: false,
        },
      }),
    ).resolves.toEqual({
      loginPolicy: 'both',
      selfLinkEnabled: false,
      selfUnlinkEnabled: false,
    });
    expect(harness.ports.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSessionId: 'admin-session',
        targetUserId: '42',
        settings: expect.objectContaining({
          selfLinkEnabled: false,
          selfUnlinkEnabled: false,
        }),
      }),
    );
  });

  it('creates a 24-hour invitation URL while passing only a SHA-256 hash to storage', async () => {
    const harness = createHarness();

    const result = await harness.service.adminCreateInvitation({
      currentUser: admin,
      targetUserId: '42',
    });

    const url = new URL(result.invitationUrl);
    expect(url.origin).toBe('https://erp.example.test');
    expect(url.pathname).toBe('/auth/workos/invite');
    const rawToken = new URLSearchParams(url.hash.slice(1)).get('token');
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{40,100}$/);
    expect(harness.ports.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        targetUserId: '42',
      }),
    );
    expect(JSON.stringify(harness.ports.createInvitation.mock.calls)).not.toContain(
      rawToken,
    );
  });

  it('revokes active invitations through the live admin-session transaction', async () => {
    const harness = createHarness();

    await expect(
      harness.service.adminRevokeInvitations({ currentUser: admin, targetUserId: '42' }),
    ).resolves.toEqual({ revoked: true });
    expect(harness.ports.revokeInvitations).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSessionId: 'admin-session',
        targetUserId: '42',
        actor: expect.objectContaining({ userId: '7' }),
      }),
    );
  });

  it('validates the invitation token by hash and consumes it during provider callback', async () => {
    const harness = createHarness();
    const token = 'A'.repeat(43);

    await expect(harness.service.prepareInvitation(token)).resolves.toEqual({
      invitationId: '02bed022-f183-487b-8e2f-4603665a2add',
    });
    expect(harness.ports.findInvitation).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
    await expect(
      harness.service.linkWithInvitationCode({
        invitationId: '02bed022-f183-487b-8e2f-4603665a2add',
        code: 'provider-code',
      }),
    ).resolves.toEqual({ linked: true });
    expect(harness.ports.consumeInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        invitationId: '02bed022-f183-487b-8e2f-4603665a2add',
        providerUserId: IDENTITY.sub,
      }),
    );
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
