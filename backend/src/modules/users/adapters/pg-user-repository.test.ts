import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgUserRepository } from './pg-user-repository';
import { staticRawAuthorizationSnapshot } from '../../../permissions/testing/static-authorization-snapshot';

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

  it('excludes service accounts from user-facing list and get queries', async () => {
    const database = new FakeUserDatabase([
      { rows: [{ total: 0 }] },
      { rows: [] },
      { rows: [] },
    ]);
    const repository = new PgUserRepository(database);

    await repository.listUsers({
      currentUser: currentUser('admin'),
      query: { page: 1, pageSize: 10 },
    });
    await expect(
      repository.getUserById({ currentUser: currentUser('admin'), userId: 86 }),
    ).resolves.toBeNull();

    expect(database.queries[0].text).toContain('u.is_service_account = false');
    expect(database.queries[1].text).toContain('u.is_service_account = false');
    expect(database.queries[2].text).toContain('u.is_service_account = false');
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
    expect(audit?.params[20]).toContain('"username":"new_manager"'); // $21 after_json
    // diff_json: create diff should show all fields from null
    expect(audit?.params[21]).toContain('"username"');     // $22 diff_json has username key
    expect(audit?.params[21]).toContain('"from":null');    // before is null on create
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

  it('updates a user role and writes audit diff_json with only changed sanitized fields', async () => {
    const database = new FakeUserDatabase([], [
      // pre-image SELECT (getUserByIdInternal on tx)
      { match: 'FROM users u', rows: [userRow({ user_id: 15, username: 'worker_user', role_id: 20, role_code: 'manager' })] },
      // UPDATE users
      { match: 'UPDATE users u', rows: [userRow({ user_id: 15, username: 'worker_user', role_id: 1, role_code: 'admin' })] },
      // audit INSERT
      { match: 'INSERT INTO audit_log', rows: [] },
    ]);
    const repository = new PgUserRepository(database);

    const user = await repository.updateUser({
      currentUser: currentUser('admin', '1'),
      userId: 15,
      requestId: 'req_update_role',
      dto: { role: 'admin' },
    });

    expect(user).toMatchObject({ id: 15, role: 'admin' });

    const audit = database.queries.find((q) => q.text.includes('INSERT INTO audit_log'));
    expect(audit?.params[0]).toBe('users.update');
    // diff_json: only the changed field (role) should appear
    const diffJson = audit?.params[21] as string;
    expect(diffJson).toContain('"role"');
    expect(diffJson).toContain('"from":"manager"');
    expect(diffJson).toContain('"to":"admin"');
    // unchanged fields (username, isActive, etc.) must NOT appear in diff
    expect(diffJson).not.toContain('"username"');
    expect(diffJson).not.toContain('"isActive"');
  });

  it('links the user audit to the employee before and after a relink', async () => {
    const database = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 15, employee_id: 5 })] },
      { match: 'UPDATE users u', rows: [userRow({ user_id: 15, employee_id: 7 })] },
      { match: 'INSERT INTO audit_log', rows: [{ audit_id: 'audit-relink' }] },
      { match: 'INSERT INTO audit_log_related_entity', rows: [] },
      { match: 'INSERT INTO audit_log_related_entity', rows: [] },
    ]);
    const repository = new PgUserRepository(database);

    await repository.updateUser({ currentUser: currentUser('admin', '1'), userId: 15, requestId: 'req_relink', dto: { employeeId: 7 } });

    const related = database.queries.filter((q) => q.text.includes('INSERT INTO audit_log_related_entity')).map((q) => q.params);
    expect(related).toEqual([['audit-relink', 'employee', 5], ['audit-relink', 'employee', 7]]);
    // The pre-image is read under the row lock (a concurrent relink waits; «before» is the replaced employee).
    expect(database.queries[0].text).toContain('FOR NO KEY UPDATE OF u');
  });

  it('changes password and revokes active sessions inside one transaction', async () => {
    const database = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 10 })] },
      { match: 'UPDATE users', rows: [{ user_id: 10, row_version: 2 }] },
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
    ).resolves.toEqual({ success: true, revokedSessions: 2, rowVersion: 2 });

    expect(database.transactionCount).toBe(1);
    // Same lock order as every authorization command: permissions_state, then the user row (§5.1).
    expect(database.authQueries[0].text).toContain('FROM permissions_state WHERE id = true FOR UPDATE');
    expect(database.queries[0].text).toContain('FOR NO KEY UPDATE OF u');
    expect(database.queries[1].text).toContain('UPDATE users');
    expect(database.queries[1].text).toContain('row_version = row_version + 1');
    expect(database.queries[2].text).toContain('UPDATE auth_sessions');
    expect(database.queries[3].params).toContain('users.change_password');

    // SECURITY: no password_hash or bcrypt hash must appear in any audit param
    const auditParams = database.queries[3].params;
    const allParamsStr = JSON.stringify(auditParams);
    expect(allParamsStr).not.toContain('password_hash');
    expect(allParamsStr).not.toMatch(/\$2[aby]\$/);

    // diff_json must contain static credentialChanged marker (key avoids "password" redaction trigger)
    const diffJson = auditParams[21] as string;
    expect(diffJson).toContain('"credentialChanged"');
    expect(diffJson).toContain('"from":false');
    expect(diffJson).toContain('"to":true');
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
      // pre-image SELECT (getUserByIdInternal on tx) — user is currently active
      { match: 'FROM users u', rows: [userRow({ user_id: 10, is_active: true })] },
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
    // diff_json: isActive changed from true to false
    const diffJson = audit?.params[21] as string;
    expect(diffJson).toContain('"isActive"');
    expect(diffJson).toContain('"from":true');
    expect(diffJson).toContain('"to":false');
    expect(JSON.parse(audit?.params[22] as string)).toEqual({
      revokedSessions: 1,
      permissionsVersionBefore: 1,
      permissionsVersionAfter: 2,
      accessChanges: ['activity'],
    }); // $23 metadata_json
  });

  it('applies user mutations only while the target still has the role the policy decided on', async () => {
    // Password change: the precondition is part of the UPDATE; a role changed meanwhile answers 409, nothing is written.
    const passwordDatabase = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 10, role_id: 100, role_code: 'viewer' })] },
      { match: 'UPDATE users', rows: [] },
      { match: 'SELECT role_id FROM users', rows: [{ role_id: 32 }] },
    ]);
    await expect(
      new PgUserRepository(passwordDatabase).changePassword({
        currentUser: currentUser('admin', '1'),
        userId: 10,
        expectedTargetRole: 'viewer',
        dto: { newPassword: 'new-secure-password', revokeExistingSessions: true },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'USER_ROLE_CHANGED' });
    expect(passwordDatabase.queries[1].text).toContain('($4::smallint IS NULL OR role_id = $4::smallint)');
    expect(passwordDatabase.queries[1].params[3]).toBe(100);
    expect(passwordDatabase.queries).toHaveLength(3);

    // Deactivation and update carry the same precondition.
    const activationDatabase = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 10, role_id: 10, role_code: 'manager' })] },
      { match: 'UPDATE users u', rows: [] },
      { match: 'SELECT role_id FROM users', rows: [{ role_id: 1 }] },
    ]);
    await expect(
      new PgUserRepository(activationDatabase).deactivateUser({ currentUser: currentUser('admin', '1'), userId: 10, expectedTargetRole: 'manager' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'USER_ROLE_CHANGED' });
    expect(activationDatabase.queries[1].text).toContain('($4::smallint IS NULL OR u.role_id = $4::smallint)');
    expect(activationDatabase.queries[1].params[3]).toBe(10);

    const updateDatabase = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 10, role_id: 100, role_code: 'viewer' })] },
      { match: 'UPDATE users u', rows: [] },
      { match: 'SELECT role_id FROM users', rows: [{ role_id: 1 }] },
    ]);
    await expect(
      new PgUserRepository(updateDatabase).updateUser({ currentUser: currentUser('admin', '1'), userId: 10, expectedTargetRole: 'viewer', dto: { fullName: 'X' } }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'USER_ROLE_CHANGED' });
    expect(updateDatabase.queries[1].text).toMatch(/\(\$\d+::smallint IS NULL OR u\.role_id = \$\d+::smallint\)/);
    expect(updateDatabase.queries[1].params.at(-1)).toBe(100);

    // Same role, no row: the user is gone (or is a service account) — still 404. Without an expected role: no precondition.
    const goneDatabase = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [] },
    ]);
    await expect(
      new PgUserRepository(goneDatabase).changePassword({ currentUser: currentUser('admin', '1'), userId: 10, expectedTargetRole: 'viewer', dto: { newPassword: 'new-secure-password', revokeExistingSessions: false } }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND' });
    const legacyDatabase = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 10 })] },
      { match: 'UPDATE users', rows: [{ user_id: 10, row_version: 2 }] },
    ]);
    await new PgUserRepository(legacyDatabase).changePassword({ currentUser: currentUser('admin', '1'), userId: 10, dto: { newPassword: 'new-secure-password', revokeExistingSessions: false } });
    expect(legacyDatabase.queries[1].params[3]).toBeNull();
  });

  it('maps the errors of the operator-role guard trigger to 409 API errors', async () => {
    const raised = (message: string) => Object.assign(new Error(message), { code: 'P0001' });
    const createDatabase = new FakeUserDatabase([], [
      { match: 'INSERT INTO users', error: raised('ONEC_OPERATOR_ROLE_DISABLED: role onec_operator is switched off') },
    ]);
    await expect(
      new PgUserRepository(createDatabase).createUser({
        currentUser: currentUser('admin', '1'),
        dto: { username: 'operator', email: 'operator@example.test', password: 'secure-password', role: 'onec_operator' },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ONEC_OPERATOR_ROLE_DISABLED' });
    expect(createDatabase.queries[0].params[3]).toBe(32);

    const updateDatabase = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 10, role_id: 100, role_code: 'viewer' })] },
      { match: 'UPDATE users u', error: raised('ONEC_OPERATOR_ROLE_TRANSITION: role onec_operator is assigned only at user creation (user_id 10)') },
    ]);
    await expect(
      new PgUserRepository(updateDatabase).updateUser({ currentUser: currentUser('superadmin', '1'), userId: 10, dto: { role: 'onec_operator' } }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ONEC_OPERATOR_ROLE_TRANSITION' });

    // Any other raised exception is not swallowed.
    const otherDatabase = new FakeUserDatabase([], [{ match: 'INSERT INTO users', error: raised('something else') }]);
    await expect(
      new PgUserRepository(otherDatabase).createUser({
        currentUser: currentUser('admin', '1'),
        dto: { username: 'x', email: 'x@example.test', password: 'secure-password', role: 'viewer' },
      }),
    ).rejects.toThrow('something else');
  });

  it('blocks service accounts from user-facing update, password, and activation queries', async () => {
    const updateDatabase = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [] },
      { match: 'UPDATE users u', rows: [] },
    ]);
    const updateRepository = new PgUserRepository(updateDatabase);

    await expect(
      updateRepository.updateUser({
        currentUser: currentUser('admin', '1'),
        userId: 86,
        dto: { fullName: 'Blocked service account update' },
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND' });

    // The locked pre-image already excludes service accounts: nothing is updated.
    expect(updateDatabase.queries[0].text).toContain('u.is_service_account = false');
    expect(updateDatabase.queries).toHaveLength(1);

    const passwordDatabase = new FakeUserDatabase([], [{ match: 'FROM users u', rows: [] }]);
    const passwordRepository = new PgUserRepository(passwordDatabase);

    await expect(
      passwordRepository.changePassword({
        currentUser: currentUser('admin', '1'),
        userId: 86,
        dto: { newPassword: 'new-secure-password', revokeExistingSessions: true },
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND' });

    expect(passwordDatabase.queries[0].text).toContain('is_service_account = false');

    const activationDatabase = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [] },
      { match: 'UPDATE users u', rows: [] },
    ]);
    const activationRepository = new PgUserRepository(activationDatabase);

    await expect(
      activationRepository.deactivateUser({
        currentUser: currentUser('admin', '1'),
        userId: 86,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND' });

    expect(activationDatabase.queries[0].text).toContain('u.is_service_account = false');
    expect(activationDatabase.queries).toHaveLength(1);

    const reactivationDatabase = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [] },
      { match: 'UPDATE users u', rows: [] },
    ]);
    const reactivationRepository = new PgUserRepository(reactivationDatabase);

    await expect(
      reactivationRepository.activateUser({
        currentUser: currentUser('admin', '1'),
        userId: 86,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND' });

    expect(reactivationDatabase.queries[0].text).toContain('u.is_service_account = false');
    expect(reactivationDatabase.queries).toHaveLength(1);
  });

  it('disabling through PATCH revokes sessions, bumps the authorization version and records the change (R1 #1, #8)', async () => {
    const database = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 15, is_active: true, row_version: 4 })] },
      { match: 'UPDATE users u', rows: [userRow({ user_id: 15, is_active: false, row_version: 5 })] },
      { match: 'WITH revoked_sessions', rows: [{ revoked_sessions: 3 }] },
      { match: 'INSERT INTO audit_log', rows: [] },
    ]);
    const user = await new PgUserRepository(database).updateUser({
      currentUser: currentUser('admin', '1'), userId: 15, requestId: 'req_patch_off', dto: { isActive: false },
    });

    expect(user).toMatchObject({ isActive: false, rowVersion: 5 });
    expect(database.queries[1].text).toContain('row_version = u.row_version + 1');
    expect(database.queries[2].text).toContain('UPDATE auth_sessions');
    expect(database.authQueries.some((q) => q.text.includes('UPDATE permissions_state SET version'))).toBe(true);
    expect(database.authQueries.some((q) => q.text.includes('AS remains'))).toBe(true);
    const audit = database.queries.find((q) => q.text.includes('INSERT INTO audit_log'));
    expect(JSON.parse(audit?.params[22] as string)).toEqual({
      permissionsVersionBefore: 1, permissionsVersionAfter: 2, accessChanges: ['activity'], revokedSessions: 3,
    });
    const outbox = database.authQueries.filter((q) => q.text.includes('INSERT INTO outbox_events'));
    expect(outbox).toHaveLength(1);
    expect(outbox[0].params[0]).toBe('15');
    expect(JSON.parse(outbox[0].params[1] as string)).toMatchObject({
      command: 'users.update', actorUserId: 1, requestId: 'req_patch_off', affectedUserIds: [15],
      changes: ['activity'], permissionsVersionBefore: 1, permissionsVersionAfter: 2,
    });
    expect(outbox[0].params[2]).toBe('authorization.changed:user-15:row-5');
  });

  it('a rename changes no authorization: no version bump, no lockout check, no event', async () => {
    const database = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 15 })] },
      { match: 'UPDATE users u', rows: [userRow({ user_id: 15, full_name: 'Renamed', row_version: 2 })] },
      { match: 'INSERT INTO audit_log', rows: [] },
    ]);
    await new PgUserRepository(database).updateUser({ currentUser: currentUser('admin', '1'), userId: 15, dto: { fullName: 'Renamed' } });
    expect(database.authQueries.some((q) => q.text.includes('UPDATE permissions_state') || q.text.includes('AS remains')
      || q.text.includes('outbox_events'))).toBe(false);
    expect(database.queries.some((q) => q.text.includes('auth_sessions'))).toBe(false);
  });

  it('refuses a change that leaves no active administrator, before anything is written (R1 #5)', async () => {
    const database = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 1, role_id: 2, role_code: 'superadmin' })] },
      { match: 'UPDATE users u', rows: [userRow({ user_id: 1, role_id: 1, role_code: 'admin' })] },
    ]);
    database.administrationRemains = false;
    // The only superadmin demotes himself: self-service is not an escalation, but the lockout check stops it.
    await expect(new PgUserRepository(database).updateUser({
      currentUser: currentUser('superadmin', '1'), userId: 1, dto: { role: 'admin' },
    })).rejects.toMatchObject({ statusCode: 409, code: 'PERMISSIONS_LOCKOUT_DENIED' });
    expect(database.queries.some((q) => q.text.includes('audit_log'))).toBe(false);
    expect(database.authQueries.some((q) => q.text.includes('UPDATE permissions_state') || q.text.includes('outbox_events'))).toBe(false);

    const deactivation = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 5, role_id: 2, role_code: 'superadmin' })] },
      { match: 'UPDATE users u', rows: [userRow({ user_id: 5, role_id: 2, role_code: 'superadmin', is_active: false })] },
      { match: 'WITH revoked_sessions', rows: [{ revoked_sessions: 0 }] },
    ]);
    deactivation.administrationRemains = false;
    await expect(new PgUserRepository(deactivation).deactivateUser({ currentUser: currentUser('superadmin', '1'), userId: 5 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PERMISSIONS_LOCKOUT_DENIED' });
  });

  it('re-runs the command policy on the actor read after the authorization lock (R1 #2)', async () => {
    const database = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 15, role_id: 100, role_code: 'viewer' })] },
    ]);
    // The administrator lost users.update while waiting for the lock: his fresh snapshot is a viewer.
    database.actorRoleId = 100;
    const seen: Array<{ actorRole: string; targetRole?: string }> = [];
    await expect(new PgUserRepository(database).updateUser({
      currentUser: currentUser('admin', '1'),
      userId: 15,
      dto: { fullName: 'X' },
      recheck: (actor, target) => {
        seen.push({ actorRole: actor.role, targetRole: target?.role });
        return actor.permissions.includes('users.update') ? null : 'missing_permission';
      },
    })).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED', details: { reason: 'missing_permission' } });
    expect(seen).toEqual([{ actorRole: 'viewer', targetRole: 'viewer' }]);
    expect(database.queries.some((q) => q.text.includes('UPDATE users'))).toBe(false);
    // Lock order: permissions_state, then the target row, then the actor snapshot.
    const lockIndex = database.authQueries.findIndex((q) => q.text.includes('FOR UPDATE'));
    const actorIndex = database.authQueries.findIndex((q) => q.text.includes('unnest'));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(actorIndex).toBeGreaterThan(lockIndex);

    // Creation is re-checked too (no target), and the password change takes the same lock first.
    const create = new FakeUserDatabase([], []);
    create.actorRoleId = 100;
    await expect(new PgUserRepository(create).createUser({
      currentUser: currentUser('admin', '1'),
      dto: { username: 'x_user', password: 'secure-password', role: 'viewer' },
      recheck: (actor, target) => (target === null && actor.permissions.includes('users.create') ? null : 'missing_permission'),
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(create.queries.some((q) => q.text.includes('INSERT INTO users'))).toBe(false);
  });

  it('refuses a stale form: expectedVersion is compared under the lock (R1 #6)', async () => {
    const stale = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 15, row_version: 7 })] },
    ]);
    await expect(new PgUserRepository(stale).updateUser({
      currentUser: currentUser('admin', '1'), userId: 15, expectedVersion: 6, dto: { isActive: false },
    })).rejects.toMatchObject({ statusCode: 409, code: 'USER_VERSION_CONFLICT', details: { currentVersion: 7, expectedVersion: 6 } });
    expect(stale.queries.some((q) => q.text.includes('UPDATE users'))).toBe(false);

    const current = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 15, row_version: 7, is_active: false })] },
      { match: 'UPDATE users u', rows: [userRow({ user_id: 15, row_version: 8, is_active: true })] },
      { match: 'INSERT INTO audit_log', rows: [] },
    ]);
    await expect(new PgUserRepository(current).activateUser({ currentUser: currentUser('admin', '1'), userId: 15, expectedVersion: 7 }))
      .resolves.toMatchObject({ rowVersion: 8, isActive: true });
  });

  it('a password change from an open form is refused when the user changed after the form was loaded (R3 #1)', async () => {
    const database = new FakeUserDatabase([], [{ match: 'FROM users u', rows: [userRow({ user_id: 10, row_version: 2 })] }]);
    await expect(new PgUserRepository(database).changePassword({
      currentUser: currentUser('admin', '1'), userId: 10, expectedVersion: 1,
      dto: { newPassword: 'new-secure-password', revokeExistingSessions: true },
    })).rejects.toMatchObject({ statusCode: 409, code: 'USER_VERSION_CONFLICT' });
    expect(database.queries.some((q) => q.text.includes('UPDATE users'))).toBe(false);
  });

  it('replays a completed command by Idempotency-Key without new effects; another payload is 409 (R1 #7)', async () => {
    const database = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 15, role_id: 100, role_code: 'viewer', row_version: 3 })] },
      { match: 'UPDATE users u', rows: [userRow({ user_id: 15, role_id: 20, role_code: 'worker', row_version: 4 })] },
      { match: 'INSERT INTO audit_log', rows: [] },
    ]);
    const repository = new PgUserRepository(database);
    const command = { currentUser: currentUser('admin', '1'), userId: 15, requestId: 'req-1', idempotencyKey: 'key-00000001', dto: { role: 'worker' as const } };
    const first = await repository.updateUser(command);
    const effects = () => ({
      users: database.queries.filter((q) => q.text.includes('UPDATE users')).length,
      audit: database.queries.filter((q) => q.text.includes('INSERT INTO audit_log')).length,
      versions: database.authQueries.filter((q) => q.text.includes('UPDATE permissions_state')).length,
      outbox: database.authQueries.filter((q) => q.text.includes('outbox_events')).length,
    });
    const afterFirst = effects();
    expect(afterFirst).toEqual({ users: 1, audit: 1, versions: 1, outbox: 1 });

    // The response was lost; the client repeats the same request — even with a later expectedVersion it is a replay.
    await expect(repository.updateUser({ ...command, requestId: 'req-2', expectedVersion: 99 })).resolves.toEqual(JSON.parse(JSON.stringify(first)));
    expect(effects()).toEqual(afterFirst);

    await expect(repository.updateUser({ ...command, dto: { role: 'viewer' } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(effects()).toEqual(afterFirst);
    expect([...database.idempotency.keys()]).toEqual(['users:key-00000001']);
  });

  it('a password command is idempotent only with the server secret; the password is bound by HMAC, not by the current hash (R2 #2)', async () => {
    const userRow10 = () => [
      { match: 'FROM users u', rows: [userRow({ user_id: 10 })] },
      { match: 'UPDATE users', rows: [{ user_id: 10, row_version: 2 }] },
      { match: 'WITH revoked_sessions', rows: [{ revoked_sessions: 0 }] },
      { match: 'INSERT INTO audit_log', rows: [] },
    ];
    const database = new FakeUserDatabase([], [...userRow10(), ...userRow10()]);
    const repository = new PgUserRepository(database, undefined, 'server-secret-of-at-least-32-characters!!');
    const command = (password: string, key = 'pw-key-0001') => ({
      currentUser: currentUser('admin', '1'), userId: 10, idempotencyKey: key,
      dto: { newPassword: password, revokeExistingSessions: true },
    });

    await expect(repository.changePassword(command('first-password'))).resolves.toEqual({ success: true, revokedSessions: 0, rowVersion: 2 });
    // Another command later sets a second password (state changes; the stored proof of K does not).
    await repository.changePassword(command('second-password', 'pw-key-0002'));
    // K with its own password is still a replay; K with the later password is another request.
    await expect(repository.changePassword(command('first-password'))).resolves.toEqual({ success: true, revokedSessions: 0, rowVersion: 2 });
    await expect(repository.changePassword(command('second-password'))).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    // Nothing derived from the password is stored without the secret: the stored hash is not a plain sha of it.
    const stored = database.idempotency.get('users:pw-key-0001')!.hash;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...database.idempotency.values()])).not.toContain('first-password');

    // Without the secret the key is ignored for password commands (the command runs as before, no stored response).
    const plain = new FakeUserDatabase([], userRow10());
    await new PgUserRepository(plain).changePassword(command('first-password', 'pw-key-0003'));
    expect(plain.idempotency.size).toBe(0);
  });

  it('finds a completed replay without a transaction; another payload is 409, unknown key is null (R2 #3)', async () => {
    const database = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 15, row_version: 3 })] },
      { match: 'UPDATE users u', rows: [userRow({ user_id: 15, full_name: 'A', row_version: 4 })] },
      { match: 'INSERT INTO audit_log', rows: [] },
    ]);
    const repository = new PgUserRepository(database);
    const command = { currentUser: currentUser('admin', '1'), userId: 15, idempotencyKey: 'replay-key-01', dto: { fullName: 'A' } };
    const first = await repository.updateUser(command);

    await expect(repository.findCompletedReplay('users.update', command)).resolves.toEqual(JSON.parse(JSON.stringify(first)));
    await expect(repository.findCompletedReplay('users.update', { ...command, dto: { fullName: 'B' } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(repository.findCompletedReplay('users.update', { ...command, currentUser: currentUser('admin', '2') }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(repository.findCompletedReplay('users.update', { ...command, idempotencyKey: 'unknown-key-1' })).resolves.toBeNull();
    await expect(repository.findCompletedReplay('users.update', { ...command, idempotencyKey: undefined })).resolves.toBeNull();
  });

  it('rolls a user command back when the account would exceed the administrator (access groups 0A.4)', async () => {
    const database = new FakeUserDatabase([], [
      { match: 'FROM users u', rows: [userRow({ user_id: 42, role_id: 1, role_code: 'admin' })] },
      { match: 'UPDATE users', rows: [{ user_id: '42' }] },
    ]);
    // The target is an admin; the acting top manager lacks admin permissions.
    database.targetRoleId = 1;
    await expect(new PgUserRepository(database as never).changePassword({
      currentUser: currentUser('top_manager'),
      userId: 42,
      expectedTargetRole: 'admin',
      dto: { newPassword: 'new-secure-password', revokeExistingSessions: true },
    } as never)).rejects.toMatchObject({ statusCode: 403, code: 'USER_ESCALATION_DENIED' });
    expect(database.authQueries.some((query) => query.text.includes('user_authorization_snapshot'))).toBe(true);
    // Nothing after the denial: no session revoke, no audit (the transaction rolls back).
    expect(database.queries.some((query) => query.text.includes('auth_sessions') || query.text.includes('audit_log'))).toBe(false);
  });

});

interface ExpectedQuery {
  match: string;
  rows?: QueryResultRow[];
  error?: unknown;
}

class FakeUserDatabase {
  readonly queries: Array<{ text: string; params: readonly unknown[] }>;
  readonly authQueries: Array<{ text: string; params: readonly unknown[] }> = [];
  /** Base role of the target account as the escalation snapshot sees it (default viewer). */
  targetRoleId = 100;
  /** Result of the lockout check (§5.2). */
  administrationRemains = true;
  actorRoleId = 1;
  readonly idempotency = new Map<string, { hash: string; actor: unknown; status: string; response: unknown }>();
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
    if (text.includes('FROM command_idempotency_keys')) {
      // Replay lookup outside the transaction (service, before the policy).
      return authorizationAuxiliary(text, params, this.targetRoleId, this) as QueryResult<T>;
    }
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
        // Authorization bookkeeping of access groups 0A (lock order, escalation snapshots, version bumps) is
        // recorded separately so the assertions on the user statements keep their positions.
        const auxiliary = authorizationAuxiliary(text, params, this.targetRoleId, this);
        if (auxiliary) {
          this.authQueries.push({ text, params });
          return auxiliary as QueryResult<T>;
        }
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

/** Test actors are `<role>-id`; targets (numeric ids) are viewers — inside every administrator's authority. */
interface AuxiliaryState {
  administrationRemains?: boolean;
  /** Base role of numeric actors read by the in-transaction recheck (default admin). */
  actorRoleId?: number;
  idempotency?: Map<string, { hash: string; actor: unknown; status: string; response: unknown }>;
}

function authorizationAuxiliary(
  text: string,
  params: readonly unknown[],
  targetRoleId = 100,
  options: AuxiliaryState = {},
): QueryResult<QueryResultRow> | null {
  const store = options.idempotency;
  if (store && text.includes('INSERT INTO command_idempotency_keys')) {
    const key = String(params[0]);
    if (store.has(key)) return { ...toQueryResult([]), rowCount: 0 };
    store.set(key, { hash: String(params[4]), actor: params[2], status: 'processing', response: null });
    return toQueryResult([{ idempotency_key: key }]);
  }
  if (store && text.includes('FROM command_idempotency_keys')) {
    const row = store.get(String(params[0]));
    return toQueryResult(row ? [{ request_hash: row.hash, response_json: row.response, status: row.status, actor_user_id: row.actor }] : []);
  }
  if (store && text.includes('UPDATE command_idempotency_keys')) {
    const row = store.get(String(params[0]));
    if (row) Object.assign(row, { status: 'completed', response: JSON.parse(String(params[1])) });
    return toQueryResult([]);
  }
  if (text.includes('unnest($1::bigint[])')) {
    return toQueryResult((params[0] as string[]).map((id) => ({
      snapshot: staticRawAuthorizationSnapshot({ userId: id, roleId: options.actorRoleId ?? 1 }),
    })));
  }
  if (text.includes('FROM permissions_state WHERE id = true FOR UPDATE')) return toQueryResult([{ version: 1 }]);
  if (text.includes('UPDATE permissions_state SET version')) return toQueryResult([{ version: 2 }]);
  if (text.includes('AS remains')) return toQueryResult([{ remains: options.administrationRemains ?? true }]);
  if (text.includes('INSERT INTO outbox_events')) return toQueryResult([]);
  if (text.includes('user_authorization_snapshot')) {
    const id = String(params[0]);
    const role = /^(\w+)-id$/.exec(id)?.[1];
    const roleId = role ? ({ superadmin: 2, admin: 1, top_manager: 15, manager: 10, operator: 11, worker: 20, packer: 30, viewer: 100 } as Record<string, number>)[role] ?? 100 : targetRoleId;
    return toQueryResult([{ snapshot: staticRawAuthorizationSnapshot({ userId: id, roleId }) }]);
  }
  return null;
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
    row_version: 1,
    ...overrides,
  };
}
