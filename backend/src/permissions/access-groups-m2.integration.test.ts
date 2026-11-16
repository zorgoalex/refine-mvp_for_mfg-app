import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration 285 (access groups M2) on a real PostgreSQL (TEST_DATABASE_URL — a scratch database, never stage or
 * prod), in an isolated schema: 248 is applied first and its answers are recorded, then 285 replaces the three objects.
 * With the switch off every answer must stay byte-for-byte the same; with the switch on a user gets the rights of the
 * active groups he is in, and nothing from an inactive group, an inactive catalog permission or as an inactive user.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('access groups M2: effective authorization = role ∪ active groups (PostgreSQL)', { timeout: 60_000 }, () => {
  const schema = `e2e_access_groups_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  const q = async <T extends object = Record<string, unknown>>(text: string, values?: unknown[]) =>
    (await pool.query<T & Record<string, unknown>>(text, values)).rows as T[];
  const local = (text: string) => text.replaceAll('public.', `"${schema}".`);
  const migration = async (name: string) => local(await readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8'));

  const answers = async () => ({
    perms: await q(`SELECT user_id::int, permission_name FROM user_effective_permissions ORDER BY 1, 2`),
    scopes: await q(`SELECT user_id::int, scope_key, scope_value FROM user_effective_scopes ORDER BY 1, 2, 3`),
    snapshots: await q(`SELECT u.user_id::int, user_authorization_snapshot(u.user_id) AS s FROM users u ORDER BY 1`),
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    pool.on('connect', (client) => { void client.query(`SET search_path = "${schema}"`); });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`SET search_path = "${schema}"`);
    await q(`
      CREATE TABLE roles (role_id bigint PRIMARY KEY, role_code text, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE users (user_id bigint PRIMARY KEY, username text NOT NULL, role_id bigint REFERENCES roles,
        is_active boolean NOT NULL DEFAULT true, is_service_account boolean NOT NULL DEFAULT false);
      CREATE TABLE permissions_catalog (permission_name text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true,
        sort_order int NOT NULL DEFAULT 0);
      CREATE TABLE role_permissions (role_id bigint REFERENCES roles, permission_name text REFERENCES permissions_catalog,
        is_enabled boolean NOT NULL DEFAULT true, PRIMARY KEY (role_id, permission_name));
      CREATE TABLE role_policy_scopes (role_id bigint REFERENCES roles, scope_key text, scope_value text,
        PRIMARY KEY (role_id, scope_key));
      CREATE TABLE permissions_state (id boolean PRIMARY KEY DEFAULT true, version bigint NOT NULL DEFAULT 1);
      INSERT INTO permissions_state DEFAULT VALUES;
      INSERT INTO roles VALUES (1, 'admin', true), (10, 'manager', true), (100, 'viewer', true);
      INSERT INTO permissions_catalog VALUES ('orders.view', true, 1), ('orders.update', true, 2),
        ('orders.manager.change', true, 3), ('payments.view', true, 4), ('legacy.retired', false, 5), ('system.superadmin', true, 0);
      INSERT INTO role_permissions VALUES (1, 'system.superadmin', true), (1, 'orders.view', true), (1, 'orders.update', true),
        (10, 'orders.view', true), (10, 'orders.update', true), (10, 'payments.view', false), (100, 'orders.view', true);
      INSERT INTO role_policy_scopes VALUES (1, 'orders.view', 'all'), (10, 'orders.view', 'own'), (10, 'payments.view', 'none'),
        (100, 'orders.view', 'all');
      INSERT INTO users (user_id, username, role_id, is_active) VALUES (1, 'admin', 1, true), (2, 'manager', 10, true),
        (3, 'viewer', 100, true), (4, 'gone', 10, false);`);
    await q(await migration('248_authorization_snapshot.sql'));
  }, 60_000);

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool?.end();
  });

  it('with the switch off the three objects answer exactly as 248, also with groups present', async () => {
    const before = await answers();
    await q(await migration('285_access_groups.sql'));
    expect(await answers()).toEqual(before);
    // Groups and members exist, the switch is off: still nothing changes.
    await q(`INSERT INTO access_groups (group_id, code, name) VALUES (1, 'manager_change', 'Смена менеджера'), (2, 'old', 'Старая');
      INSERT INTO access_group_permissions VALUES (1, 'orders.manager.change'), (1, 'legacy.retired'), (2, 'payments.view');
      INSERT INTO access_group_scopes VALUES (1, 'orders.view', 'assigned'), (2, 'payments.view', 'all');
      INSERT INTO user_access_groups (user_id, group_id) VALUES (2, 1), (3, 2), (4, 1);
      UPDATE access_groups SET is_active = false WHERE group_id = 2;`);
    expect(await answers()).toEqual(before);
  });

  it('with the switch on a member gets the rights and scope values of his active groups only', async () => {
    await q(`ALTER TABLE permissions_state ADD COLUMN IF NOT EXISTS access_groups_enabled boolean NOT NULL DEFAULT false;
      UPDATE permissions_state SET access_groups_enabled = true`);
    const perms = await q<{ user_id: number; permission_name: string }>(`SELECT user_id::int, permission_name FROM user_effective_permissions WHERE user_id IN (2, 3, 4) ORDER BY 1, 2`);
    // manager: role + group 1 (orders.manager.change; the retired catalog permission is not granted);
    // viewer: group 2 is inactive → nothing added; inactive user 4 → nothing at all.
    expect(perms).toEqual([
      { user_id: 2, permission_name: 'orders.manager.change' },
      { user_id: 2, permission_name: 'orders.update' },
      { user_id: 2, permission_name: 'orders.view' },
      { user_id: 3, permission_name: 'orders.view' },
    ]);
    const scopes = await q<{ scope_value: string }>(`SELECT scope_value FROM user_effective_scopes WHERE user_id = 2 AND scope_key = 'orders.view' ORDER BY 1`);
    expect(scopes.map((row) => row.scope_value)).toEqual(['assigned', 'own']);
    const [snapshot] = await q<{ s: { permissions: string[]; scopes: Record<string, string[]>; accessGroupsEnabled: boolean } }>(`SELECT user_authorization_snapshot(2) AS s`);
    expect(snapshot.s.accessGroupsEnabled).toBe(true);
    expect(snapshot.s.permissions).toEqual(['orders.view', 'orders.update', 'orders.manager.change']);
    expect(snapshot.s.scopes['orders.view']).toEqual(['assigned', 'own']);
    expect(snapshot.s.scopes['payments.view']).toEqual([]);
  });

  it('removing the member, deactivating the group or switching off takes the rights away', async () => {
    const managerChange = async () => (await q(`SELECT 1 FROM user_effective_permissions WHERE user_id = 2 AND permission_name = 'orders.manager.change'`)).length;
    expect(await managerChange()).toBe(1);
    await q(`UPDATE access_groups SET is_active = false WHERE group_id = 1`);
    expect(await managerChange()).toBe(0);
    await q(`UPDATE access_groups SET is_active = true WHERE group_id = 1; DELETE FROM user_access_groups WHERE user_id = 2`);
    expect(await managerChange()).toBe(0);
    await q(`INSERT INTO user_access_groups (user_id, group_id) VALUES (2, 1); UPDATE permissions_state SET access_groups_enabled = false`);
    expect(await managerChange()).toBe(0);
    const [snapshot] = await q<{ s: { permissions: string[] } }>(`SELECT user_authorization_snapshot(2) AS s`);
    expect(snapshot.s.permissions).toEqual(['orders.view', 'orders.update']);
  });

  it('a group scope pair outside the allowed values is refused by the database', async () => {
    await expect(q(`INSERT INTO access_group_scopes VALUES (1, 'payments.view', 'assigned')`)).rejects.toMatchObject({ code: '23503' });
    await expect(q(`INSERT INTO access_group_scopes VALUES (1, 'orders.view', 'none')`)).rejects.toMatchObject({ code: '23503' });
  });
});
