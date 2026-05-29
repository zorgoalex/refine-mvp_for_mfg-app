import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgUserRepository } from './pg-user-repository';

describe('PgUserRepository', () => {
  it('lists users with search, role, active filters and maps canonical permissions', async () => {
    const database = new FakeUserDatabase([
      { rows: [{ total: 1 }] },
      {
        rows: [
          userRow({
            user_id: 10,
            username: 'manager_user',
            role_id: 10,
            role_code: 'manager',
          }),
        ],
      },
    ]);
    const repository = new PgUserRepository(database);

    await expect(
      repository.listUsers({
        currentUser: currentUser('admin'),
        query: {
          page: 2,
          pageSize: 10,
          search: 'manager',
          role: 'manager',
          isActive: true,
        },
      }),
    ).resolves.toEqual({
      data: [
        expect.objectContaining({
          id: 10,
          username: 'manager_user',
          role: 'manager',
          permissions: getPermissionsForRole('manager'),
        }),
      ],
      pagination: { page: 2, pageSize: 10, total: 1, totalPages: 1 },
    });

    expect(database.queries[0].text).toContain('u.username ILIKE $1');
    expect(database.queries[0].text).toContain('u.role_id = $2');
    expect(database.queries[0].text).toContain('u.is_active = $3');
    expect(database.queries[1].params).toEqual(['%manager%', 10, true, 10, 10]);
  });

  it('creates a user with backend role mapping, bcrypt hash, and audit event', async () => {
    const database = new FakeUserDatabase([], [
      {
        match: 'INSERT INTO users',
        rows: [userRow({ user_id: 20, username: 'new_manager', role_id: 10, role_code: 'manager' })],
      },
      { match: 'INSERT INTO audit_log', rows: [] },
    ]);
    const repository = new PgUserRepository(database);

    const user = await repository.createUser({
      currentUser: currentUser('admin', '1'),
      requestId: 'req_users_create',
      dto: {
        username: 'new_manager',
        email: 'manager@example.test',
        password: 'secure-password',
        role: 'manager',
        fullName: 'Manager User',
      },
    });

    expect(user).toMatchObject({ id: 20, username: 'new_manager', role: 'manager' });
    const insert = database.queries.find((query) => query.text.includes('INSERT INTO users'));
    expect(insert?.params[3]).toBe(10);
    expect(insert?.params[2]).not.toBe('secure-password');
    expect(String(insert?.params[2])).toMatch(/^\$2[aby]\$/);

    const audit = database.queries.find((query) => query.text.includes('INSERT INTO audit_log'));
    // AuditService contract: 22 params in canonical order
    expect(audit?.params[0]).toBe('users.create');         // $1 event
    expect(audit?.params[1]).toBe('user');                 // $2 entity_type
    expect(audit?.params[2]).toBe('20');                   // $3 entity_id
    expect(audit?.params[3]).toBe(1);                      // $4 user_id (actorUserId)
    expect(audit?.params[4]).toBe('admin');                // $5 username
    expect(audit?.params[5]).toBe('admin');                // $6 role_code / role
    expect(audit?.params[6]).toBe('req_users_create');     // $7 request_id
    expect(audit?.params[7]).toBe('backend-users-command'); // $8 source
    expect(audit?.params[19]).toContain('"username":"new_manager"'); // $20 after_json
  });

  it('maps duplicate username/email violations to UserAlreadyExistsError', async () => {
    const database = new FakeUserDatabase([], [
      {
        match: 'INSERT INTO users',
        error: Object.assign(new Error('duplicate'), {
          code: '23505',
          constraint: 'uq_users_email',
        }),
      },
    ]);
    const repository = new PgUserRepository(database);

    await expect(
      repository.createUser({
        currentUser: currentUser('admin', '1'),
        dto: {
          username: 'existing',
          email: 'existing@example.test',
          password: 'secure-password',
          role: 'manager',
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'USER_ALREADY_EXISTS',
      details: { field: 'email' },
    } satisfies Partial<ApiError>);
  });

  it('changes password and revokes active sessions inside one transaction', async () => {
    const database = new FakeUserDatabase([], [
      { match: 'UPDATE users', rows: [{ user_id: 10 }] },
      { match: 'WITH revoked_sessions', rows: [{ revoked_sessions: 2 }] },
      { match: 'INSERT INTO audit_log', rows: [] },
    ]);
    const repository = new PgUserRepository(database);

    await expect(
      repository.changePassword({
        currentUser: currentUser('admin', '1'),
        userId: 10,
        requestId: 'req_password',
        dto: { newPassword: 'new-secure-password', revokeExistingSessions: true },
      }),
    ).resolves.toEqual({ success: true, revokedSessions: 2 });

    expect(database.transactionCount).toBe(1);
    expect(database.queries[0].text).toContain('UPDATE users');
    expect(database.queries[1].text).toContain('UPDATE auth_sessions');
    expect(database.queries[2].params).toContain('users.change_password');
  });

  it('routes createUser audit through AuditService contract with source column', async () => {
    const database = new FakeUserDatabase([], [
      {
        match: 'INSERT INTO users',
        rows: [userRow({ user_id: 42, username: 'E2E-Тест-user', role_id: 10, role_code: 'manager' })],
      },
      { match: 'INSERT INTO audit_log', rows: [] },
    ]);
    const repository = new PgUserRepository(database);

    await repository.createUser({
      currentUser: currentUser('admin', '1'),
      requestId: 'req_audit_contract',
      dto: {
        username: 'E2E-Тест-user',
        email: 'e2e-test-user@example.test',
        password: 'secure-password',
        role: 'manager',
        fullName: 'E2E Test User',
      },
    });

    const audit = database.queries.find((q) => q.text.includes('INSERT INTO audit_log'));
    expect(audit).toBeDefined();
    expect(audit?.text).toContain('source');
    expect(audit?.params).toContain('backend-users-command');
    expect(audit?.params).toContain('users.create');
  });

  it('deactivates a user, revokes sessions, and writes audit metadata', async () => {
    const database = new FakeUserDatabase([], [
      { match: 'UPDATE users u', rows: [userRow({ user_id: 10, is_active: false })] },
      { match: 'WITH revoked_sessions', rows: [{ revoked_sessions: 1 }] },
      { match: 'INSERT INTO audit_log', rows: [] },
    ]);
    const repository = new PgUserRepository(database);

    await expect(
      repository.deactivateUser({
        currentUser: currentUser('admin', '1'),
        userId: 10,
        requestId: 'req_deactivate',
      }),
    ).resolves.toMatchObject({ id: 10, isActive: false });

    const audit = database.queries.find((query) => query.text.includes('INSERT INTO audit_log'));
    expect(audit?.params[0]).toBe('users.deactivate');
    expect(audit?.params[7]).toBe('backend-users-command'); // $8 source
    expect(audit?.params[21]).toBe(JSON.stringify({ revokedSessions: 1 })); // $22 metadata_json
  });
});

interface ExpectedQuery {
  match: string;
  rows?: QueryResultRow[];
  error?: unknown;
}

class FakeUserDatabase {
  readonly queries: Array<{ text: string; params: readonly unknown[] }>;
  transactionCount = 0;
  private queryQueue: Array<QueryResult<QueryResultRow>>;
  private readonly transactionQueue: ExpectedQuery[];

  constructor(
    queryResults: Array<{ rows: QueryResultRow[] }> = [],
    transactionResults: ExpectedQuery[] = [],
  ) {
    this.queries = [];
    this.queryQueue = queryResults.map((result) => toQueryResult(result.rows));
    this.transactionQueue = [...transactionResults];
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    this.queries.push({ text, params });
    const next = this.queryQueue.shift() ?? toQueryResult([]);
    return next as QueryResult<T>;
  }

  async transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    const tx = {
      raw: undefined,
      query: async <T extends QueryResultRow = QueryResultRow>(
        text: string,
        params: readonly unknown[] = [],
      ): Promise<QueryResult<T>> => {
        this.queries.push({ text, params });
        const expected = this.transactionQueue.shift();
        if (!expected) {
          return toQueryResult([]) as QueryResult<T>;
        }
        expect(text).toContain(expected.match);
        if (expected.error) {
          throw expected.error;
        }

        return toQueryResult(expected.rows ?? []) as QueryResult<T>;
      },
    } as unknown as TransactionClient;

    return handler(tx);
  }
}

function toQueryResult(rows: QueryResultRow[]): QueryResult<QueryResultRow> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function currentUser(role: CurrentUser['role'], id = `${role}-id`): CurrentUser {
  return {
    id,
    username: role,
    role,
    roleId: 0,
    permissions: getPermissionsForRole(role),
  };
}

function userRow(overrides: Partial<QueryResultRow> = {}): QueryResultRow {
  return {
    user_id: 10,
    username: 'target_user',
    email: 'target@example.test',
    full_name: 'Target User',
    role_id: 10,
    role_code: 'manager',
    employee_id: null,
    is_active: true,
    created_at: new Date('2026-04-30T00:00:00.000Z'),
    updated_at: new Date('2026-04-30T01:00:00.000Z'),
    ...overrides,
  };
}
