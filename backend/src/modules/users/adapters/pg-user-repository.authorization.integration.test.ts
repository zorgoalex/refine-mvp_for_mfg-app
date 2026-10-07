import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import { UserAccessPolicy } from '../../../permissions/policies/user-access.policy';
import { PgUserIdentityRepository } from '../../auth/workos/pg-user-identity-repository';
import { PgUserRepository } from './pg-user-repository';
import { UserService } from '../application/user.service';

/**
 * Authorization command protocol of the users commands on a real PostgreSQL (access groups plan §5.1–5.3, §7).
 * Needs a database with the full ERP schema, migration 248 and the reference rows of roles/permissions
 * (TEST_AUTHZ_DATABASE_URL); it creates its own users and removes them.
 */
const databaseUrl = process.env.TEST_AUTHZ_DATABASE_URL;
const policy = new UserAccessPolicy();
const PREFIX = 'E2E-authz-0a';

describe.skipIf(!databaseUrl)('PgUserRepository authorization protocol (PostgreSQL)', () => {
  let pool: Pool;
  let superadminId: number;
  let adminId: number;
  let viewerId: number;

  const database = {
    isConfigured: true,
    query: <T extends QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(text, [...params]),
    transaction: async <T>(handler: (tx: PoolClient) => Promise<T>) => {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        try {
          const value = await handler(connection);
          await connection.query('COMMIT');
          return value;
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        }
      } finally {
        connection.release();
      }
    },
  } as unknown as DatabaseService;
  const repository = new PgUserRepository(database);

  const actor = (id: number, role: CurrentUser['role']): CurrentUser => ({ id: String(id), username: `${PREFIX}-${role}`, role, roleId: 0, permissions: [] });
  const insertUser = async (suffix: string, roleId: number) => (await pool.query<{ user_id: string }>(
    `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'x', $3) RETURNING user_id`,
    [`${PREFIX}-${suffix}`, `${PREFIX}-${suffix}@example.invalid`.toLowerCase(), roleId],
  )).rows[0].user_id;
  const version = async () => Number((await pool.query('SELECT version FROM permissions_state WHERE id = true')).rows[0].version);
  const count = async (sql: string, params: unknown[]) => Number((await pool.query(sql, params)).rows[0].n);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    // The only administrators of this database are the ones created here.
    const others = await count(
      `SELECT count(*) AS n FROM users WHERE is_active AND role_id IN (1, 2) AND username NOT LIKE $1`, [`${PREFIX}%`],
    );
    if (others > 0) throw new Error('TEST_AUTHZ_DATABASE_URL must be a scratch database without other administrators');
    superadminId = Number(await insertUser('superadmin', 2));
    adminId = Number(await insertUser('admin', 1));
    viewerId = Number(await insertUser('viewer', 100));
  });

  afterAll(async () => {
    if (!pool) return;
    const ids = [superadminId, adminId, viewerId].filter(Boolean);
    await pool.query(`DELETE FROM outbox_events WHERE aggregate_type = 'user' AND aggregate_id = ANY($1::text[])`, [ids.map(String)]);
    await pool.query(`DELETE FROM command_idempotency_keys WHERE idempotency_key LIKE 'users:${PREFIX}%'`);
    await pool.query(`DELETE FROM audit_log WHERE request_id IN ('it-cycle', 'it-race', 'it-race-retry', 'it-migr-matrix')`);
    await pool.query('DELETE FROM audit_log WHERE entity_type = $1 AND entity_id = ANY($2::text[])', ['user', ids.map(String)]);
    await pool.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [ids]);
    await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
    expect(await count('SELECT count(*) AS n FROM users WHERE username LIKE $1', [`${PREFIX}%`])).toBe(0);
    await pool.end();
  });

  it('the only superadmin cannot demote himself: 409 and nothing is committed', async () => {
    const before = await version();
    await expect(repository.updateUser({
      currentUser: actor(superadminId, 'superadmin'), userId: superadminId, requestId: 'it-lockout', dto: { role: 'admin' },
    })).rejects.toMatchObject({ statusCode: 409, code: 'PERMISSIONS_LOCKOUT_DENIED' });
    expect((await pool.query('SELECT role_id, row_version FROM users WHERE user_id = $1', [superadminId])).rows[0])
      .toMatchObject({ role_id: 2, row_version: '1' });
    expect(await version()).toBe(before);
    expect(await count(`SELECT count(*) AS n FROM audit_log WHERE request_id = 'it-lockout'`, [])).toBe(0);
  });

  it('an administrator who loses the right while waiting for the lock gets 403 (fresh recheck)', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT version FROM permissions_state WHERE id = true FOR UPDATE');
      await holder.query(`UPDATE role_permissions SET is_enabled = false WHERE role_id = 1 AND permission_name = 'users.deactivate'`);
      const pending = repository.deactivateUser({
        currentUser: actor(adminId, 'admin'), userId: viewerId, requestId: 'it-recheck',
        recheck: (fresh, target) => (target ? policy.canDeactivate(fresh, target) : 'missing_permission'),
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query('COMMIT');
      await expect(pending).rejects.toMatchObject({ statusCode: 403, details: { reason: 'missing_permission' } });
    } finally {
      await holder.query(`UPDATE role_permissions SET is_enabled = true WHERE role_id = 1 AND permission_name = 'users.deactivate'`);
      holder.release();
    }
    expect((await pool.query('SELECT is_active FROM users WHERE user_id = $1', [viewerId])).rows[0].is_active).toBe(true);
  });

  it('PATCH isActive=false revokes sessions, bumps the version and writes one event; a replay changes nothing', async () => {
    await pool.query(`INSERT INTO auth_sessions (user_id, expires_at) VALUES ($1, now() + interval '1 day')`, [viewerId]);
    const before = await version();
    const command = {
      currentUser: actor(adminId, 'admin'), userId: viewerId, requestId: 'it-patch-off',
      idempotencyKey: `${PREFIX}-patch-off`, expectedVersion: 1, dto: { isActive: false },
    };
    const first = await repository.updateUser(command);
    expect(first).toMatchObject({ isActive: false, rowVersion: 2 });
    expect(await version()).toBe(before + 1);
    expect(await count(`SELECT count(*) AS n FROM auth_sessions WHERE user_id = $1 AND status = 'active'`, [viewerId])).toBe(0);

    // Lost response: the same request again returns the stored result, although the version moved on.
    await expect(repository.updateUser({ ...command, requestId: 'it-patch-off-retry' })).resolves.toEqual(first);
    expect(await version()).toBe(before + 1);
    expect(await count(`SELECT count(*) AS n FROM audit_log WHERE request_id LIKE 'it-patch-off%'`, [])).toBe(1);
    const events = await pool.query(
      `SELECT payload_json FROM outbox_events WHERE event_type = 'authorization.changed' AND aggregate_id = $1`, [String(viewerId)],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload_json).toMatchObject({
      requestId: 'it-patch-off', affectedUserIds: [viewerId], changes: ['activity'],
      permissionsVersionBefore: before, permissionsVersionAfter: before + 1,
    });

    // A form built on the old version is refused.
    await expect(repository.activateUser({ currentUser: actor(adminId, 'admin'), userId: viewerId, expectedVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'USER_VERSION_CONFLICT' });
    await expect(repository.activateUser({ currentUser: actor(adminId, 'admin'), userId: viewerId, expectedVersion: 2 }))
      .resolves.toMatchObject({ isActive: true, rowVersion: 3 });
  });

  it('an administrator cannot manage an account wider than himself; the change rolls back', async () => {
    await expect(repository.updateUser({
      currentUser: actor(adminId, 'admin'), userId: viewerId, requestId: 'it-escalation', dto: { role: 'superadmin' },
    })).rejects.toMatchObject({ statusCode: 403, code: 'USER_ESCALATION_DENIED' });
    expect((await pool.query('SELECT role_id FROM users WHERE user_id = $1', [viewerId])).rows[0].role_id).toBe(100);
    expect(await count(`SELECT count(*) AS n FROM audit_log WHERE request_id = 'it-escalation'`, [])).toBe(0);
  });
  it('an SSO invitation is decided in its transaction and refused on use once the target outgrew its creator', async () => {
    const identities = new PgUserIdentityRepository(database, { loginPolicy: true, providerSessions: true, userIdentities: true, authMethod: true } as never);
    const session = (await pool.query<{ session_id: string }>(
      `INSERT INTO auth_sessions (user_id, expires_at) VALUES ($1, now() + interval '1 day') RETURNING session_id`, [adminId],
    )).rows[0].session_id;
    const invite = (invitationId: string, tokenHash: string, targetUserId: number) => identities.createLinkInvitationWithAudit({
      invitationId, tokenHash, expiresAt: new Date(Date.now() + 3_600_000), targetUserId: String(targetUserId),
      actor: { userId: String(adminId), username: `${PREFIX}-admin`, roleId: 1, requestId: 'it-invite' }, actorSessionId: session,
    });

    // An admin may not invite an identity for the superadmin (wider than himself).
    await expect(invite('00000000-0000-4000-8000-000000000001', 'a'.repeat(64), superadminId))
      .resolves.toEqual({ status: 'access_denied', reason: 'privilege_escalation_denied' });

    await expect(invite('00000000-0000-4000-8000-000000000002', 'b'.repeat(64), viewerId))
      .resolves.toMatchObject({ status: 'created' });
    // Later the viewer is promoted above the creator; the invitation must not survive that.
    await pool.query('UPDATE users SET role_id = 2 WHERE user_id = $1', [viewerId]);
    try {
      await expect(identities.consumeInvitationAndLinkWithAudit({
        invitationId: '00000000-0000-4000-8000-000000000002', provider: 'workos', providerUserId: `${PREFIX}-sub`,
        emailAtLink: 'late@example.invalid', emailVerified: true, requestId: 'it-invite-use',
      })).resolves.toEqual({ status: 'invitation_invalid' });
    } finally {
      await pool.query('UPDATE users SET role_id = 100 WHERE user_id = $1', [viewerId]);
    }
    expect((await pool.query(`SELECT revoked_at IS NOT NULL AS revoked, consumed_at FROM workos_link_invitations WHERE invitation_id = $1`,
      ['00000000-0000-4000-8000-000000000002'])).rows[0]).toEqual({ revoked: true, consumed_at: null });
    expect(await count(`SELECT count(*) AS n FROM user_identities WHERE provider_user_id = $1`, [`${PREFIX}-sub`])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM audit_log WHERE request_id = 'it-invite-use' AND event = 'auth.identity.invitation_revoked'`, [])).toBe(1);
  });
  it('no lock cycle between an SSO invitation, a session holder that seeds and a matrix update (R2 #1)', async () => {
    const identities = new PgUserIdentityRepository(database, { loginPolicy: true, providerSessions: true, userIdentities: true, authMethod: true } as never);
    const permissions = new PermissionsService(database);
    const session = (await pool.query<{ session_id: string }>(
      `INSERT INTO auth_sessions (user_id, expires_at) VALUES ($1, now() + interval '1 day') RETURNING session_id`, [adminId],
    )).rows[0].session_id;
    const waitingOn = async (fragment: string) => {
      for (let i = 0; i < 100; i += 1) {
        const rows = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE $1 AND query NOT LIKE '%pg_stat_activity%'`, [`%${fragment}%`]);
        if (rows.rowCount) return true;
        await new Promise((done) => setTimeout(done, 50));
      }
      return false;
    };
    const within = <T>(promise: Promise<T>, ms: number) => Promise.race([
      promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
    ]);

    // A refresh-like transaction holds the administrator's session row.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM auth_sessions WHERE session_id = $1 FOR UPDATE', [session]);
      // The invitation takes permissions_state (shared) and waits for the session.
      const invitation = identities.createLinkInvitationWithAudit({
        invitationId: '00000000-0000-4000-8000-000000000003', tokenHash: 'c'.repeat(64), expiresAt: new Date(Date.now() + 3_600_000),
        targetUserId: String(viewerId), actorSessionId: session,
        actor: { userId: String(adminId), username: `${PREFIX}-admin`, roleId: 1, requestId: 'it-cycle' },
      });
      expect(await waitingOn('FROM auth_sessions')).toBe(true);
      // The matrix update waits for permissions_state — before seeding, so it holds no catalog rows.
      const version = Number((await pool.query('SELECT version FROM permissions_state WHERE id = true')).rows[0].version);
      const matrix = permissions.updateRolesMatrix(
        { id: String(superadminId), username: `${PREFIX}-superadmin`, role: 'superadmin', roleId: 2, permissions: ['system.superadmin', 'permissions.manage', 'roles.manage'] },
        { version, rolePermissions: {}, roleScopes: {} },
        'it-cycle',
      );
      expect(await waitingOn('permissions_state')).toBe(true);
      // The session holder seeds through another connection (what the old refresh did): it must not wait.
      await within(permissions.seedDefaults(), 5_000);
      await holder.query('COMMIT');
      await expect(within(invitation, 10_000)).resolves.toMatchObject({ status: 'created' });
      await expect(within(matrix, 10_000)).resolves.toMatchObject({ version: version + 1 });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }, 30_000);
  it('a repeat of a completed keyed command returns its response although the target was promoted since (R3 #2)', async () => {
    const service = new UserService({ users: repository, database, permissions: new PermissionsService(database) });
    const admin = { ...actor(adminId, 'admin'), permissions: ['users.update', 'users.deactivate', 'users.activate'] as never };
    const command = { currentUser: admin, userId: viewerId, requestId: 'it-race', idempotencyKey: `${PREFIX}-race`, dto: { fullName: 'Race' } };
    const first = await service.update(command);
    // A superadmin promotes the target to admin: an admin may no longer manage it.
    await pool.query('UPDATE users SET role_id = 1 WHERE user_id = $1', [viewerId]);
    try {
      await expect(service.update({ ...command, requestId: 'it-race-retry' })).resolves.toEqual(JSON.parse(JSON.stringify(first)));
      // A new action on the promoted target is denied under the lock.
      await expect(service.update({ ...command, idempotencyKey: `${PREFIX}-race-2`, dto: { fullName: 'Other' } }))
        .rejects.toMatchObject({ statusCode: 403 });
    } finally {
      await pool.query('UPDATE users SET role_id = 100 WHERE user_id = $1', [viewerId]);
    }
    expect(await count(`SELECT count(*) AS n FROM audit_log WHERE request_id = 'it-race-retry'`, [])).toBe(0);
  });
  it('seed raises the permissions version when it adds grants, so old tokens refresh (0A.3 R1)', async () => {
    const permissions = new PermissionsService(database);
    const versionOf = async () => Number((await pool.query('SELECT version FROM permissions_state WHERE id = true')).rows[0].version);
    // A grant of the static matrix is missing (backend newer than the database): seed adds it and bumps the version.
    const removed = await pool.query(
      `DELETE FROM role_permissions WHERE role_id = 1 AND permission_name = 'groups.batch_link' RETURNING is_enabled`,
    );
    const before = await versionOf();
    await permissions.seedDefaults();
    expect(await versionOf()).toBe(before + (removed.rowCount ? 1 : 0));
    expect((await pool.query(`SELECT is_enabled FROM role_permissions WHERE role_id = 1 AND permission_name = 'groups.batch_link'`)).rows[0].is_enabled).toBe(true);
    // Nothing new: no bump.
    const steady = await versionOf();
    await permissions.seedDefaults();
    expect(await versionOf()).toBe(steady);
  });

  it('migration 249 and a roles-matrix save run concurrently without a lock cycle (0A.3 R2)', async () => {
    const migration = readFileSync(resolve(__dirname, '../../../../db/migrations/249_role_checks_to_permissions.sql'), 'utf8');
    const permissions = new PermissionsService(database);
    const holder = await pool.connect();
    const migrator = await pool.connect();
    const within = <T>(promise: Promise<T>, ms: number) => Promise.race([
      promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
    ]);
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT version FROM permissions_state WHERE id = true FOR UPDATE');
      // The matrix queues on permissions_state first; the migration comes second. With the old migration order
      // (catalog rows, then state) it would hold the catalog the matrix's seed needs while queued behind the matrix.
      const version = Number((await pool.query('SELECT version FROM permissions_state WHERE id = true')).rows[0].version);
      const matrix = permissions.updateRolesMatrix(
        { id: String(superadminId), username: `${PREFIX}-superadmin`, role: 'superadmin', roleId: 2, permissions: ['system.superadmin', 'permissions.manage', 'roles.manage'] },
        { version, rolePermissions: {}, roleScopes: {} },
        'it-migr-matrix',
      ).then((value) => value, (error: unknown) => error);
      await new Promise((done) => setTimeout(done, 300));
      const migrating = migrator.query(migration).then(() => null, (error: unknown) => error);
      await new Promise((done) => setTimeout(done, 300));
      await holder.query('COMMIT');
      // Both complete; neither is chosen as a deadlock victim (the matrix may meet a moved version: 409 is fine).
      const migrationOutcome = await within(migrating, 15_000);
      expect(migrationOutcome).toBeNull();
      const outcome = await within(matrix, 15_000);
      expect((outcome as { code?: string }).code).not.toBe('40P01');
      if (outcome instanceof Error) expect((outcome as { code?: string }).code).toBe('PERMISSIONS_VERSION_CONFLICT');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      migrator.release();
    }
  }, 40_000);
});
