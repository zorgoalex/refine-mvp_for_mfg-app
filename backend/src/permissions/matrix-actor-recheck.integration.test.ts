import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../database/database.service';
import type { CurrentUser } from './current-user';
import { PermissionsService } from './permissions.service';

/**
 * The roles-matrix commands check the actor again after lockAuthorizationState (access groups plan R7 §4.2): a command
 * that waits for permissions_state while the actor loses the right (deactivation, or the access group that gave it)
 * must be refused with 403 once it gets the lock — it may not change the matrix with rights revoked meanwhile.
 * Needs a scratch database with the full ERP schema and the reference rows of roles/permissions
 * (TEST_AUTHZ_DATABASE_URL); creates its own users and groups and removes them.
 */
const databaseUrl = process.env.TEST_AUTHZ_DATABASE_URL;
const PREFIX = 'E2E-authz-recheck';

describe.skipIf(!databaseUrl)('roles-matrix commands re-check the actor after the lock (PostgreSQL)', { timeout: 60_000 }, () => {
  let pool: Pool;
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
  const permissions = new PermissionsService(database);
  const ADMIN_RIGHTS = ['system.superadmin', 'permissions.manage', 'roles.manage'] as const;

  const insertUser = async (suffix: string, roleId: number) => Number((await pool.query<{ user_id: string }>(
    `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'x', $3) RETURNING user_id`,
    [`${PREFIX}-${suffix}`, `${PREFIX}-${suffix}@example.invalid`.toLowerCase(), roleId],
  )).rows[0].user_id);
  const actor = (id: number, role: CurrentUser['role'], roleId: number): CurrentUser =>
    ({ id: String(id), username: `${PREFIX}-${id}`, role, roleId, permissions: [...ADMIN_RIGHTS] });
  const version = async () => Number((await pool.query('SELECT version FROM permissions_state WHERE id = true')).rows[0].version);
  const waitingOnState = async () => {
    for (let i = 0; i < 200; i += 1) {
      const rows = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%permissions_state%' AND query NOT LIKE '%pg_stat_activity%'`);
      if (rows.rowCount) return true;
      await new Promise((done) => setTimeout(done, 50));
    }
    return false;
  };
  /** A failed assertion may not hand the locked transaction back to the pool: roll back, or drop the connection. */
  const releaseHolder = async (holder: PoolClient, pending?: Promise<unknown>) => {
    let broken = false;
    await holder.query('ROLLBACK').catch(() => { broken = true; });
    holder.release(broken);
    await pending?.catch(() => undefined);
  };
  const outcome = (promise: Promise<unknown>) => promise.then(
    () => 'done',
    (error: { statusCode?: number; code?: string }) => `${error.statusCode} ${error.code}`,
  );

  let keeperId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6, statement_timeout: 30_000 });
    if (!(await pool.query(`SELECT to_regclass('public.access_groups') IS NOT NULL AS ok`)).rows[0].ok) {
      await pool.query((await readFile(new URL('../../db/migrations/285_access_groups.sql', import.meta.url), 'utf8')));
    }
    // A superadmin by role that is never touched: the lockout rule stays satisfied in every case.
    keeperId = await insertUser('keeper', 2);
    await permissions.seedDefaults();
  }, 60_000);

  afterAll(async () => {
    await pool.query(`UPDATE permissions_state SET access_groups_enabled = false WHERE id = true`);
    await pool.query(`DELETE FROM access_groups WHERE code LIKE 'e2e_recheck%'`);
    await pool.query(`DELETE FROM users WHERE username LIKE $1`, [`${PREFIX}%`]);
    await pool?.end();
  });

  it('a matrix update that waited while its actor was deactivated is refused with 403', async () => {
    const actorId = await insertUser('deactivated', 2);
    const holder = await pool.connect();
    let update: Promise<string> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT version FROM permissions_state WHERE id = true FOR UPDATE');
      update = outcome(permissions.updateRolesMatrix(actor(actorId, 'superadmin', 2),
        { version: await version(), rolePermissions: {}, roleScopes: {} }, 'it-recheck'));
      expect(await waitingOnState()).toBe(true);
      await holder.query('UPDATE users SET is_active = false WHERE user_id = $1', [actorId]);
      await holder.query('COMMIT');
      expect(await update).toBe('403 PERMISSION_DENIED');
    } finally {
      await releaseHolder(holder, update);
    }
    // The same actor active again passes: the refusal came from the re-check, not from the request.
    await pool.query('UPDATE users SET is_active = true WHERE user_id = $1', [actorId]);
    await expect(permissions.updateRolesMatrix(actor(actorId, 'superadmin', 2),
      { version: await version(), rolePermissions: {}, roleScopes: {} }, 'it-recheck-ok')).resolves.toMatchObject({ version: expect.any(Number) });
  });

  it('a role reset that waited while the access group of its actor was taken away is refused with 403', async () => {
    // Viewer by role, administrator only through an access group (switch on).
    const actorId = await insertUser('group-admin', 100);
    const groupId = Number((await pool.query<{ group_id: string }>(
      `INSERT INTO access_groups (code, name) VALUES ('e2e_recheck_admins', 'E2E admins') RETURNING group_id`)).rows[0].group_id);
    await pool.query(`INSERT INTO access_group_permissions (group_id, permission_name) SELECT $1, unnest($2::text[])`, [groupId, ADMIN_RIGHTS]);
    await pool.query(`INSERT INTO user_access_groups (user_id, group_id) VALUES ($1, $2)`, [actorId, groupId]);
    await pool.query(`UPDATE permissions_state SET access_groups_enabled = true WHERE id = true`);
    const viewerRoleId = 100;
    const holder = await pool.connect();
    let reset: Promise<string> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT version FROM permissions_state WHERE id = true FOR UPDATE');
      reset = outcome(permissions.resetRoleToDefaults(actor(actorId, 'viewer', viewerRoleId), viewerRoleId, 'it-recheck-reset'));
      expect(await waitingOnState()).toBe(true);
      await holder.query('DELETE FROM user_access_groups WHERE user_id = $1', [actorId]);
      await holder.query('COMMIT');
      expect(await reset).toBe('403 PERMISSION_DENIED');
    } finally {
      await releaseHolder(holder, reset);
    }
    expect(keeperId).toBeGreaterThan(0);
  });
});
