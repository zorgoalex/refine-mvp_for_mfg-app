import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { JwtAccessTokenIssuer } from './jwt-access-token-issuer';
import { PgAuthSessionManager } from './pg-auth-session-manager';
import { TokenService } from '../token.service';

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
    });

    expect(database.queries.map((query) => normalizeSql(query.text))).toEqual([
      'INSERT INTO auth_sessions (user_id, expires_at, ip_address, user_agent) VALUES ($1, $2, $3, $4) RETURNING session_id::text, token_family_id::text',
      'INSERT INTO refresh_tokens ( user_id, session_id, token_hash, token_family_id, expires_at, user_agent, ip_address ) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      'UPDATE users SET last_login_at = now() WHERE user_id = $1',
      "INSERT INTO audit_log ( event, entity_type, entity_id, user_id, username, role_code, role, request_id, ip_address, user_agent, source, metadata_json ) VALUES ($1, 'auth_session', $2, $3, $4, $5, $5, $6, $7::inet, $8, 'backend', $9::jsonb)",
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
      JSON.stringify({
        sessionId: 'session-1',
        tokenFamilyId: 'family-1',
        outcome: 'success',
      }),
    ]);
    expect(JSON.stringify(audit?.params)).not.toContain('refresh-login');
    expect(JSON.stringify(audit?.params)).not.toContain('pepper');
    vi.useRealTimers();
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
        accessTokenExpiresAt: '2026-05-01T12:15:00.000Z',
        user: {
          id: '42',
          role: 'manager',
        },
      },
      refreshToken: 'refresh-login',
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
      JSON.stringify({
        sessionId: 'session-1',
        tokenFamilyId: 'family-1',
        reason: 'logout',
        refreshTokenPresent: true,
      }),
    ]);
    expect(JSON.stringify(audit?.params)).not.toContain('refresh-login');
  });
});

function createManager(database: DatabaseService): PgAuthSessionManager {
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
    },
  );
}

function createDatabase(options: { refreshRow?: Record<string, unknown> } = {}) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const tx = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });

      if (text.includes('INSERT INTO auth_sessions')) {
        return { rows: [{ session_id: 'session-1', token_family_id: 'family-1' }] };
      }

      if (text.includes('RETURNING token_id::text')) {
        return { rows: [{ token_id: 'token-new' }] };
      }

      if (text.includes('FROM refresh_tokens rt')) {
        return { rows: options.refreshRow ? [options.refreshRow] : [] };
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
