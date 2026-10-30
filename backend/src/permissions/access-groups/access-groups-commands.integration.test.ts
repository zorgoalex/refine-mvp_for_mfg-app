import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../current-user';
import { assertAdministrationRemains } from '../authorization-command-guard';
import { PermissionsService } from '../permissions.service';
import { PgAccessGroupsRepository, type AccessGroupsCommandContext } from './pg-access-groups.repository';

/**
 * Access groups stage 2 (plan R7 §4.2–4.4) against PostgreSQL: the command protocol (lock, idempotency, CAS, narrowing,
 * lockout, global version, audit, outbox) and the effective rights through migration 285. Needs a scratch database
 * with the full ERP schema and the reference rows of roles/permissions (TEST_AUTHZ_DATABASE_URL); creates its own
 * users and groups and removes them, restores permissions_state.
 */
const databaseUrl = process.env.TEST_AUTHZ_DATABASE_URL;
const PREFIX = 'E2E-authz-groups';
const SUPERADMIN_ROLE = 2;
const VIEWER_ROLE = 100;

describe.skipIf(!databaseUrl)('access groups commands (PostgreSQL)', { timeout: 60_000 }, () => {
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
  const groups = new PgAccessGroupsRepository(database, permissions);

  let adminId: number;
  let viewerId: number;
  let stateBefore: { hasura_access_predicates: boolean; hasura_financials_state: string; access_groups_enabled: boolean };
  let keySeq = 0;

  const insertUser = async (suffix: string, roleId: number) => Number((await pool.query<{ user_id: string }>(
    `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'x', $3) RETURNING user_id`,
    [`${PREFIX}-${suffix}`, `${PREFIX}-${suffix}@example.invalid`.toLowerCase(), roleId],
  )).rows[0].user_id);
  const ctx = (id = adminId, key = `it-groups-${Date.now()}-${(keySeq += 1)}`): AccessGroupsCommandContext => ({
    currentUser: { id: String(id), username: `${PREFIX}-${id}`, role: 'superadmin', roleId: SUPERADMIN_ROLE,
      permissions: ['system.superadmin', 'permissions.manage', 'roles.manage'] } as CurrentUser,
    requestId: `it-${key}`,
    idempotencyKey: key,
  });
  const version = async () => Number((await pool.query('SELECT version FROM permissions_state WHERE id = true')).rows[0].version);
  const effective = async (userId: number) => (await pool.query<{ permission_name: string }>(
    'SELECT permission_name FROM user_effective_permissions WHERE user_id = $1 ORDER BY 1', [userId])).rows.map((row) => row.permission_name);
  const snapshotPermissions = async (userId: number) => (await pool.query<{ s: { permissions: string[] } }>(
    'SELECT user_authorization_snapshot($1) AS s', [userId])).rows[0].s.permissions;
  const fail = (promise: Promise<unknown>) => promise.then(
    () => 'done',
    (error: { statusCode?: number; code?: string }) => `${error.statusCode} ${error.code}`,
  );
  const setState = (values: Partial<typeof stateBefore>) => pool.query(
    `UPDATE permissions_state SET hasura_access_predicates = coalesce($1, hasura_access_predicates),
       hasura_financials_state = coalesce($2, hasura_financials_state), access_groups_enabled = coalesce($3, access_groups_enabled) WHERE id = true`,
    [values.hasura_access_predicates ?? null, values.hasura_financials_state ?? null, values.access_groups_enabled ?? null],
  );
  const outboxSince = async (versionAfter: number) => (await pool.query<{ payload_json: { affectedUserIds: number[]; command: string } }>(
    `SELECT payload_json FROM outbox_events WHERE event_type = 'authorization.changed' AND idempotency_key = $1`,
    [`authorization.changed:permissions-v${versionAfter}`])).rows;
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
  const releaseHolder = async (holder: PoolClient, pending: Array<Promise<unknown> | undefined> = []) => {
    let broken = false;
    await holder.query('ROLLBACK').catch(() => { broken = true; });
    holder.release(broken);
    await Promise.all(pending.map((promise) => promise?.catch(() => undefined)));
  };
  const enable = async (enabled: boolean) => groups.updateSettings(ctx(), { enabled, version: await version() });

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6, statement_timeout: 30_000 });
    if (!(await pool.query(`SELECT to_regclass('public.access_groups') IS NOT NULL AS ok`)).rows[0].ok) {
      await pool.query((await readFile(new URL('../../../db/migrations/285_access_groups.sql', import.meta.url), 'utf8')));
    }
    stateBefore = (await pool.query('SELECT hasura_access_predicates, hasura_financials_state, access_groups_enabled FROM permissions_state WHERE id = true')).rows[0];
    await permissions.seedDefaults();
    adminId = await insertUser('admin', SUPERADMIN_ROLE);
    viewerId = await insertUser('viewer', VIEWER_ROLE);
  }, 60_000);

  beforeEach(async () => {
    await setState({ hasura_access_predicates: true, hasura_financials_state: 'closed', access_groups_enabled: false });
    await pool.query(`DELETE FROM access_groups WHERE code LIKE 'e2e_ag%'`);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM access_groups WHERE code LIKE 'e2e_ag%'`);
    if (stateBefore) await setState(stateBefore);
    const users = (await pool.query<{ user_id: string }>('SELECT user_id FROM users WHERE username LIKE $1', [`${PREFIX}%`])).rows.map((row) => row.user_id);
    await pool.query(`DELETE FROM command_idempotency_keys WHERE actor_user_id = ANY($1::bigint[])`, [users]);
    await pool.query(`DELETE FROM audit_log WHERE user_id = ANY($1::bigint[]) OR related_user_id = ANY($1::bigint[])`, [users]);
    await pool.query(`DELETE FROM outbox_events WHERE event_type = 'authorization.changed'
      AND (payload_json ->> 'actorUserId')::bigint = ANY($1::bigint[])`, [users]);
    await pool.query(`DELETE FROM users WHERE username LIKE $1`, [`${PREFIX}%`]);
    await pool?.end();
  });

  it('a group grants its rights only while the switch is on; creation and edits while off change no version', async () => {
    const v0 = await version();
    const group = await groups.create(ctx(), { code: 'e2e_ag_manager', name: 'E2E менеджеры' });
    const withRights = await groups.replacePermissions(ctx(), group.groupId, { version: group.version, permissions: ['orders.manager.change'], scopes: { 'orders.view': ['own', 'assigned'] } });
    expect(withRights.permissions).toContain('orders.manager.change');
    expect(withRights.permissions).toContain('orders.view'); // dependency of the catalog
    const members = await groups.replaceMembers(ctx(), group.groupId, { version: withRights.version, userIds: [viewerId] });
    expect(members.members.map((member) => member.userId)).toEqual([viewerId]);
    expect(await version()).toBe(v0);
    expect(await effective(viewerId)).not.toContain('orders.manager.change');

    const on = await enable(true);
    expect(on.enabled).toBe(true);
    expect(on.permissionsVersion).toBe(v0 + 1);
    expect(await effective(viewerId)).toContain('orders.manager.change');
    expect(await snapshotPermissions(viewerId)).toContain('orders.manager.change');
    const sources = await groups.userAuthorization(viewerId);
    expect(sources.permissions.find((row) => row.permission === 'orders.manager.change')?.sources).toEqual(['group:e2e_ag_manager']);
    expect(sources.scopes.filter((row) => row.scopeKey === 'orders.view').map((row) => row.scopeValue)).toEqual(expect.arrayContaining(['own', 'assigned']));
    const events = await outboxSince(v0 + 1);
    expect(events).toHaveLength(1);
    expect(events[0].payload_json.affectedUserIds).toEqual([viewerId]);

    // Deactivating the group takes the right away: one version, one event, an audit row per change.
    const current = await groups.get(group.groupId);
    await groups.update(ctx(), group.groupId, { version: current.version, isActive: false });
    expect(await version()).toBe(v0 + 2);
    expect(await effective(viewerId)).not.toContain('orders.manager.change');
    const audits = await pool.query<{ event: string }>(`SELECT event FROM audit_log WHERE entity_type = 'access_group' AND entity_id = $1 ORDER BY created_at, audit_id`, [String(group.groupId)]);
    expect(audits.rows.map((row) => row.event)).toEqual(['access_groups.create', 'access_groups.permissions.update', 'access_groups.member.add', 'access_groups.deactivate']);
  });

  it('enabling needs B applied and F2 closed', async () => {
    await setState({ hasura_financials_state: 'open' });
    expect(await fail(enable(true))).toBe('409 ACCESS_GROUPS_HASURA_NOT_CLOSED');
    await setState({ hasura_financials_state: 'closed', hasura_access_predicates: false });
    expect(await fail(enable(true))).toBe('409 ACCESS_GROUPS_HASURA_NOT_CLOSED');
    await setState({ hasura_access_predicates: true, hasura_financials_state: 'reverting' });
    expect(await fail(enable(true))).toBe('409 AUTHORIZATION_CHANGES_PAUSED');
  });

  it('a repeat with the same key replays the stored answer; the same key with another body is refused', async () => {
    const context = ctx();
    const first = await groups.create(context, { code: 'e2e_ag_replay', name: 'E2E replay' });
    const again = await groups.create(context, { code: 'e2e_ag_replay', name: 'E2E replay' });
    expect(again).toEqual(first);
    expect(await fail(groups.create(context, { code: 'e2e_ag_replay', name: 'E2E другое' }))).toBe('409 IDEMPOTENCY_KEY_REUSED');
    expect(await fail(groups.create(ctx(), { code: 'e2e_ag_replay', name: 'E2E replay' }))).toBe('409 ACCESS_GROUP_CODE_TAKEN');
    const rows = await pool.query(`SELECT 1 FROM audit_log WHERE event = 'access_groups.create' AND entity_id = $1`, [String(first.groupId)]);
    expect(rows.rowCount).toBe(1);
  });

  it('a stale group version or user row_version gives 409; both forms of membership bump both versions', async () => {
    const group = await groups.create(ctx(), { code: 'e2e_ag_versions', name: 'E2E versions' });
    const user = await groups.userAuthorization(viewerId);
    const viaUser = await groups.replaceUserGroups(ctx(), viewerId, { rowVersion: user.rowVersion, groupIds: [group.groupId] });
    expect(viaUser.groups.map((row) => row.groupId)).toEqual([group.groupId]);
    // The group form with the version read before the user form is stale now.
    expect(await fail(groups.replaceMembers(ctx(), group.groupId, { version: group.version, userIds: [] }))).toBe('409 ACCESS_GROUP_VERSION_CONFLICT');
    const fresh = await groups.get(group.groupId);
    await groups.replaceMembers(ctx(), group.groupId, { version: fresh.version, userIds: [] });
    expect(await fail(groups.replaceUserGroups(ctx(), viewerId, { rowVersion: viaUser.rowVersion, groupIds: [] }))).toBe('409 USER_VERSION_CONFLICT');
  });

  it('narrowing is refused while Hasura does not follow the effective permissions (B off)', async () => {
    const group = await groups.create(ctx(), { code: 'e2e_ag_narrow', name: 'E2E narrow' });
    const g1 = await groups.replacePermissions(ctx(), group.groupId, { version: group.version, permissions: ['orders.manager.change'], scopes: {} });
    const g2 = await groups.replaceMembers(ctx(), group.groupId, { version: g1.version, userIds: [viewerId] });
    await enable(true);
    await setState({ hasura_access_predicates: false });
    const v = await version();
    expect(await fail(groups.replaceMembers(ctx(), group.groupId, { version: g2.version, userIds: [] }))).toBe('422 PERMISSION_NARROWING_BLOCKED');
    expect(await version()).toBe(v);
    expect(await effective(viewerId)).toContain('orders.manager.change');
    // Widening is still allowed.
    await groups.replacePermissions(ctx(), group.groupId, { version: g2.version, permissions: ['orders.manager.change', 'clients.view'], scopes: {} });
    expect(await effective(viewerId)).toContain('clients.view');
  });

  it('while groups are on, an administrator through a group does not replace the administrator by role', async () => {
    // Other administrators by role are deactivated for the test: this test's admin is the only one.
    const others = (await pool.query<{ user_id: string }>(
      `UPDATE users u SET is_active = false WHERE u.is_active AND u.user_id <> $1 AND EXISTS (
         SELECT 1 FROM role_permissions rp WHERE rp.role_id = u.role_id AND rp.is_enabled AND rp.permission_name = 'permissions.manage')
       RETURNING u.user_id`, [adminId])).rows.map((row) => row.user_id);
    try {
      const group = await groups.create(ctx(), { code: 'e2e_ag_admins', name: 'E2E admins' });
      expect(await fail(groups.replacePermissions(ctx(), group.groupId, {
        version: group.version, permissions: ['system.superadmin', 'permissions.manage', 'roles.manage'], scopes: {} }))).toBe('422 DANGEROUS_PERMISSION_CONFIRMATION_REQUIRED');
      const g1 = await groups.replacePermissions(ctx(), group.groupId, {
        version: group.version, permissions: ['system.superadmin', 'permissions.manage', 'roles.manage'], scopes: {}, confirmDangerous: true });
      const g2 = await groups.replaceMembers(ctx(), group.groupId, { version: g1.version, userIds: [viewerId] });
      await enable(true);
      expect(await effective(viewerId)).toContain('permissions.manage');

      // Without the role administrator the effective rule alone would pass (the viewer administers through the
      // group), the role rule refuses: flag-off rollback must always keep an administrator.
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        await tx.query('UPDATE users SET is_active = false WHERE user_id = $1', [adminId]);
        expect(await fail(assertAdministrationRemains(tx as never))).toBe('409 PERMISSIONS_LOCKOUT_DENIED');
      } finally {
        await tx.query('ROLLBACK');
        tx.release();
      }

      // With the role administrator in place, the group administrator may be removed and the switch turned off.
      await groups.replaceMembers(ctx(), group.groupId, { version: g2.version, userIds: [] });
      expect(await effective(viewerId)).not.toContain('permissions.manage');
      await enable(false);
    } finally {
      await pool.query('UPDATE users SET is_active = true WHERE user_id = ANY($1::bigint[])', [others]);
    }
  });

  it('audit rows carry actor, request, source, related user and versions, with secrets redacted inside strings', async () => {
    const context = ctx();
    const group = await groups.create(context, { code: 'e2e_ag_audit', name: 'E2E audit', description: 'password=example-value и Bearer abc.def.ghi' });
    const created = (await pool.query<{ user_id: string; request_id: string; source: string; after_json: { description: string }; diff_json: unknown; metadata_json: Record<string, unknown> }>(
      `SELECT user_id, request_id, source, after_json, diff_json, metadata_json FROM audit_log WHERE event = 'access_groups.create' AND entity_id = $1`,
      [String(group.groupId)])).rows[0];
    expect(Number(created.user_id)).toBe(adminId);
    expect(created.request_id).toBe(context.requestId);
    expect(created.source).toBe('access_groups_api');
    expect(created.after_json.description).not.toContain('example-value');
    expect(created.after_json.description).not.toContain('abc.def.ghi');
    expect(JSON.stringify(created.diff_json)).not.toContain('example-value');
    expect(created.metadata_json).toMatchObject({ idempotencyKey: context.idempotencyKey, permissionsVersionBefore: expect.any(Number) });

    await enable(true);
    const g1 = await groups.replacePermissions(ctx(), group.groupId, { version: group.version, permissions: ['orders.manager.change'], scopes: {} });
    const v = await version();
    await groups.replaceMembers(ctx(), group.groupId, { version: g1.version, userIds: [viewerId] });
    const added = (await pool.query<{ related_user_id: string; metadata_json: { permissionsVersionBefore: number; permissionsVersionAfter: number } }>(
      `SELECT related_user_id, metadata_json FROM audit_log WHERE event = 'access_groups.member.add' AND entity_id = $1`, [String(group.groupId)])).rows[0];
    expect(Number(added.related_user_id)).toBe(viewerId);
    expect(added.metadata_json).toMatchObject({ permissionsVersionBefore: v, permissionsVersionAfter: v + 1 });
    const event = (await pool.query<{ aggregate_type: string; aggregate_id: string; payload_json: Record<string, unknown> }>(
      `SELECT aggregate_type, aggregate_id, payload_json FROM outbox_events WHERE idempotency_key = $1`, [`authorization.changed:permissions-v${v + 1}`])).rows[0];
    expect(event).toMatchObject({ aggregate_type: 'access_group', aggregate_id: String(group.groupId) });
    expect(event.payload_json).toMatchObject({ command: 'access_groups.members.update', entityId: String(group.groupId), affectedUserIds: [viewerId] });

    const user = await groups.userAuthorization(viewerId);
    await groups.replaceUserGroups(ctx(), viewerId, { rowVersion: user.rowVersion, groupIds: [] });
    const viaUser = (await pool.query<{ source: string; related_user_id: string }>(
      `SELECT source, related_user_id FROM audit_log WHERE event = 'users.access_groups.update' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1`, [String(viewerId)])).rows[0];
    expect(viaUser).toMatchObject({ source: 'users_api', related_user_id: String(viewerId) });
  });

  it('a failed audit write rolls back the change, the version, the event and the idempotency key', async () => {
    const group = await groups.create(ctx(), { code: 'e2e_ag_auditfail', name: 'E2E audit fail' });
    const g1 = await groups.replacePermissions(ctx(), group.groupId, { version: group.version, permissions: ['orders.manager.change'], scopes: {} });
    await enable(true);
    await pool.query(`CREATE OR REPLACE FUNCTION e2e_ag_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event = 'access_groups.member.add' AND NEW.entity_id = '${group.groupId}' THEN RAISE EXCEPTION 'e2e audit failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER e2e_ag_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION e2e_ag_audit_fail()');
    const context = ctx();
    const v = await version();
    try {
      await expect(groups.replaceMembers(context, group.groupId, { version: g1.version, userIds: [viewerId] })).rejects.toThrow(/e2e audit failure/);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS e2e_ag_audit_fail ON audit_log');
      await pool.query('DROP FUNCTION IF EXISTS e2e_ag_audit_fail()');
    }
    expect(await version()).toBe(v);
    expect((await groups.get(group.groupId)).members).toEqual([]);
    expect(await effective(viewerId)).not.toContain('orders.manager.change');
    expect((await outboxSince(v + 1)).length).toBe(0);
    expect((await pool.query('SELECT 1 FROM command_idempotency_keys WHERE idempotency_key = $1', [`access-groups:${context.idempotencyKey}`])).rowCount).toBe(0);
    // The same key works afterwards: nothing of the failed attempt stayed.
    await groups.replaceMembers(context, group.groupId, { version: g1.version, userIds: [viewerId] });
    expect(await effective(viewerId)).toContain('orders.manager.change');
  });

  it('a group command that waited while its actor lost the group that made him an administrator is refused with 403', async () => {
    const actorId = await insertUser('group-actor', VIEWER_ROLE);
    const admins = await groups.create(ctx(), { code: 'e2e_ag_actor', name: 'E2E actor admins' });
    const a1 = await groups.replacePermissions(ctx(), admins.groupId, {
      version: admins.version, permissions: ['system.superadmin', 'permissions.manage', 'roles.manage'], scopes: {}, confirmDangerous: true });
    await groups.replaceMembers(ctx(), admins.groupId, { version: a1.version, userIds: [actorId] });
    await enable(true);
    const holder = await pool.connect();
    let pending: Promise<string> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT version FROM permissions_state WHERE id = true FOR UPDATE');
      pending = fail(groups.create(ctx(actorId), { code: 'e2e_ag_by_actor', name: 'E2E by actor' }));
      expect(await waitingOnState()).toBe(true);
      await holder.query('DELETE FROM user_access_groups WHERE user_id = $1', [actorId]);
      await holder.query('COMMIT');
      expect(await pending).toBe('403 PERMISSION_DENIED');
    } finally {
      await releaseHolder(holder, [pending]);
    }
    expect((await pool.query(`SELECT 1 FROM access_groups WHERE code = 'e2e_ag_by_actor'`)).rowCount).toBe(0);
  });

  it('concurrent membership edits through the group and through the user: one wins, the other gets a stale-write 409', async () => {
    const group = await groups.create(ctx(), { code: 'e2e_ag_race', name: 'E2E race' });
    const user = await groups.userAuthorization(viewerId);
    const holder = await pool.connect();
    let both: Array<Promise<string>> = [];
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT version FROM permissions_state WHERE id = true FOR UPDATE');
      both = [
        fail(groups.replaceMembers(ctx(), group.groupId, { version: group.version, userIds: [viewerId] })),
        fail(groups.replaceUserGroups(ctx(), viewerId, { rowVersion: user.rowVersion, groupIds: [group.groupId] })),
      ];
      expect(await waitingOnState()).toBe(true);
      await holder.query('COMMIT');
      const outcomes = (await Promise.all(both)).sort();
      expect(outcomes[0]).toMatch(/^409 (ACCESS_GROUP_VERSION_CONFLICT|USER_VERSION_CONFLICT)$/);
      expect(outcomes[1]).toBe('done');
    } finally {
      await releaseHolder(holder, both);
    }
    expect((await groups.get(group.groupId)).members.map((member) => member.userId)).toEqual([viewerId]);
  });

  it('the roles matrix keeps a human administrator by role while groups are on (a service account does not count)', async () => {
    const ADMIN_ROLE = 1;
    const ADMIN_RIGHTS = ['system.superadmin', 'permissions.manage', 'roles.manage'];
    const saved = (await pool.query<{ permission_name: string; is_enabled: boolean }>(
      'SELECT permission_name, is_enabled FROM role_permissions WHERE role_id = $1', [ADMIN_ROLE])).rows;
    const service = Number((await pool.query<{ user_id: string }>(
      `INSERT INTO users (username, email, password_hash, role_id, is_service_account) VALUES ($1, $2, 'x', $3, true) RETURNING user_id`,
      [`${PREFIX}-service`, `${PREFIX}-service@example.invalid`.toLowerCase(), SUPERADMIN_ROLE])).rows[0].user_id);
    const human = await insertUser('role-admin', ADMIN_ROLE);
    // Only `human` administers by role (others are deactivated for the test); he also is in an admin group.
    const others = (await pool.query<{ user_id: string }>(
      `UPDATE users SET is_active = false WHERE is_active AND NOT is_service_account AND user_id <> $1 AND username NOT LIKE $2
       RETURNING user_id`, [human, `${PREFIX}-viewer`])).rows.map((row) => row.user_id);
    try {
      await pool.query(`INSERT INTO role_permissions (role_id, permission_name, is_enabled) SELECT $1, unnest($2::text[]), true
        ON CONFLICT (role_id, permission_name) DO UPDATE SET is_enabled = true`, [ADMIN_ROLE, ADMIN_RIGHTS]);
      await pool.query('UPDATE users SET is_active = true WHERE user_id = $1', [adminId]);
      const group = await groups.create(ctx(), { code: 'e2e_ag_matrix_admins', name: 'E2E matrix admins' });
      const g1 = await groups.replacePermissions(ctx(), group.groupId, { version: group.version, permissions: ADMIN_RIGHTS, scopes: {}, confirmDangerous: true });
      await groups.replaceMembers(ctx(), group.groupId, { version: g1.version, userIds: [human] });
      await enable(true);
      await pool.query('UPDATE users SET is_active = false WHERE user_id = $1', [adminId]);

      const matrix = await permissions.getRolesMatrix();
      const actor: CurrentUser = { id: String(human), username: `${PREFIX}-role-admin`, role: 'admin', roleId: ADMIN_ROLE, permissions: ADMIN_RIGHTS } as CurrentUser;
      const request = {
        version: matrix.version,
        rolePermissions: { [String(ADMIN_ROLE)]: { ...matrix.rolePermissions[String(ADMIN_ROLE)], 'permissions.manage': false } },
        roleScopes: {},
        confirmDangerous: true,
      };
      // The service account (superadmin role) satisfies the old matrix rule; the shared rule refuses.
      expect(await fail(permissions.updateRolesMatrix(actor, request, 'it-matrix-lockout'))).toBe('409 PERMISSIONS_LOCKOUT_DENIED');
      expect(await fail(permissions.resetRoleToDefaults(actor, ADMIN_ROLE, 'it-matrix-lockout-reset'))).toBe('409 PERMISSIONS_LOCKOUT_DENIED');
      expect(service).toBeGreaterThan(0);
    } finally {
      await pool.query('UPDATE users SET is_active = true WHERE user_id = ANY($1::bigint[])', [[...others, adminId]]);
      await setState({ access_groups_enabled: false });
      await pool.query('DELETE FROM role_permissions WHERE role_id = $1', [ADMIN_ROLE]);
      for (const row of saved) {
        await pool.query('INSERT INTO role_permissions (role_id, permission_name, is_enabled) VALUES ($1, $2, $3)', [ADMIN_ROLE, row.permission_name, row.is_enabled]);
      }
    }
  });

  it('the roles matrix with a key replays its answer; without one it works as before', async () => {
    const matrix = await permissions.getRolesMatrix();
    const actor = ctx().currentUser;
    const request = { version: matrix.version, rolePermissions: {}, roleScopes: {} };
    const first = await permissions.updateRolesMatrix(actor, request, 'it-matrix', `it-matrix-${Date.now()}`);
    const key = `it-matrix-key-${Date.now()}`;
    const keyed = await permissions.updateRolesMatrix(actor, { ...request, version: first.version }, 'it-matrix', key);
    const replay = await permissions.updateRolesMatrix(actor, { ...request, version: first.version }, 'it-matrix', key);
    expect(replay).toEqual(keyed);
    expect(await fail(permissions.updateRolesMatrix(actor, { ...request, version: keyed.version }, 'it-matrix', key))).toBe('409 IDEMPOTENCY_KEY_REUSED');
    await expect(permissions.updateRolesMatrix(actor, { ...request, version: keyed.version }, 'it-matrix')).resolves.toMatchObject({ version: keyed.version + 1 });
  });
});
