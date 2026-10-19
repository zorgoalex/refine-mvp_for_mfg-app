import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { PerformanceQueryTelemetryService } from '../../performance/performance-query-telemetry.service';
import type { CurrentUser } from '../../permissions/current-user';
import { PgOnecAlertNotificationsRepository } from './adapters/pg-onec-alert-notifications-repository';
import { PgOnecRepository } from './adapters/pg-onec-repository';
import { OnecAlertNotificationSettingsService } from './application/onec-alert-notification-settings.service';
import { OnecAlertNotifier } from './application/onec-alert-notifier';
import { OnecAuditWriter } from './application/onec-audit';
import { NO_RECIPIENTS_ALERT_KIND } from './domain/onec-alert-groups';
import type { OnecRuntimeConfigService } from './onec-runtime-config.service';

const suite = process.env.ONEC_AGENT_DOCKER_TEST === 'true' ? describe : describe.skip;

/*
 * Dispatcher of 1C alert notifications (plan 2026-10-19 §2.4–2.6, §2.10) on an isolated schema of the stage
 * PostgreSQL: the bell table, users/roles/effective permissions are local stand-ins, nothing touches public.
 */
suite('1C alert notifications — isolated PostgreSQL', () => {
  const schema = `e2e_onec_notify_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let db: DatabaseService;
  let repo: PgOnecRepository;
  let notifications: PgOnecAlertNotificationsRepository;
  let notifier: OnecAlertNotifier;
  let settings: OnecAlertNotificationSettingsService;
  let audit: OnecAuditWriter;
  const flags = { alertNotifications: false };
  const runtime = { get: () => ({ ...flags, monitorOwner: 'in_process' }) } as unknown as OnecRuntimeConfigService;
  const manager: CurrentUser = { id: '10', username: 'E2E-Тест-менеджер', role: 'admin', roleId: 1, permissions: ['onec.view', 'onec.manage'] };
  const ctx = { requestId: 'e2e-request', correlationId: 'e2e-correlation' };

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
  const grant = (userId: number, ...permissions: string[]) =>
    pool.query(`INSERT INTO user_effective_permissions SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [userId, permissions]);
  const raise = (kind: string, dedupeKey: string, severity: 'warning' | 'critical' = 'critical') =>
    repo.transaction((tx) => repo.upsertAlert(tx, { kind, agentId: null, sourceId: null, certId: null, severity, dedupeKey, details: {} }));
  const resolve = (dedupeKey: string) => repo.transaction((tx) => repo.resolveAlertByDedupeKey(tx, dedupeKey));
  const sent = (result: Awaited<ReturnType<OnecAlertNotifier['tick']>>) => result.dispatches.filter((d) => d.kind === 'sent');

  beforeAll(async () => {
    const [container] = JSON.parse(execFileSync('docker', ['inspect', 'erp_test-postgresdb-1'], { encoding: 'utf8' }));
    const env = Object.fromEntries(container.Config.Env.map((entry: string) => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
    const network = Object.values(container.NetworkSettings.Networks)[0] as { IPAddress: string };
    const url = new URL(`postgresql://${network.IPAddress}:5432/${env.POSTGRES_DB ?? 'erpdb'}`);
    url.username = env.POSTGRES_USER;
    url.password = env.POSTGRES_PASSWORD;
    url.searchParams.set('options', `-c search_path=${schema},pg_catalog -c jit=off -c lock_timeout=5000`);
    pool = new Pool({ connectionString: url.toString(), max: 4, statement_timeout: 10000 });
    await pool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE roles(role_id bigint PRIMARY KEY, role_code text, role_name text, is_active boolean NOT NULL DEFAULT true);
      INSERT INTO roles VALUES (1, 'admin', 'Администратор', true), (2, 'operator', 'Оператор', true), (3, 'old', 'Старая', false);
      CREATE TABLE users(user_id bigint PRIMARY KEY, username text, full_name text, role_id bigint, is_active boolean NOT NULL DEFAULT true,
        is_service_account boolean NOT NULL DEFAULT false);
      INSERT INTO users VALUES (1, 'E2E-Тест', NULL, 1, true, false);
      CREATE TABLE user_effective_permissions(user_id bigint, permission_name text, PRIMARY KEY (user_id, permission_name));
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY, domain text, label text, description text, sort_order integer, is_dangerous boolean, is_active boolean, updated_at timestamptz);
      CREATE TABLE role_permissions(role_id bigint, permission_name text, is_enabled boolean, PRIMARY KEY(role_id, permission_name));
      CREATE TABLE permissions_state(id boolean, version integer, updated_at timestamptz); INSERT INTO permissions_state VALUES (true, 1, now());
      CREATE TABLE notifications(notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id bigint, level text NOT NULL,
        title text NOT NULL, message text NOT NULL, entity_type text, entity_id text, source_type text NOT NULL, source_id text,
        is_read boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), idempotency_key text,
        balloon_mode text, balloon_shown_at timestamptz);
      CREATE UNIQUE INDEX ON notifications(idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE audit_log(LIKE public.audit_log INCLUDING ALL);
      CREATE TABLE audit_log_related_entity(LIKE public.audit_log_related_entity INCLUDING ALL);`);
    for (const file of ['193_onec_agent_foundation.sql', '196_onec_agent_commands.sql', '198_onec_etl.sql', '200_onec_etl_snapshots_revocation.sql',
      '247_onec_agent_expected_silence.sql', '250_onec_stock_snapshots.sql', '262_onec_alert_episodes.sql', '264_onec_alert_notifications.sql']) {
      await pool.query(readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 10000, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 4, DATABASE_SSL: false };
    db = new DatabaseService(
      { get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>,
      { measure: <T>(_sql: string, op: () => Promise<T>) => op() } as PerformanceQueryTelemetryService,
    );
    repo = new PgOnecRepository(db);
    notifications = new PgOnecAlertNotificationsRepository(db);
    audit = new OnecAuditWriter(repo);
    notifier = new OnecAlertNotifier(notifications, repo, audit, runtime);
    settings = new OnecAlertNotificationSettingsService(notifications, audit, runtime);
  }, 60000);

  afterAll(async () => {
    await db?.onModuleDestroy();
    if (pool) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    }
  });

  beforeEach(async () => {
    flags.alertNotifications = false;
    await pool.query(`TRUNCATE onec_alert_dispatch_recipients, onec_alert_dispatch_members, onec_alert_dispatches, onec_alerts,
        onec_alert_episodes, notifications, user_effective_permissions RESTART IDENTITY CASCADE;
      DELETE FROM users WHERE user_id <> 1;
      INSERT INTO users VALUES (10, 'manager', 'Менеджер 1С', 2, true, false), (11, 'viewer', NULL, 2, true, false),
        (12, 'boss', NULL, 1, true, false), (13, 'robot', NULL, 1, true, true), (14, 'gone', NULL, 2, false, false);
      UPDATE onec_alert_notification_policies SET recipient_role_codes = '{}', recipient_user_ids = '{}', importance = CASE
        WHEN group_code IN ('agent_offline', 'config_source') THEN 'critical' WHEN group_code IN ('sync', 'commands', 'stock_snapshots') THEN 'important'
        ELSE 'auto' END, notify_resolved = true, version = 1;
      UPDATE onec_alert_notification_state SET active = false, enabled_at = NULL, last_tick_at = NULL, last_tick_error = NULL;
      DELETE FROM audit_log_related_entity; DELETE FROM audit_log;`);
    // manager — onec.manage + onec.view; viewer — onec.view only; boss — superadmin; robot — service account; gone — inactive.
    await grant(10, 'onec.view', 'onec.manage');
    await grant(11, 'onec.view');
    await grant(12, 'onec.view', 'system.superadmin');
    await grant(13, 'onec.view', 'onec.manage');
    await grant(14, 'onec.view', 'onec.manage');
  });

  it('switching on is the cutoff: waiting episodes are not sent one by one, open ones get one digest per group', async () => {
    await raise('agent_silent', 'silent:a');
    await raise('etl_entity_failed', 'etl:1', 'warning');
    await raise('etl_entity_failed', 'etl:2', 'warning');
    await resolve('etl:2');
    expect((await notifier.tick()).active).toBe(false);
    expect(await q(`SELECT 1 FROM onec_alert_dispatches`)).toHaveLength(0);

    flags.alertNotifications = true;
    const result = await notifier.tick();
    expect(result.switchedOn).toBe(true);
    expect(sent(result)).toHaveLength(2);
    const dispatches = await q<{ group_code: string; stage: string; fallback_level: number }>(
      `SELECT group_code, stage, fallback_level FROM onec_alert_dispatches ORDER BY group_code`,
    );
    expect(dispatches).toEqual([
      { group_code: 'agent_offline', stage: 'digest', fallback_level: 2 },
      { group_code: 'sync', stage: 'digest', fallback_level: 2 },
    ]);
    // Fallback 2: active, non-service users with literal onec.manage AND onec.view — only the manager.
    const rows = await q<{ user_id: string; balloon_mode: string; source_type: string; entity_type: string; level: string }>(
      `SELECT user_id::text, balloon_mode, source_type, entity_type, level FROM notifications ORDER BY created_at`,
    );
    expect(rows.map((row) => row.user_id)).toEqual(['10', '10']);
    expect(rows.every((row) => row.balloon_mode === 'mandatory' && row.source_type === 'onec_alert' && row.entity_type === 'onec_alert_dispatch')).toBe(true);
    const statuses = await q<{ kind: string; status: string }>(`SELECT kind, status FROM onec_alert_episodes ORDER BY episode_id`);
    expect(statuses).toEqual([
      { kind: 'agent_silent', status: 'notified' },
      { kind: 'etl_entity_failed', status: 'notified' },
      { kind: 'etl_entity_failed', status: 'closed_unnotified' },
    ]);
    // Second tick: nothing new.
    expect(sent(await notifier.tick())).toHaveLength(0);
    const audits = await q<{ event: string; entity_type: string; actor_username: string }>(`SELECT event, entity_type, username AS actor_username FROM audit_log`);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ event: 'onec.alert_notification.dispatched', entity_type: 'onec_alert_dispatch', actor_username: 'onec-alert-notifier' });
    expect(await q(`SELECT 1 FROM audit_log_related_entity WHERE entity_type = 'onec_alert'`)).toHaveLength(2);
  });

  it('opens a new alert at once, announces its recovery, keys the bell row by dispatch and user', async () => {
    flags.alertNotifications = true;
    await notifier.tick();
    await raise('agent_silent', 'silent:b');
    const opened = sent(await notifier.tick());
    expect(opened).toHaveLength(1);
    const [dispatch] = opened as { dispatchId: number }[];
    const keys = await q<{ idempotency_key: string; title: string; message: string }>(`SELECT idempotency_key, title, message FROM notifications`);
    expect(keys[0].idempotency_key).toBe(`onec_alert:${dispatch.dispatchId}:10`);
    expect(keys[0].title).toBe('1С — Агент молчит');
    expect(await q(`SELECT channel FROM onec_alert_dispatch_recipients ORDER BY channel`)).toEqual([{ channel: 'balloon' }, { channel: 'in_app' }]);

    await resolve('silent:b');
    expect(sent(await notifier.tick())).toHaveLength(1);
    const stages = await q<{ stage: string }>(`SELECT stage FROM onec_alert_dispatches ORDER BY dispatch_id`);
    expect(stages.map((s) => s.stage)).toEqual(['opened', 'resolved']);
    const resolvedRow = await q<{ level: string; title: string }>(`SELECT level, title FROM notifications ORDER BY created_at DESC LIMIT 1`);
    expect(resolvedRow[0]).toEqual({ level: 'info', title: '1С — Восстановлено: Агент молчит' });
    expect(sent(await notifier.tick())).toHaveLength(0);
  });

  it('an alert opened and resolved between two ticks still gets both stages', async () => {
    flags.alertNotifications = true;
    await notifier.tick();
    await raise('agent_silent', 'silent:flap');
    await resolve('silent:flap');
    await notifier.tick();
    await notifier.tick();
    expect((await q<{ stage: string }>(`SELECT stage FROM onec_alert_dispatches ORDER BY dispatch_id`)).map((s) => s.stage)).toEqual(['opened', 'resolved']);
  });

  it('aggregates the openings of a group within its window into one dispatch', async () => {
    flags.alertNotifications = true;
    await notifier.tick();
    await raise('etl_entity_failed', 'etl:a', 'warning');
    await raise('etl_run_abandoned', 'etl:b', 'warning');
    expect(sent(await notifier.tick())).toHaveLength(0); // window of «sync» — 120 s
    await pool.query(`UPDATE onec_alert_episodes SET created_at = now() - interval '121 seconds' WHERE kind = 'etl_entity_failed'`);
    expect(sent(await notifier.tick())).toHaveLength(1);
    expect(await q(`SELECT 1 FROM onec_alert_dispatch_members`)).toHaveLength(2);
    expect(await q(`SELECT 1 FROM notifications`)).toHaveLength(1);
  });

  it('reminds about a critical unaccepted alert, not after «Принять», and escalates an «auto» group once', async () => {
    flags.alertNotifications = true;
    await notifier.tick();
    await raise('agent_silent', 'silent:r');
    await notifier.tick();
    await pool.query(`UPDATE onec_alert_dispatches SET created_at = now() - interval '121 minutes'`);
    await notifier.tick();
    expect((await q<{ stage: string }>(`SELECT stage FROM onec_alert_dispatches ORDER BY dispatch_id`)).map((s) => s.stage)).toEqual(['opened', 'reminder']);
    expect(await q(`SELECT seq FROM onec_alert_dispatch_members WHERE stage = 'reminder'`)).toEqual([{ seq: 1 }]);
    const [{ alert_id: alertId }] = await q<{ alert_id: string }>(`SELECT alert_id::text FROM onec_alerts WHERE dedupe_key = 'silent:r'`);
    await repo.transaction((tx) => repo.acknowledgeAlert(tx, Number(alertId), 1));
    await pool.query(`UPDATE onec_alert_dispatches SET created_at = now() - interval '5 hours'`);
    await notifier.tick();
    expect(await q(`SELECT 1 FROM onec_alert_dispatches WHERE stage = 'reminder'`)).toHaveLength(1);

    // agent_state, «auto»: warning → Важно; growing to critical → one escalation.
    await raise('agent_state', 'state:x', 'warning');
    await pool.query(`UPDATE onec_alert_episodes SET created_at = now() - interval '61 seconds' WHERE kind = 'agent_state'`);
    await notifier.tick();
    await raise('agent_state', 'state:x', 'critical');
    await notifier.tick();
    await notifier.tick();
    const stateStages = await q<{ stage: string; importance: string }>(
      `SELECT stage, importance FROM onec_alert_dispatches WHERE group_code = 'agent_state' ORDER BY dispatch_id`,
    );
    expect(stateStages).toEqual([{ stage: 'opened', importance: 'important' }, { stage: 'escalated', importance: 'critical' }]);
  });

  it('fallback chain: configured ∩ onec.view → onec.manage → superadmins → nobody (nothing recorded, alert raised)', async () => {
    flags.alertNotifications = true;
    await notifier.tick();
    // Configured: role «operator» (manager 10, viewer 11, gone 14) and user 13 (service) → 10 and 11 at level 1.
    await pool.query(`UPDATE onec_alert_notification_policies SET recipient_role_codes = '{operator}', recipient_user_ids = '{13}' WHERE group_code = 'agent_offline'`);
    await raise('agent_silent', 'silent:f1');
    await notifier.tick();
    expect(await q(`SELECT user_id::text, fallback_level FROM onec_alert_dispatch_recipients WHERE channel = 'in_app' ORDER BY user_id`)).toEqual([
      { user_id: '10', fallback_level: 1 },
      { user_id: '11', fallback_level: 1 },
    ]);

    // Configured user lacks onec.view → falls back; onec.manage without onec.view is never a recipient.
    await pool.query(`UPDATE onec_alert_notification_policies SET recipient_role_codes = '{}', recipient_user_ids = '{1}' WHERE group_code = 'agent_offline';
      DELETE FROM user_effective_permissions WHERE user_id = 10 AND permission_name = 'onec.view'`);
    await raise('agent_silent', 'silent:f2');
    await notifier.tick();
    expect(await q(`SELECT r.user_id::text, r.fallback_level FROM onec_alert_dispatch_recipients r JOIN onec_alert_dispatches d USING (dispatch_id)
      WHERE r.channel = 'in_app' AND d.dispatch_id = (SELECT max(dispatch_id) FROM onec_alert_dispatches)`)).toEqual([{ user_id: '12', fallback_level: 3 }]);

    await pool.query(`DELETE FROM user_effective_permissions WHERE user_id = 12`);
    await raise('agent_silent', 'silent:f3');
    const before = (await q(`SELECT 1 FROM onec_alert_dispatches`)).length;
    const result = await notifier.tick();
    expect(result.dispatches).toContainEqual({ kind: 'no_recipients', group: 'agent_offline' });
    expect(await q(`SELECT 1 FROM onec_alert_dispatches`)).toHaveLength(before);
    expect(await q(`SELECT status FROM onec_alert_episodes e JOIN onec_alerts a USING (alert_id) WHERE a.dedupe_key = 'silent:f3'`)).toEqual([{ status: 'pending' }]);
    expect(await q(`SELECT severity, state FROM onec_alerts WHERE kind = $1`, [NO_RECIPIENTS_ALERT_KIND])).toEqual([{ severity: 'critical', state: 'open' }]);

    await grant(11, 'onec.manage');
    await notifier.tick();
    expect(await q(`SELECT status FROM onec_alert_episodes e JOIN onec_alerts a USING (alert_id) WHERE a.dedupe_key = 'silent:f3'`)).toEqual([{ status: 'notified' }]);
    expect(await q(`SELECT state FROM onec_alerts WHERE kind = $1`, [NO_RECIPIENTS_ALERT_KIND])).toEqual([{ state: 'resolved' }]);
  });

  it('a dispatch that fails midway rolls back whole and is sent once on the next tick', async () => {
    flags.alertNotifications = true;
    await notifier.tick();
    await raise('agent_silent', 'silent:fail');
    const original = audit.bySystem.bind(audit);
    let failures = 1;
    audit.bySystem = (async (...args: Parameters<OnecAuditWriter['bySystem']>) => {
      if (failures-- > 0) throw new Error('E2E audit failure');
      return original(...args);
    }) as OnecAuditWriter['bySystem'];
    try {
      const failed = await notifier.tick();
      expect(sent(failed)).toHaveLength(0);
      expect(await q(`SELECT 1 FROM onec_alert_dispatches`)).toHaveLength(0);
      expect(await q(`SELECT 1 FROM notifications`)).toHaveLength(0);
      expect((await notifications.readState()).lastTickError).toContain('E2E audit failure');
      expect(sent(await notifier.tick())).toHaveLength(1);
      expect(await q(`SELECT 1 FROM notifications`)).toHaveLength(1);
      expect((await notifications.readState()).lastTickError).toBeNull();
    } finally {
      audit.bySystem = original;
    }
  });

  it('writers and the dispatcher run concurrently without deadlocks or duplicate stages', async () => {
    flags.alertNotifications = true;
    await notifier.tick();
    const writers = Array.from({ length: 8 }, async (_, i) => {
      for (let round = 0; round < 4; round += 1) {
        await raise('agent_silent', `silent:c${i}`);
        await resolve(`silent:c${i}`);
      }
    });
    const ticks = (async () => {
      for (let round = 0; round < 6; round += 1) {
        const result = await notifier.tick();
        expect((await notifications.readState()).lastTickError).toBeNull();
        expect(result.active).toBe(true);
      }
    })();
    await Promise.all([...writers, ticks]);
    for (let round = 0; round < 6; round += 1) await notifier.tick();
    // Every episode got exactly one opening and one recovery; no stage twice.
    expect(await q(`SELECT episode_id FROM onec_alert_dispatch_members GROUP BY episode_id, stage, seq HAVING count(*) > 1`)).toEqual([]);
    expect(await q(`SELECT e.episode_id FROM onec_alert_episodes e
      WHERE (SELECT count(*) FROM onec_alert_dispatch_members m WHERE m.episode_id = e.episode_id AND m.stage = 'opened') <> 1
         OR (SELECT count(*) FROM onec_alert_dispatch_members m WHERE m.episode_id = e.episode_id AND m.stage = 'resolved') <> 1`)).toEqual([]);
    expect(await q(`SELECT 1 FROM onec_alert_episodes`)).toHaveLength(32);
  });

  it('a pile of old episodes that need nothing never pushes a new alert out of the selection (R1-2)', async () => {
    flags.alertNotifications = true;
    await notifier.tick();
    await pool.query(`INSERT INTO onec_alert_episodes (alert_id, opened_at, kind, severity_at_open, severity_max, acknowledged_at, status)
      SELECT 900000 + g, now() - interval '1 day', 'etl_entity_failed', 'warning', 'warning', now(), 'notified' FROM generate_series(1, 2500) g`);
    await raise('agent_silent', 'silent:new');
    const result = await notifier.tick();
    expect(sent(result)).toHaveLength(1);
    expect(await q(`SELECT e.kind FROM onec_alert_dispatch_members m JOIN onec_alert_episodes e USING (episode_id)`)).toEqual([{ kind: 'agent_silent' }]);
  });

  it('a due reminder and a recovery are not pushed out by 1000+ episodes that need nothing under their policy (R2-1)', async () => {
    flags.alertNotifications = true;
    await notifier.tick();
    await raise('agent_silent', 'silent:due');
    await notifier.tick();
    const [{ dispatch_id: opened }] = await q<{ dispatch_id: string }>(`SELECT dispatch_id::text FROM onec_alert_dispatches`);
    // 1200 open unaccepted «sync» episodes (Важно, no repeat) and 1200 resolved «sync» ones whose group has no recovery
    // notice — all opened in an old dispatch; none needs a stage.
    await pool.query(`UPDATE onec_alert_notification_policies SET repeat_minutes = NULL, notify_resolved = false WHERE group_code = 'sync';
      INSERT INTO onec_alert_dispatches (group_code, stage, importance, fallback_level, request_id, created_at)
        VALUES ('sync', 'opened', 'important', 2, 'e2e', now() - interval '1 day');
      INSERT INTO onec_alert_episodes (alert_id, opened_at, kind, severity_at_open, severity_max, status, resolved_at)
        SELECT 800000 + g, now() - interval '1 day', 'etl_entity_failed', 'warning', 'warning', 'notified',
               CASE WHEN g > 1200 THEN now() - interval '1 hour' END FROM generate_series(1, 2400) g;
      INSERT INTO onec_alert_dispatch_members (dispatch_id, episode_id, stage)
        SELECT (SELECT max(dispatch_id) FROM onec_alert_dispatches), episode_id, 'opened' FROM onec_alert_episodes WHERE alert_id >= 800000;
      UPDATE onec_alert_dispatches SET created_at = now() - interval '3 hours' WHERE dispatch_id = ${opened}`);
    await raise('agent_silent', 'silent:gone');
    await notifier.tick();
    await resolve('silent:gone');
    await notifier.tick();
    const stages = await q<{ stage: string }>(`SELECT d.stage FROM onec_alert_dispatches d WHERE d.request_id <> 'e2e' ORDER BY d.dispatch_id`);
    expect(stages.map((s) => s.stage)).toEqual(['opened', 'opened', 'reminder', 'resolved']);
  });

  it('1000 undeliverable episodes of one group do not hide a deliverable critical one; the fault stays until fixed (R3)', async () => {
    flags.alertNotifications = true;
    await notifier.tick();
    // Nobody holds onec.manage or superadmin; only «agent_offline» and «other» have a configured recipient (the viewer).
    await pool.query(`DELETE FROM user_effective_permissions WHERE permission_name IN ('onec.manage', 'system.superadmin');
      UPDATE onec_alert_notification_policies SET recipient_user_ids = '{11}' WHERE group_code IN ('agent_offline', 'other');
      INSERT INTO onec_alert_episodes (alert_id, opened_at, kind, severity_at_open, severity_max, status, created_at)
        SELECT 700000 + g, now() - interval '1 hour', 'etl_entity_failed', 'warning', 'warning', 'pending', now() - interval '1 hour'
          FROM generate_series(1, 1000) g`);
    await raise('agent_silent', 'silent:behind');
    for (let i = 0; i < 3; i += 1) await notifier.tick();
    expect(await q(`SELECT a.dedupe_key FROM onec_alert_dispatch_members m JOIN onec_alert_episodes e USING (episode_id)
      JOIN onec_alerts a USING (alert_id)`)).toEqual([{ dedupe_key: 'silent:behind' }]);
    // «sync» (and the other unconfigured groups) still have nobody: the fault alert is open and lists them, although
    // dispatches of other groups succeed.
    const [fault] = await q<{ state: string; details: { groups: string[] } }>(`SELECT state, details FROM onec_alerts WHERE kind = $1`, [NO_RECIPIENTS_ALERT_KIND]);
    expect(fault.state).toBe('open');
    expect(fault.details.groups).toContain('sync');
    expect(fault.details.groups).not.toContain('agent_offline');
    await raise('agent_silent', 'silent:behind2');
    await notifier.tick();
    expect((await q<{ state: string }>(`SELECT state FROM onec_alerts WHERE kind = $1`, [NO_RECIPIENTS_ALERT_KIND]))[0].state).toBe('open');
    // Fixed for every group → closed.
    await grant(11, 'onec.manage');
    await notifier.tick();
    expect((await q<{ state: string }>(`SELECT state FROM onec_alerts WHERE kind = $1`, [NO_RECIPIENTS_ALERT_KIND]))[0].state).toBe('resolved');
  });

  it('undeliverable plans do not block a deliverable one (R1-3)', async () => {
    flags.alertNotifications = true;
    await notifier.tick();
    // Only «sync» has a recipient (the viewer, configured); nobody holds onec.manage or superadmin.
    await pool.query(`DELETE FROM user_effective_permissions WHERE permission_name IN ('onec.manage', 'system.superadmin');
      UPDATE onec_alert_notification_policies SET recipient_user_ids = '{11}' WHERE group_code = 'sync'`);
    for (const [kind, key] of [['agent_silent', 'u1'], ['config_rejected', 'u2'], ['certificate_expiring', 'u3'], ['agent_state', 'u4'], ['command_dead_letter', 'u5']]) {
      await raise(kind, key);
    }
    await raise('etl_entity_failed', 'deliverable', 'warning');
    await pool.query(`UPDATE onec_alert_episodes SET created_at = now() - interval '10 minutes'`);
    const result = await notifier.tick();
    expect(result.dispatches.filter((d) => d.kind === 'no_recipients')).toHaveLength(5);
    expect(sent(result)).toHaveLength(1);
    expect(await q(`SELECT r.user_id::text, d.group_code FROM onec_alert_dispatch_recipients r JOIN onec_alert_dispatches d USING (dispatch_id)
      WHERE r.channel = 'in_app'`)).toEqual([{ user_id: '11', group_code: 'sync' }]);
  });

  it('a dispatcher gap (backend down or an older image) cuts off again: the backlog comes as a digest (R1-4)', async () => {
    flags.alertNotifications = true;
    await notifier.tick();
    // An image below slice 1 ran for 2 hours: it never cleared `active`, episodes piled up as pending.
    await pool.query(`UPDATE onec_alert_notification_state SET last_tick_at = now() - interval '2 hours'`);
    await raise('agent_silent', 'gap:open');
    await raise('agent_silent', 'gap:closed');
    await resolve('gap:closed');
    const result = await notifier.tick();
    expect(result.switchedOn).toBe(true);
    expect(await q(`SELECT stage FROM onec_alert_dispatches`)).toEqual([{ stage: 'digest' }]);
    expect(await q(`SELECT a.dedupe_key, e.status FROM onec_alert_episodes e JOIN onec_alerts a USING (alert_id) ORDER BY a.dedupe_key`)).toEqual([
      { dedupe_key: 'gap:closed', status: 'closed_unnotified' },
      { dedupe_key: 'gap:open', status: 'notified' },
    ]);
    // A normal pause between ticks is not a gap.
    expect((await notifier.tick()).switchedOn).toBe(false);
  });

  it('settings: version check, mandatory channels, unavailable external channels, audit; test send once a minute', async () => {
    const body = {
      importance: 'critical', recipientRoleCodes: ['operator'], recipientUserIds: [11], externalChannels: [],
      delayMinutes: 0, repeatMinutes: 60, notifyResolved: true, quietHours: '23:00-08:00', criticalIgnoresQuietHours: true,
    };
    await expect(settings.updatePolicy('agent_offline', undefined, body, manager, ctx)).rejects.toMatchObject({ statusCode: 428 });
    await expect(settings.updatePolicy('agent_offline', '"2"', body, manager, ctx)).rejects.toMatchObject({ code: 'ONEC_ALERT_POLICY_VERSION_CONFLICT' });
    await expect(settings.updatePolicy('agent_offline', '1', { ...body, balloon: false }, manager, ctx)).rejects.toMatchObject({ code: 'ONEC_ALERT_MANDATORY_CHANNELS' });
    await expect(settings.updatePolicy('agent_offline', '1', { ...body, externalChannels: ['telegram'] }, manager, ctx)).rejects.toMatchObject({ code: 'ONEC_ALERT_CHANNEL_UNAVAILABLE' });
    await expect(settings.updatePolicy('agent_offline', '1', { ...body, recipientUserIds: [999] }, manager, ctx)).rejects.toMatchObject({ code: 'ONEC_ALERT_RECIPIENT_UNKNOWN' });
    await expect(settings.updatePolicy('nope', '1', body, manager, ctx)).rejects.toBeInstanceOf(ApiError);
    const { policy } = await settings.updatePolicy('agent_offline', '1', body, manager, ctx);
    expect(policy).toMatchObject({ version: 2, repeatMinutes: 60, recipientRoleCodes: ['operator'], recipientUserIds: [11], updatedBy: 10 });
    const [row] = await q<{ event: string; entity_id: string; diff: Record<string, unknown> }>(`SELECT event, entity_id, diff_json AS diff FROM audit_log`);
    expect(row.event).toBe('onec.alert_notification_policy.updated');
    expect(row.entity_id).toBe('agent_offline');
    expect(Object.keys(row.diff).sort()).toEqual(['quietHours', 'recipientRoleCodes', 'recipientUserIds', 'repeatMinutes']);

    const overview = await settings.overview();
    const offline = overview.groups.find((group) => group.code === 'agent_offline');
    expect(offline?.recipients).toEqual({ fallbackLevel: 1, users: [{ id: 10, name: 'manager' }, { id: 11, name: 'viewer' }] });
    expect(offline?.filteredOut).toEqual([{ userId: 14, username: 'gone' }]);
    expect(overview.groups).toHaveLength(8);

    const test = await settings.sendTest('sync', manager, ctx);
    expect(test.visibleInBell).toBe(true);
    await expect(settings.sendTest('sync', manager, ctx)).rejects.toMatchObject({ code: 'ONEC_ALERT_TEST_RATE_LIMITED' });
    expect(await q(`SELECT balloon_mode, user_id::text FROM notifications`)).toEqual([{ balloon_mode: 'mandatory', user_id: '10' }]);
    expect(await q(`SELECT event FROM audit_log WHERE event = 'onec.alert_notification.test_sent'`)).toHaveLength(1);
  });
});
