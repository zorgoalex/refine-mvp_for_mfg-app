import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { PgAuthAuditRepository } from './pg-auth-audit-repository';

describe('PgAuthAuditRepository', () => {
  it('writes failed login audit without password, token, cookie, or hash values', async () => {
    const database = createDatabase();
    const repository = new PgAuthAuditRepository(database.service);

    await repository.writeLoginFailed({
      username: 'manager',
      user: {
        id: '42',
        username: 'manager',
        roleId: 10,
        isActive: true,
      },
      reason: 'invalid_password',
      requestId: 'req-login-failed',
      userAgent: 'vitest-agent',
      ipAddress: '127.0.0.1',
    });

    expect(normalizeSql(database.queries[0].text)).toContain('INSERT INTO audit_log');
    expect(database.queries[0].params).toEqual([
      '42',
      42,
      'manager',
      'manager',
      'req-login-failed',
      '127.0.0.1',
      'vitest-agent',
      JSON.stringify({
        attemptedUsername: 'manager',
        reason: 'invalid_password',
        userKnown: true,
        userActive: true,
      }),
    ]);

    const serializedParams = JSON.stringify(database.queries[0].params);
    expect(serializedParams).not.toContain('raw-secret-password');
    expect(serializedParams).not.toContain('refresh');
    expect(serializedParams).not.toContain('token_hash');
    expect(serializedParams).not.toContain('cookie');
  });

  it('writes unknown-user login failures with a queryable attempted username', async () => {
    const database = createDatabase();
    const repository = new PgAuthAuditRepository(database.service);

    await repository.writeLoginFailed({
      username: 'missing',
      reason: 'unknown_user',
    });

    expect(database.queries[0].params).toEqual([
      'missing',
      null,
      'missing',
      null,
      'auth-command',
      null,
      null,
      JSON.stringify({
        attemptedUsername: 'missing',
        reason: 'unknown_user',
        userKnown: false,
        userActive: null,
      }),
    ]);
  });
});

function createDatabase() {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];

  return {
    queries,
    service: {
      async query(text: string, params: readonly unknown[] = []) {
        queries.push({ text, params });
        return { rows: [] };
      },
    } as unknown as DatabaseService,
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
