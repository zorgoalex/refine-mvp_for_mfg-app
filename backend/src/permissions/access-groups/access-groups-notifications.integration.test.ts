import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../database/database.service';
import { PgNotificationRuleRepository } from '../../modules/notifications-engine/adapters/pg-notification-rule-repository';
import { PgRecipientSourceAdapter } from '../../modules/notifications-engine/adapters/pg-recipient-source';
import { NotificationRulesService } from '../../modules/notifications-engine/application/notification-rules.service';
import { PgProcurementNotificationsRepository } from '../../modules/orders/adapters/pg-procurement-notifications-repository';
import type { CurrentUser } from '../current-user';
import { PermissionsService } from '../permissions.service';
import { PgAccessGroupsRepository, type AccessGroupsCommandContext } from './pg-access-groups.repository';

/**
 * Access groups stage 4 (plan v6 §5): `groupCodes` in notification rules, in BOTH resolvers — the engine
 * (PgRecipientSourceAdapter) and the procurement service rules (PgProcurementNotificationsRepository). With the switch
 * off group members are not added; a rule with only groupCodes reaches nobody (never «everybody by default»). A group a
 * rule names cannot be deleted; a rule cannot name a missing group. Scratch DB (TEST_AUTHZ_DATABASE_URL).
 */
const databaseUrl = process.env.TEST_AUTHZ_DATABASE_URL;
const PREFIX = 'E2E-authz-groups-notify';
const SUPERADMIN_ROLE = 2;
const VIEWER_ROLE = 100;
const RULE_PREFIX = 'e2e-ag-notify';

describe.skipIf(!databaseUrl)('access groups in notification rules (PostgreSQL)', { timeout: 60_000 }, () => {
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
  const engineSource = new PgRecipientSourceAdapter();
  const procurement = new PgProcurementNotificationsRepository(database);
  const rules = new NotificationRulesService({ repository: new PgNotificationRuleRepository(), database: database as never, permissions });

  let adminId: number;
  let memberId: number;
  let outsiderId: number;
  let keySeq = 0;
  let stateBefore: { access_groups_enabled: boolean; hasura_access_predicates: boolean; hasura_financials_state: string };

  const insertUser = async (suffix: string, roleId: number) => Number((await pool.query<{ user_id: string }>(
    `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'x', $3) RETURNING user_id`,
    [`${PREFIX}-${suffix}`, `${PREFIX}-${suffix}@example.invalid`.toLowerCase(), roleId],
  )).rows[0].user_id);
  const ctx = (): AccessGroupsCommandContext => ({
    currentUser: { id: String(adminId), username: `${PREFIX}-admin`, role: 'superadmin', roleId: SUPERADMIN_ROLE,
      permissions: ['system.superadmin', 'permissions.manage', 'notifications.manage_rules'] } as CurrentUser,
    requestId: `it-notify-${(keySeq += 1)}`,
    idempotencyKey: `it-notify-${Date.now()}-${keySeq}`,
  });
  const setSwitch = (enabled: boolean) => pool.query('UPDATE permissions_state SET access_groups_enabled = $1 WHERE id = true', [enabled]);
  const insertRule = (code: string, eventType: string, recipients: unknown) => pool.query(
    `INSERT INTO notification_rules (rule_code, event_type, is_enabled, recipients_json) VALUES ($1, $2, true, $3::jsonb)`,
    [code, eventType, JSON.stringify(recipients)],
  );
  const fail = (promise: Promise<unknown>) => promise.then(
    () => 'done',
    (error: { statusCode?: number; code?: string; details?: { code?: string } }) =>
      `${error.statusCode} ${error.details?.code ?? error.code}`,
  );

  let groupId: number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6, statement_timeout: 30_000 });
    if (!(await pool.query(`SELECT to_regclass('public.access_groups') IS NOT NULL AS ok`)).rows[0].ok) {
      await pool.query((await readFile(new URL('../../../db/migrations/285_access_groups.sql', import.meta.url), 'utf8')));
    }
    stateBefore = (await pool.query('SELECT access_groups_enabled, hasura_access_predicates, hasura_financials_state FROM permissions_state WHERE id = true')).rows[0];
    await removeLeftovers(pool, `${PREFIX}-%`, 'e2e_ag_notify%', `${RULE_PREFIX}%`);
    await pool.query(`UPDATE permissions_state SET hasura_access_predicates = true, hasura_financials_state = 'closed' WHERE id = true`);
    await permissions.seedDefaults();
    adminId = await insertUser('admin', SUPERADMIN_ROLE);
    memberId = await insertUser('member', VIEWER_ROLE);
    outsiderId = await insertUser('outsider', VIEWER_ROLE);
    // The group gives procurement rights (the procurement resolver also requires them) and has one member.
    const group = await groups.create(ctx(), { code: 'e2e_ag_notify', name: 'E2E notify' });
    const g1 = await groups.replacePermissions(ctx(), group.groupId, { version: group.version, permissions: ['procurement.view', 'procurement.manage'], scopes: {} });
    await groups.replaceMembers(ctx(), group.groupId, { version: g1.version, userIds: [memberId] });
    groupId = group.groupId;
  }, 60_000);

  beforeEach(async () => {
    await setSwitch(false);
    await pool.query('DELETE FROM notification_rules WHERE rule_code LIKE $1', [`${RULE_PREFIX}%`]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM notifications WHERE idempotency_key LIKE 'e2e-ag-notify:%'`);
    await pool.query(`DELETE FROM outbox_events WHERE idempotency_key LIKE 'e2e-ag-notify:%'`);
    await pool.query('DELETE FROM notification_rules WHERE rule_code LIKE $1', [`${RULE_PREFIX}%`]);
    await pool.query(`DELETE FROM access_groups WHERE code LIKE 'e2e_ag_notify%'`);
    if (stateBefore) {
      await pool.query(`UPDATE permissions_state SET access_groups_enabled = $1, hasura_access_predicates = $2, hasura_financials_state = $3 WHERE id = true`,
        [stateBefore.access_groups_enabled, stateBefore.hasura_access_predicates, stateBefore.hasura_financials_state]);
    }
    const users = (await pool.query<{ user_id: string }>('SELECT user_id FROM users WHERE username LIKE $1', [`${PREFIX}%`])).rows.map((row) => row.user_id);
    await pool.query('DELETE FROM command_idempotency_keys WHERE actor_user_id = ANY($1::bigint[])', [users]);
    await pool.query('DELETE FROM audit_log WHERE user_id = ANY($1::bigint[]) OR related_user_id = ANY($1::bigint[])', [users]);
    await pool.query(`DELETE FROM outbox_events WHERE event_type = 'authorization.changed' AND (payload_json ->> 'actorUserId')::bigint = ANY($1::bigint[])`, [users]);
    await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
    await pool?.end();
  });

  it('the engine resolver adds group members only while the switch is on', async () => {
    const client = await pool.connect();
    try {
      expect(await engineSource.resolveAccessGroupMembers(client, ['e2e_ag_notify'])).toEqual([]);
      await setSwitch(true);
      expect(await engineSource.resolveAccessGroupMembers(client, ['e2e_ag_notify'])).toEqual([memberId]);
      // inactive group or inactive user → nobody
      await pool.query('UPDATE access_groups SET is_active = false WHERE group_id = $1', [groupId]);
      expect(await engineSource.resolveAccessGroupMembers(client, ['e2e_ag_notify'])).toEqual([]);
      await pool.query('UPDATE access_groups SET is_active = true WHERE group_id = $1', [groupId]);
      await pool.query('UPDATE users SET is_active = false WHERE user_id = $1', [memberId]);
      expect(await engineSource.resolveAccessGroupMembers(client, ['e2e_ag_notify'])).toEqual([]);
    } finally {
      await pool.query('UPDATE users SET is_active = true WHERE user_id = $1', [memberId]);
      client.release();
    }
  });

  it('a procurement rule with only groupCodes reaches nobody while off (not «everybody with the right»), the members while on', async () => {
    await insertRule(`${RULE_PREFIX}-proc`, 'procurement.receipt_unallocated', { groupCodes: ['e2e_ag_notify'] });
    const rule = await procurement.loadRule(`${RULE_PREFIX}-proc`);
    expect(rule.groupCodes).toEqual(['e2e_ag_notify']);
    expect(await procurement.ruleRecipients(rule, 'procurement.manage', ['procurement.view'])).toEqual([]);
    await setSwitch(true);
    const ids = (await procurement.ruleRecipients(rule, 'procurement.manage', ['procurement.view'])).map((user) => Number(user.id));
    expect(ids).toEqual([memberId]);
    expect(ids).not.toContain(outsiderId);
  });

  it('a rule cannot name a missing group; a named group cannot be deleted', async () => {
    const actor = ctx().currentUser;
    expect(await fail(rules.create(actor, 'it-rule-missing', {
      ruleCode: `${RULE_PREFIX}-missing`, eventType: 'order.status_changed', level: 'info', priority: 100, isEnabled: true,
      conditions: {}, recipients: { groupCodes: ['e2e_ag_notify_absent'] },
    } as never))).toBe('422 UNKNOWN_GROUP_CODE');
    expect(await fail(rules.create(actor, 'it-rule-bad', {
      ruleCode: `${RULE_PREFIX}-bad`, eventType: 'order.status_changed', level: 'info', priority: 100, isEnabled: true,
      conditions: {}, recipients: { groupCodes: ['Not A Code'] },
    } as never))).toBe('422 INVALID_GROUP_CODE');
    const created = await rules.create(actor, 'it-rule-ok', {
      ruleCode: `${RULE_PREFIX}-ok`, eventType: 'order.status_changed', level: 'info', priority: 100, isEnabled: true,
      conditions: {}, recipients: { groupCodes: ['e2e_ag_notify'] },
    } as never);
    expect(created.recipients.groupCodes).toEqual(['e2e_ag_notify']);

    // An empty, inactive group named by the rule still cannot be deleted.
    const spare = await groups.create(ctx(), { code: 'e2e_ag_notify_spare', name: 'E2E spare' });
    const inactive = await groups.update(ctx(), spare.groupId, { version: spare.version, isActive: false });
    await rules.update(actor, 'it-rule-ok-2', created.notificationRuleId, { patch: { recipients: { groupCodes: ['e2e_ag_notify', 'e2e_ag_notify_spare'] } } } as never);
    expect(await fail(groups.remove(ctx(), spare.groupId, { version: inactive.version }))).toBe('409 ACCESS_GROUP_IN_USE');
    await rules.update(actor, 'it-rule-ok-3', created.notificationRuleId, { patch: { recipients: { groupCodes: ['e2e_ag_notify'] } } } as never);
    await expect(groups.remove(ctx(), spare.groupId, { version: inactive.version })).resolves.toMatchObject({ deleted: true });
  });

  it('R1: a client that does not send groupCodes (older page) keeps the rule\'s groups; an explicit [] removes them', async () => {
    const actor = ctx().currentUser;
    await insertRule(`${RULE_PREFIX}-keep`, 'procurement.receipt_unallocated', { groupCodes: ['e2e_ag_notify'] });
    const id = (await pool.query<{ notification_rule_id: string }>('SELECT notification_rule_id FROM notification_rules WHERE rule_code = $1', [`${RULE_PREFIX}-keep`])).rows[0].notification_rule_id;
    // the previous frontend: service rules always sent `recipients: {}` (no groupCodes key)
    await rules.update(actor, 'it-old-client', id, { patch: { priority: 50, recipients: {} } } as never);
    expect((await procurement.loadRule(`${RULE_PREFIX}-keep`)).groupCodes).toEqual(['e2e_ag_notify']);
    await rules.update(actor, 'it-new-client', id, { patch: { recipients: { groupCodes: [] } } } as never);
    expect((await procurement.loadRule(`${RULE_PREFIX}-keep`)).groupCodes).toEqual([]);
  });

  it('R1: the write re-checks the recipient — removed from the group or the switch turned off after selection → no notification', async () => {
    await insertRule(`${RULE_PREFIX}-write`, 'procurement.receipt_unallocated', { groupCodes: ['e2e_ag_notify'] });
    await setSwitch(true);
    const rule = await procurement.loadRule(`${RULE_PREFIX}-write`);
    const [user] = await procurement.ruleRecipients(rule, 'procurement.manage', ['procurement.view']);
    expect(Number(user.id)).toBe(memberId);
    const guard = { ruleCode: rule.ruleCode, recipientsHash: rule.recipientsHash, eligibility: { defaultPermission: 'procurement.manage', required: ['procurement.view'] } };
    const write = (suffix: string) => procurement.writeServiceNotification({
      eventType: 'procurement.receipt_unallocated', aggregateType: 'user', aggregateId: String(memberId), key: `e2e-ag-notify:${suffix}`,
      userId: memberId, title: 'E2E', message: 'E2E', entityType: 'procurement_receipts', entityId: null,
    }, guard);
    // the switch turned off between the selection and the write
    await setSwitch(false);
    expect(await write('off')).toBe(false);
    await setSwitch(true);
    expect(await write('on')).toBe(true);
    // removed from the group (same rule, same hash) between the selection and the write
    const group = await groups.get(groupId);
    await groups.replaceMembers(ctx(), groupId, { version: group.version, userIds: [] });
    expect(await write('removed')).toBe(false);
    const after = await groups.get(groupId);
    await groups.replaceMembers(ctx(), groupId, { version: after.version, userIds: [memberId] });
    expect((await pool.query(`SELECT idempotency_key FROM notifications WHERE idempotency_key LIKE 'e2e-ag-notify:%' ORDER BY 1`)).rows.map((row) => row.idempotency_key))
      .toEqual(['e2e-ag-notify:on:in_app']);
  });

  it('R1: rule transactions lock the named groups by group_id (the order of every access-group command)', async () => {
    const source = await readFile(new URL('../../modules/notifications-engine/application/notification-rules.service.ts', import.meta.url), 'utf8');
    expect(source).toContain("'SELECT code FROM access_groups WHERE code = ANY($1::text[]) ORDER BY group_id FOR KEY SHARE'");
  });

  it('R2: an update without expectedUpdatedAt that raced another update gets 409 (its prepared recipients are stale)', async () => {
    const actor = ctx().currentUser;
    await insertRule(`${RULE_PREFIX}-race`, 'procurement.receipt_unallocated', {});
    const id = (await pool.query<{ notification_rule_id: string }>('SELECT notification_rule_id FROM notification_rules WHERE rule_code = $1', [`${RULE_PREFIX}-race`])).rows[0].notification_rule_id;
    const holder = await pool.connect();
    let pending: Promise<string> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM notification_rules WHERE notification_rule_id = $1 FOR UPDATE', [id]);
      // A reads the rule (no groups) and prepares `{}` — then waits for the row
      pending = fail(rules.update(actor, 'it-race-a', id, { patch: { recipients: {} } } as never));
      for (let i = 0; i < 100; i += 1) {
        const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%notification_rules%' AND query NOT LIKE '%pg_stat_activity%'`);
        if (waiting.rowCount) break;
        await new Promise((done) => setTimeout(done, 50));
      }
      // B restricts the rule to a group meanwhile
      await holder.query(`UPDATE notification_rules SET recipients_json = '{"groupCodes":["e2e_ag_notify"]}'::jsonb,
        updated_at = updated_at + interval '5 milliseconds' WHERE notification_rule_id = $1`, [id]);
      await holder.query('COMMIT');
      expect(await pending).toBe('409 NOTIFICATION_RULE_STALE');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      await pending?.catch(() => undefined);
    }
    expect((await procurement.loadRule(`${RULE_PREFIX}-race`)).groupCodes).toEqual(['e2e_ag_notify']);
  });

  it('R2: an authorization change after the run captured its version (e.g. a narrowed scope) skips the write', async () => {
    await insertRule(`${RULE_PREFIX}-ver`, 'procurement.receipt_unallocated', { groupCodes: ['e2e_ag_notify'] });
    await setSwitch(true);
    const rule = await procurement.loadRule(`${RULE_PREFIX}-ver`);
    const authorizationVersion = await procurement.authorizationVersion();
    const guard = { ruleCode: rule.ruleCode, recipientsHash: rule.recipientsHash,
      eligibility: { defaultPermission: 'procurement.manage', required: ['procurement.view'], authorizationVersion } };
    await pool.query('UPDATE permissions_state SET version = version + 1 WHERE id = true');
    expect(await procurement.writeServiceNotification({
      eventType: 'procurement.receipt_unallocated', aggregateType: 'user', aggregateId: String(memberId), key: 'e2e-ag-notify:version',
      userId: memberId, title: 'E2E', message: 'E2E', entityType: 'procurement_receipts', entityId: null,
    }, guard)).toBe(false);
    expect(await procurement.writeServiceNotification({
      eventType: 'procurement.receipt_unallocated', aggregateType: 'user', aggregateId: String(memberId), key: 'e2e-ag-notify:version2',
      userId: memberId, title: 'E2E', message: 'E2E', entityType: 'procurement_receipts', entityId: null,
    }, { ...guard, eligibility: { ...guard.eligibility, authorizationVersion: await procurement.authorizationVersion() } })).toBe(true);
  });

  it('R3: the engine protocol — under the share lock, membership and grants stay one state until the event commits', async () => {
    await setSwitch(true);
    const engineTx = await pool.connect();
    let change: Promise<string> | undefined;
    try {
      await engineTx.query('BEGIN');
      await engineTx.query('SELECT version FROM permissions_state WHERE id = true FOR SHARE');
      expect(await engineSource.resolveAccessGroupMembers(engineTx, ['e2e_ag_notify'])).toEqual([memberId]);
      // a membership change (G → none) arrives while the event is being processed: it waits for the event
      const user = await groups.userAuthorization(memberId);
      change = fail(groups.replaceUserGroups(ctx(), memberId, { rowVersion: user.rowVersion, groupIds: [] }));
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        waiting = ((await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%permissions_state%' AND query NOT LIKE '%pg_stat_activity%'`)).rowCount ?? 0) > 0;
        if (!waiting) await new Promise((done) => setTimeout(done, 50));
      }
      expect(waiting).toBe(true);
      // the visibility read of the same event still sees the group's grants (same state as the membership)
      const grants = await engineTx.query(`SELECT 1 FROM user_effective_permissions WHERE user_id = $1 AND permission_name = 'procurement.view'`, [memberId]);
      expect(grants.rowCount).toBe(1);
      await engineTx.query('COMMIT');
      expect(await change).toBe('done');
    } finally {
      await engineTx.query('ROLLBACK').catch(() => undefined);
      engineTx.release();
      await change?.catch(() => undefined);
    }
    // after the change: neither the membership nor the grants
    const client = await pool.connect();
    try {
      expect(await engineSource.resolveAccessGroupMembers(client, ['e2e_ag_notify'])).toEqual([]);
    } finally {
      client.release();
    }
    const group = await groups.get(groupId);
    await groups.replaceMembers(ctx(), groupId, { version: group.version, userIds: [memberId] });
  });
});

/**
 * Fixtures left by a run that was killed before its afterAll (guard abort): removed before this run starts, the same
 * rows the teardown removes. Runs after the schema check and after the original state was captured; does not touch
 * shared state (the switch) — each test sets what it needs and afterAll restores the captured state.
 */
async function removeLeftovers(pool: Pool, usernamePattern: string, groupPattern: string, rulePattern?: string): Promise<void> {
  const users = (await pool.query<{ user_id: string }>('SELECT user_id FROM users WHERE username LIKE $1', [usernamePattern])).rows.map((row) => row.user_id);
  if (rulePattern) await pool.query('DELETE FROM notification_rules WHERE rule_code LIKE $1', [rulePattern]);
  await pool.query(`DELETE FROM notifications WHERE idempotency_key LIKE 'e2e-ag-notify:%'`);
  await pool.query(`DELETE FROM outbox_events WHERE idempotency_key LIKE 'e2e-ag-notify:%'`);
  await pool.query(`DELETE FROM outbox_events WHERE event_type = 'authorization.changed'
    AND (payload_json ->> 'actorUserId')::bigint = ANY($1::bigint[])`, [users]);
  await pool.query('DELETE FROM access_groups WHERE code LIKE $1', [groupPattern]);
  await pool.query('DELETE FROM command_idempotency_keys WHERE actor_user_id = ANY($1::bigint[])', [users]);
  await pool.query('DELETE FROM audit_log WHERE user_id = ANY($1::bigint[]) OR related_user_id = ANY($1::bigint[])', [users]);
  await pool.query('DELETE FROM users WHERE user_id = ANY($1::bigint[])', [users]);
}
