import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { AuthUserRecord } from '../auth.types';
import type { WorkosIdentity } from './workos-api.client';
import { WorkosAuthService, type WorkosAuthServicePorts } from './workos-auth.service';

const IDENTITY: WorkosIdentity = {
  sub: 'workos-sub-1',
  email: 'user@example.com',
  emailVerified: true,
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
    userById: AuthUserRecord | null;
    sessions: ReturnType<typeof vi.fn>;
    loginFailed: ReturnType<typeof vi.fn>;
    linkFailed: ReturnType<typeof vi.fn>;
    insertLink: ReturnType<typeof vi.fn>;
    deleteLink: ReturnType<typeof vi.fn>;
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
    userById: USER,
    sessions: vi.fn(async () => ({
      sessionId: 'session-1',
      userId: '42',
      refreshToken: 'refresh-1',
      refreshTokenExpiresAt: new Date('2026-08-01T00:00:00Z'),
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
    deleteLink: vi.fn(async () => true),
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
      insertLinkWithAudit: state.insertLink,
      deleteLinkWithAudit: state.deleteLink,
      writeLinkFailed: state.linkFailed,
      touchLastLogin: async () => undefined,
      isSessionActive: async () => state.sessionActive,
    } as never,
    sessions: { createLoginSession: state.sessions },
    tokens: {
      issueAccessToken: async () => ({ accessToken: 'access-1', expiresAt: new Date('2026-07-03T13:00:00Z') }),
    },
    audit: { writeLoginFailed: state.loginFailed },
    passwords: { verify: async () => state.passwordValid },
    loadUserById: async () => state.userById,
  };

  return { service: new WorkosAuthService(ports), ports: state };
}

describe('WorkosAuthService.loginWithCode', () => {
  it('logs in a linked active user with workos auth source and provider session id', async () => {
    const harness = createHarness();
    const result = await harness.service.loginWithCode({ code: 'code-1', requestId: 'req-1' });

    expect(result.response.user.id).toBe('42');
    expect(harness.ports.sessions).toHaveBeenCalledWith(
      expect.objectContaining({ id: '42' }),
      expect.objectContaining({ authSource: 'workos', providerSessionId: 'sid-1', requestId: 'req-1' }),
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

  it('is idempotent when the same identity is already linked to the same user', async () => {
    const harness = createHarness();
    await expect(harness.service.linkWithCode(command)).resolves.toEqual({ linked: true });
    expect(harness.ports.insertLink).not.toHaveBeenCalled();
  });

  it('denies identity linked to another user with identity_conflict audit', async () => {
    const harness = createHarness({
      linkRecord: {
        identityId: 'ident-9',
        userId: '99',
        provider: 'workos',
        providerUserId: IDENTITY.sub,
        emailAtLink: IDENTITY.email,
      },
    });

    await expect(harness.service.linkWithCode(command)).rejects.toMatchObject({
      code: 'IDENTITY_CONFLICT',
    });
    expect(harness.ports.linkFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'identity_conflict', conflictUserId: '99' }),
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

  it('refuses unlink when login policy is external-only', async () => {
    const harness = createHarness({ userById: { ...USER, loginPolicy: 'external' } });

    await expect(harness.service.unlink(command)).rejects.toMatchObject({
      code: 'UNLINK_FORBIDDEN_EXTERNAL_POLICY',
    });
    expect(harness.ports.deleteLink).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
