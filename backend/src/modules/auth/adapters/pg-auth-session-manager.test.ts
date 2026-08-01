import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { JwtAccessTokenIssuer } from './jwt-access-token-issuer';
import { PgAuthSessionManager } from './pg-auth-session-manager';
import { TokenService } from '../token.service';
import { ROLE_POLICIES } from '../../../permissions/policies/role-policies';

class FixedTokenService extends TokenService {
  private index = 0;
  private readonly tokens = ['refresh-login', 'refresh-rotated'];

  generateRefreshToken(): string {
    return this.tokens[this.index++] ?? 'refresh-extra';
  }
}

describe('PgAuthSessionManager', () => {
  it('creates auth session and hashed refresh token in one transaction', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));
    const database = createDatabase();
    const manager = createManager(database.service);

    await expect(
      manager.createLoginSession(
        {
          id: '42',
          username: 'manager',
          roleId: 10,
          passwordHash: 'hash',
          isActive: true,
        },
        {
          userAgent: 'agent',
          ipAddress: '127.0.0.1',
        },
      ),
    ).resolves.toMatchObject({
      sessionId: 'session-1',
      userId: '42',
      refreshToken: 'refresh-login',
      refreshTokenExpiresAt: new Date('2026-05-01T22:00:00.000Z'),
    });

    expect(database.queries.map((query) => normalizeSql(query.text))).toEqual([
      'SELECT is_active, is_service_account FROM users WHERE user_id = $1 FOR UPDATE',
      'INSERT INTO auth_sessions (user_id, expires_at, ip_address, user_agent) VALUES ($1, $2, $3, $4) RETURNING session_id::text, token_family_id::text',
      'INSERT INTO refresh_tokens ( user_id, session_id, token_hash, token_family_id, expires_at, user_agent, ip_address ) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      'UPDATE users SET last_login_at = now() WHERE user_id = $1',
      "INSERT INTO audit_log ( event, entity_type, entity_id, user_id, username, role_code, role, request_id, ip_address, user_agent, source, metadata_json ) VALUES ($1, 'auth_session', $2, $3, $4, $5, $5, $6, $7::inet, $8, $9, $10::jsonb)",
    ]);
    const audit = findAudit(database.queries, 'auth.login.success');
    expect(audit?.params).toEqual([
      'auth.login.success',
      'session-1',
      42,
      'manager',
      'manager',
      'auth-command',
      '127.0.0.1',
      'agent',
      'backend',
      JSON.stringify({
        sessionId: 'session-1',
        tokenFamilyId: 'family-1',
        outcome: 'success',
      }),
    ]);
    expect(JSON.stringify(audit?.params)).not.toContain('refresh-login');
    expect(JSON.stringify(audit?.params)).not.toContain('pepper');
    const sessionInsert = database.queries.find((query) => query.text.includes('INSERT INTO auth_sessions'));
    const refreshInsert = database.queries.find((query) => query.text.includes('INSERT INTO refresh_tokens'));
    expect(sessionInsert?.params[1]).toEqual(new Date('2026-05-01T22:00:00.000Z'));
    expect(refreshInsert?.params[4]).toEqual(new Date('2026-05-01T22:00:00.000Z'));
    vi.useRealTimers();
  });

  it('re-proves is_active and login_policy under lock inside the session transaction (TOCTOU)', async () => {
    const user = { id: '42', username: 'manager', roleId: 10, passwordHash: 'hash', isActive: true };

    // Account tightened to external-only during bcrypt: no more local session.
    const flipped = createDatabase({ guardLoginPolicy: 'external' });
    await expect(
      createManager(flipped.service, { enforceLoginPolicy: true }).createLoginSession(user, {}),
    ).rejects.toMatchObject({ code: 'LOGIN_METHOD_NOT_ALLOWED' });
    expect(flipped.queries.some((query) => query.text.includes('INSERT INTO auth_sessions'))).toBe(false);

    // Local-only account cannot get a WorkOS session either.
    const localOnly = createDatabase({ guardLoginPolicy: 'local' });
    await expect(
      createManager(localOnly.service, { enforceLoginPolicy: true }).createLoginSession(user, {
        authSource: 'workos',
      }),
    ).rejects.toMatchObject({ code: 'LOGIN_METHOD_NOT_ALLOWED' });

    // external-only + workos source is fine.
    const externalWorkos = createDatabase({ guardLoginPolicy: 'external' });
    await expect(
      createManager(externalWorkos.service, { enforceLoginPolicy: true }).createLoginSession(user, {
        authSource: 'workos',
      }),
    ).resolves.toMatchObject({ sessionId: 'session-1' });

    // Deactivated mid-login: denied regardless of policy support.
    const deactivated = createDatabase({ guardIsActive: false });
    await expect(
      createManager(deactivated.service).createLoginSession(user, {}),
    ).rejects.toMatchObject({ code: 'USER_INACTIVE' });

    const serviceAccount = createDatabase({ guardIsServiceAccount: true });
    await expect(
      createManager(serviceAccount.service).createLoginSession(user, {}),
    ).rejects.toMatchObject({ code: 'USER_INACTIVE' });
    expect(serviceAccount.queries.some((query) => query.text.includes('INSERT INTO auth_sessions'))).toBe(false);
  });

  it('re-proves the identity link inside the session transaction (unlink/relink race denies)', async () => {
    const user = { id: '42', username: 'manager', roleId: 10, passwordHash: 'hash', isActive: true };
    const requireLinkedIdentity = { provider: 'workos', providerUserId: 'sub-1' };

    // Link removed (or moved to another user) between the exchange and the
    // session insert: deny, no session row.
    const unlinked = createDatabase({ guardLinked: false });
    await expect(
      createManager(unlinked.service, { supportsProviderSessions: true }).createLoginSession(user, {
        authSource: 'workos',
        requireLinkedIdentity,
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_NOT_LINKED' });
    expect(unlinked.queries.some((query) => query.text.includes('INSERT INTO auth_sessions'))).toBe(false);

    // Still linked to THIS user: the guard is a locked owner-match select.
    const linked = createDatabase({});
    await expect(
      createManager(linked.service, { supportsProviderSessions: true }).createLoginSession(user, {
        authSource: 'workos',
        requireLinkedIdentity,
      }),
    ).resolves.toMatchObject({ sessionId: 'session-1' });
    const guard = linked.queries.find((query) => query.text.includes('FROM user_identities'));
    expect(guard?.text).toContain('FOR UPDATE');
    expect(guard?.text).toContain('user_id = $3');
    expect(guard?.params).toEqual(['workos', 'sub-1', '42']);
  });

  it('merges caller auditMetadata (e.g. SSO email drift) into the success audit row', async () => {
    const database = createDatabase();
    const manager = createManager(database.service);

    await manager.createLoginSession(
      { id: '42', username: 'manager', roleId: 10, passwordHash: 'hash', isActive: true },
      {
        authSource: 'workos',
        auditMetadata: {
          emailDrift: true,
          providerEmail: 'new@example.com',
          emailAtLink: 'old@example.com',
        },
      },
    );

    const audit = findAudit(database.queries, 'auth.login.success');
    const metadata = JSON.parse(String(audit?.params[9])) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      outcome: 'success',
      emailDrift: true,
      providerEmail: 'new@example.com',
      emailAtLink: 'old@example.com',
    });
    expect(audit?.params[8]).toBe('workos');
  });

  it('rotates refresh token atomically', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));
    const database = createDatabase({
      refreshRow: {
        token_id: 'token-old',
        user_id: '42',
        session_id: 'session-1',
        token_family_id: 'family-1',
        expires_at: new Date('2026-05-02T12:00:00.000Z'),
        session_created_at: new Date('2026-05-01T02:05:00.000Z'),
        session_expires_at: new Date('2026-05-02T12:00:00.000Z'),
        revoked_at: null,
        session_status: 'active',
        username: 'manager',
        role_id: 10,
        is_active: true,
      },
    });
    const manager = createManager(database.service);

    await expect(
      manager.refresh({
        refreshToken: 'refresh-login',
        userAgent: 'agent',
        ipAddress: '127.0.0.1',
      }),
    ).resolves.toMatchObject({
      response: {
        accessTokenExpiresAt: '2026-05-01T12:05:00.000Z',
        user: {
          id: '42',
          role: 'manager',
          permissionsVersion: 0,
          policyScopes: ROLE_POLICIES.manager,
        },
      },
      refreshToken: 'refresh-login',
      refreshTokenExpiresAt: new Date('2026-05-01T12:05:00.000Z'),
    });

    expect(database.queries.some((query) => query.text.includes("revoked_reason = 'rotated'"))).toBe(
      true,
    );
    expect(database.queries.some((query) => query.text.includes('replaced_by_token_id'))).toBe(true);
    const audit = findAudit(database.queries, 'auth.refresh');
    expect(audit?.params).toEqual([
      'auth.refresh',
      'session-1',
      42,
      'manager',
      'manager',
      'auth-command',
      '127.0.0.1',
      'agent',
      'backend',
      JSON.stringify({
        sessionId: 'session-1',
        tokenFamilyId: 'family-1',
        outcome: 'success',
        rotated: true,
      }),
    ]);
    expect(JSON.stringify(audit?.params)).not.toContain('refresh-login');
    vi.useRealTimers();
  });

  it('expires an existing refresh session at the configured absolute 10-hour boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));
    const database = createDatabase({
      refreshRow: {
        token_id: 'token-old',
        user_id: '42',
        session_id: 'session-1',
        token_family_id: 'family-1',
        expires_at: new Date('2026-05-02T12:00:00.000Z'),
        session_created_at: new Date('2026-05-01T00:00:00.000Z'),
        session_expires_at: new Date('2026-05-02T12:00:00.000Z'),
        revoked_at: null,
        session_status: 'active',
        username: 'manager',
        role_id: 10,
        is_active: true,
      },
    });

    await expect(
      createManager(database.service).refresh({ refreshToken: 'refresh-login' }),
    ).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_EXPIRED',
      statusCode: 401,
    });
    expect(database.queries.some((query) => query.text.includes("SET status = 'expired'"))).toBe(true);
    vi.useRealTimers();
  });

  it('detects reuse of revoked refresh token and revokes the session', async () => {
    const database = createDatabase({
      refreshRow: {
        token_id: 'token-old',
        user_id: '42',
        session_id: 'session-1',
        token_family_id: 'family-1',
        expires_at: new Date('2026-05-02T12:00:00.000Z'),
        revoked_at: new Date('2026-05-01T12:00:00.000Z'),
        session_status: 'active',
        username: 'manager',
        role_id: 10,
        is_active: true,
      },
    });
    const manager = createManager(database.service);

    await expect(manager.refresh({ refreshToken: 'refresh-login' })).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_REUSE_DETECTED',
    });
    expect(database.queries.some((query) => query.text.includes('reuse_detected_at'))).toBe(true);
    expect(database.queries.some((query) => query.text.includes("status = 'reuse_detected'"))).toBe(
      true,
    );
    const audit = findAudit(database.queries, 'auth.refresh.reuse_detected');
    expect(audit?.params).toEqual([
      'auth.refresh.reuse_detected',
      'session-1',
      42,
      'manager',
      'manager',
      'auth-command',
      null,
      null,
      'backend',
      JSON.stringify({
        sessionId: 'session-1',
        tokenFamilyId: 'family-1',
        outcome: 'rejected',
        reason: 'reuse_detected',
      }),
    ]);
    expect(JSON.stringify(audit?.params)).not.toContain('refresh-login');
  });

  it('writes logout audit without storing raw refresh token', async () => {
    const database = createDatabase({
      refreshRow: {
        token_id: 'token-old',
        user_id: '42',
        session_id: 'session-1',
        token_family_id: 'family-1',
        expires_at: new Date('2026-05-02T12:00:00.000Z'),
        revoked_at: null,
        session_status: 'active',
        username: 'manager',
        role_id: 10,
        is_active: true,
      },
    });
    const manager = createManager(database.service);

    await manager.logout({
      refreshToken: 'refresh-login',
      userAgent: 'agent',
      ipAddress: '127.0.0.1',
      requestId: 'req-logout',
    });

    const audit = findAudit(database.queries, 'auth.logout');
    expect(audit?.params).toEqual([
      'auth.logout',
      'session-1',
      42,
      'manager',
      'manager',
      'req-logout',
      '127.0.0.1',
      'agent',
      'backend',
      JSON.stringify({
        sessionId: 'session-1',
        tokenFamilyId: 'family-1',
        reason: 'logout',
        refreshTokenPresent: true,
      }),
    ]);
    expect(JSON.stringify(audit?.params)).not.toContain('refresh-login');
  });

  it('revokes BOTH sessions when the bearer and the refresh cookie desynced (multi-tab re-login)', async () => {
    const refreshRow = {
      token_id: 'token-old',
      user_id: '42',
      session_id: 'session-1',
      token_family_id: 'family-1',
      expires_at: new Date('2100-01-01T00:00:00.000Z'),
      revoked_at: null,
      session_status: 'active',
      username: 'manager',
      role_id: 10,
      is_active: true,
    };
    const database = createDatabase({
      refreshRow,
      providerSessions: {
        'session-1': { provider_session_id: null, auth_source: 'backend' },
        'session-2': { provider_session_id: 'sid-2', auth_source: 'workos' },
      },
    });
    const manager = createManager(database.service, { supportsProviderSessions: true });

    // Tab B re-logged in (cookie now session-1); tab A still acts on
    // session-2 via its bearer. Logout must end both, and the provider
    // redirect must target the ACTING tab's SSO session.
    await expect(
      manager.logout({
        refreshToken: 'refresh-login',
        currentUser: {
          id: '42',
          username: 'manager',
          role: 'manager',
          roleId: 10,
          permissions: [],
          sessionId: 'session-2',
        },
      }),
    ).resolves.toEqual({ ok: true, providerSessionId: 'sid-2', authSource: 'workos' });

    const revokes = database.queries.filter(
      (query) => query.text.includes("SET status = 'revoked'") && query.text.includes('RETURNING session_id'),
    );
    expect(revokes.map((query) => query.params[0])).toEqual(['session-2']);
    const audits = database.queries.filter((query) => query.params[0] === 'auth.logout' || query.text.includes("'auth.logout'"));
    expect(audits).toHaveLength(2);
  });

  it('keeps the acting tab SSO provenance in the desync case even without a sid', async () => {
    const refreshRow = {
      token_id: 'token-old',
      user_id: '42',
      session_id: 'session-1',
      token_family_id: 'family-1',
      expires_at: new Date('2100-01-01T00:00:00.000Z'),
      revoked_at: null,
      session_status: 'active',
      username: 'manager',
      role_id: 10,
      is_active: true,
    };
    const currentUser = {
      id: '42',
      username: 'manager',
      role: 'manager' as const,
      roleId: 10,
      permissions: [],
      sessionId: 'session-2',
    };

    // cookie=backend, bearer=workos WITHOUT sid: the result must carry the
    // workos provenance so the controller answers 'unavailable', never a
    // false 'not_applicable' from the cookie session.
    const backendCookie = createDatabase({
      refreshRow,
      providerSessions: {
        'session-1': { provider_session_id: null, auth_source: 'backend' },
        'session-2': { provider_session_id: null, auth_source: 'workos' },
      },
    });
    await expect(
      createManager(backendCookie.service, { supportsProviderSessions: true }).logout({
        refreshToken: 'refresh-login',
        currentUser,
      }),
    ).resolves.toEqual({ ok: true, authSource: 'workos' });

    // cookie=workos (other session, with sid), bearer=workos without sid:
    // still the acting tab wins.
    const workosCookie = createDatabase({
      refreshRow,
      providerSessions: {
        'session-1': { provider_session_id: 'sid-1', auth_source: 'workos' },
        'session-2': { provider_session_id: null, auth_source: 'workos' },
      },
    });
    await expect(
      createManager(workosCookie.service, { supportsProviderSessions: true }).logout({
        refreshToken: 'refresh-login',
        currentUser,
      }),
    ).resolves.toEqual({ ok: true, authSource: 'workos' });
  });

  it('does not fabricate a logout audit for an already revoked session (stale bearer)', async () => {
    const database = createDatabase({ deadSessions: ['session-dead'] });
    const manager = createManager(database.service, { supportsProviderSessions: true });

    await expect(
      manager.logout({
        currentUser: {
          id: '42',
          username: 'manager',
          role: 'manager',
          roleId: 10,
          permissions: [],
          sessionId: 'session-dead',
        },
      }),
    ).resolves.toEqual({ ok: true });

    expect(database.queries.filter((query) => query.text.includes('audit_log'))).toHaveLength(0);
  });

  it('degrades whitespace-only legacy provider_session_id to a local logout', async () => {
    const refreshRow = {
      token_id: 'token-old',
      user_id: '42',
      session_id: 'session-1',
      token_family_id: 'family-1',
      expires_at: new Date('2026-05-02T12:00:00.000Z'),
      revoked_at: null,
      session_status: 'active',
      username: 'manager',
      role_id: 10,
      is_active: true,
    };

    const dirty = createDatabase({ refreshRow, providerSessionId: '   ' });
    await expect(
      createManager(dirty.service, { supportsProviderSessions: true }).logout({
        refreshToken: 'refresh-login',
      }),
    ).resolves.toEqual({ ok: true });

    const clean = createDatabase({ refreshRow, providerSessionId: 'sid-1', authSource: 'workos' });
    await expect(
      createManager(clean.service, { supportsProviderSessions: true }).logout({
        refreshToken: 'refresh-login',
      }),
    ).resolves.toEqual({ ok: true, providerSessionId: 'sid-1', authSource: 'workos' });
  });

  it('keeps workos provenance in refresh and logout audits (source survives the whole session)', async () => {
    const workosRefreshRow = {
      token_id: 'token-old',
      user_id: '42',
      session_id: 'session-1',
      token_family_id: 'family-1',
      expires_at: new Date('2100-01-01T00:00:00.000Z'),
      revoked_at: null,
      session_status: 'active',
      username: 'manager',
      role_id: 10,
      is_active: true,
      auth_source: 'workos',
    };

    const refreshDb = createDatabase({ refreshRow: workosRefreshRow });
    await createManager(refreshDb.service, { supportsProviderSessions: true }).refresh({
      refreshToken: 'refresh-login',
    });
    const refreshAudit = findAudit(refreshDb.queries, 'auth.refresh');
    expect(refreshAudit?.params[8]).toBe('workos');

    const logoutDb = createDatabase({
      refreshRow: workosRefreshRow,
      providerSessionId: 'sid-1',
      authSource: 'workos',
    });
    await createManager(logoutDb.service, { supportsProviderSessions: true }).logout({
      refreshToken: 'refresh-login',
    });
    const logoutAudit = findAudit(logoutDb.queries, 'auth.logout');
    expect(logoutAudit?.params[8]).toBe('workos');
  });

  it('normalizes dirty legacy auth_source values instead of dropping workos provenance', async () => {
    const dirtyRow = {
      token_id: 'token-old',
      user_id: '42',
      session_id: 'session-1',
      token_family_id: 'family-1',
      expires_at: new Date('2100-01-01T00:00:00.000Z'),
      revoked_at: null,
      session_status: 'active',
      username: 'manager',
      role_id: 10,
      is_active: true,
      auth_source: '  WORKOS  ',
    };

    const refreshDb = createDatabase({ refreshRow: dirtyRow });
    await createManager(refreshDb.service, { supportsProviderSessions: true }).refresh({
      refreshToken: 'refresh-login',
    });
    expect(findAudit(refreshDb.queries, 'auth.refresh')?.params[8]).toBe('workos');

    // Garbage values degrade to 'backend', never crash or leak raw strings.
    const garbageDb = createDatabase({ refreshRow: { ...dirtyRow, auth_source: 'sso?!' } });
    await createManager(garbageDb.service, { supportsProviderSessions: true }).refresh({
      refreshToken: 'refresh-login',
    });
    expect(findAudit(garbageDb.queries, 'auth.refresh')?.params[8]).toBe('backend');

    const logoutDb = createDatabase({
      refreshRow: dirtyRow,
      providerSessionId: null,
      authSource: ' WORKOS ',
    });
    await expect(
      createManager(logoutDb.service, { supportsProviderSessions: true }).logout({
        refreshToken: 'refresh-login',
      }),
    ).resolves.toEqual({ ok: true, authSource: 'workos' });
  });

  it('persists auth_source even when the provider returned no sid, and logout surfaces it', async () => {
    const database = createDatabase();
    const manager = createManager(database.service, { supportsProviderSessions: true });

    await manager.createLoginSession(
      { id: '42', username: 'manager', roleId: 10, passwordHash: 'hash', isActive: true },
      { authSource: 'workos' },
    );

    const insert = database.queries.find((query) => query.text.includes('INSERT INTO auth_sessions'));
    expect(insert?.text).toContain('provider_session_id, auth_source');
    expect(insert?.params[4]).toBeNull();
    expect(insert?.params[5]).toBe('workos');

    const refreshRow = {
      token_id: 'token-old',
      user_id: '42',
      session_id: 'session-1',
      token_family_id: 'family-1',
      expires_at: new Date('2026-05-02T12:00:00.000Z'),
      revoked_at: null,
      session_status: 'active',
      username: 'manager',
      role_id: 10,
      is_active: true,
    };
    const sidless = createDatabase({ refreshRow, providerSessionId: null, authSource: 'workos' });
    await expect(
      createManager(sidless.service, { supportsProviderSessions: true }).logout({
        refreshToken: 'refresh-login',
      }),
    ).resolves.toEqual({ ok: true, authSource: 'workos' });
  });
});

function createManager(
  database: DatabaseService,
  extraOptions: {
    supportsProviderSessions?: boolean;
    enforceLoginPolicy?: boolean;
    sessionTtlSeconds?: number;
  } = {},
): PgAuthSessionManager {
  return new PgAuthSessionManager(
    database,
    new FixedTokenService(),
    new JwtAccessTokenIssuer(
      'test-access-secret-with-at-least-32-chars',
      900,
      () => new Date('2026-05-01T12:00:00.000Z'),
    ),
    {
      refreshTokenPepper: 'test-refresh-pepper-with-at-least-32',
      refreshTokenTtlDays: 7,
      sessionTtlSeconds: 36000,
      ...extraOptions,
    },
  );
}

function createDatabase(
  options: {
    refreshRow?: Record<string, unknown>;
    providerSessionId?: string | null;
    authSource?: string | null;
    guardIsActive?: boolean;
    guardIsServiceAccount?: boolean;
    guardLoginPolicy?: string | null;
    guardLinked?: boolean;
    deadSessions?: string[];
    providerSessions?: Record<string, { provider_session_id: string | null; auth_source: string | null }>;
  } = {},
) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const tx = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });

      if (text.includes('FROM user_identities')) {
        return { rows: options.guardLinked === false ? [] : [{ '?column?': 1 }] };
      }

      if (text.includes("SET status = 'revoked'") && text.includes('RETURNING session_id')) {
        const sessionId = String(params[0]);
        return {
          rows: options.deadSessions?.includes(sessionId) ? [] : [{ session_id: sessionId }],
        };
      }

      if (text.includes('FROM users WHERE user_id = $1 FOR UPDATE')) {
        return {
          rows: [
            {
              is_active: options.guardIsActive ?? true,
              is_service_account: options.guardIsServiceAccount ?? false,
              login_policy: options.guardLoginPolicy ?? 'both',
            },
          ],
        };
      }

      if (text.includes('INSERT INTO auth_sessions')) {
        return { rows: [{ session_id: 'session-1', token_family_id: 'family-1' }] };
      }

      if (text.includes('RETURNING token_id::text')) {
        return { rows: [{ token_id: 'token-new' }] };
      }

      if (text.includes('FROM refresh_tokens rt')) {
        if (!options.refreshRow) return { rows: [] };
        const tokenExpiresAt = new Date(String(options.refreshRow.expires_at));
        return {
          rows: [{
            session_created_at: new Date(tokenExpiresAt.getTime() - 36_000_000),
            session_expires_at: tokenExpiresAt,
            ...options.refreshRow,
          }],
        };
      }

      if (text.includes('SELECT provider_session_id, auth_source FROM auth_sessions')) {
        const sessionId = String(params[0]);

        if (options.providerSessions && sessionId in options.providerSessions) {
          return { rows: [options.providerSessions[sessionId]] };
        }

        return {
          rows:
            options.providerSessionId === undefined && options.authSource === undefined
              ? []
              : [
                  {
                    provider_session_id: options.providerSessionId ?? null,
                    auth_source: options.authSource ?? null,
                  },
                ],
        };
      }

      return { rows: [] };
    },
  };

  return {
    queries,
    service: {
      async query(text: string, params: readonly unknown[] = []) {
        return tx.query(text, params);
      },
      async transaction<T>(handler: (client: typeof tx) => Promise<T>) {
        return handler(tx);
      },
    } as unknown as DatabaseService,
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function findAudit(
  queries: Array<{ text: string; params: readonly unknown[] }>,
  event: string,
): { text: string; params: readonly unknown[] } | undefined {
  return queries.find(
    (query) => query.text.includes('INSERT INTO audit_log') && query.params[0] === event,
  );
}
