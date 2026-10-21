import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseClient } from '../../database/database.types';
import type { PerformanceQueryTelemetryService } from '../../performance/performance-query-telemetry.service';
import type { CurrentUser } from '../../permissions/current-user';
import { installAuthorizationSnapshot, withLocalAuthorizationSnapshot } from '../whatsapp/order-send/authorization-snapshot.test-util';
import { WhatsAppNotificationPort } from '../whatsapp/notifications/whatsapp-notification.port';
import { WhatsAppNotificationRepository } from '../whatsapp/notifications/whatsapp-notification.repository';
import type { WhatsAppRuntimeConfigService } from '../whatsapp/whatsapp-runtime-config.service';
import { PgOnecAlertNotificationsRepository } from './adapters/pg-onec-alert-notifications-repository';
import { PgOnecRepository } from './adapters/pg-onec-repository';
import { OnecAlertNotificationSettingsService } from './application/onec-alert-notification-settings.service';
import { OnecAlertNotifier } from './application/onec-alert-notifier';
import { OnecAuditWriter } from './application/onec-audit';
import type { OnecRuntimeConfigService } from './onec-runtime-config.service';

const suite = process.env.ONEC_AGENT_DOCKER_TEST === 'true' ? describe : describe.skip;

const CHAT = '120363338054016575@g.us';
const OTHER_CHAT = '120363338054016576@g.us';
const MANAGER = 10; // onec.view + onec.manage, employee 301 with a work phone
const NO_PHONE = 11; // onec.view + onec.manage, employee 302 without a phone

/*
 * 1C alerts → WhatsApp (plan 2026-10-19 §2.5, §5) on the REAL channel port and migration 261, in an isolated schema
 * of the stage PostgreSQL with the authorization snapshot of migration 248 (permissions come from role_permissions,
 * as in production). WAHA is never called: deliveries are only queued, cancelled and re-queued here.
 */
suite('1C alerts → WhatsApp — real channel port, isolated PostgreSQL', () => {
  const schema = `e2e_onec_wa_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let db: DatabaseService;
  let repo: PgOnecRepository;
  let notifications: PgOnecAlertNotificationsRepository;
  let channel: WhatsAppNotificationRepository;
  let port: WhatsAppNotificationPort;
  let notifier: OnecAlertNotifier;
  let settings: OnecAlertNotificationSettingsService;
  const flags = { alertNotifications: true };
  const wa = { enabled: true, relayOwner: 'in_process' };
  const runtime = { get: () => ({ ...flags, monitorOwner: 'in_process' }) } as unknown as OnecRuntimeConfigService;
  const actor = (permissions: string[]): CurrentUser => ({ id: String(MANAGER), username: 'manager', role: 'operator', roleId: 2, permissions });
  const ctx = { requestId: 'e2e-request', correlationId: 'e2e-correlation' };

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
  const raise = (kind: string, dedupeKey: string, severity: 'warning' | 'critical' = 'critical') =>
    repo.transaction((tx) => repo.upsertAlert(tx, { kind, agentId: null, sourceId: null, certId: null, severity, dedupeKey, details: {} }));
  const resolve = (dedupeKey: string) => repo.transaction((tx) => repo.resolveAlertByDedupeKey(tx, dedupeKey));
  const due = () => pool.query(`UPDATE onec_alert_dispatches SET external_due_at = now() - interval '1 second' WHERE external_state = 'pending_delay'`);
  const setPolicy = (group: string, sql: string) => pool.query(`UPDATE onec_alert_notification_policies SET ${sql} WHERE group_code = $1`, [group]);
  const external = () =>
    q<{ dispatch_id: string; user_id: string | null; chat_id: string | null; attempt: number; status: string; skip_reason: string | null; channel_state: string | null }>(
      `SELECT dispatch_id::text, user_id::text, chat_id, attempt, status, skip_reason, channel_state FROM onec_alert_dispatch_recipients
        WHERE channel = 'whatsapp' ORDER BY dispatch_id, chat_id NULLS FIRST, user_id, attempt`,
    );
  const deliveries = () =>
    q<{ idempotency_key: string; state: string; reason: string | null; recipient_kind: string; required_permission: string | null; not_before: Date; expires_at: Date }>(
      `SELECT idempotency_key, state, reason, recipient_kind, required_permission, not_before, expires_at FROM whatsapp_notification_deliveries ORDER BY created_at, idempotency_key`,
    );

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
      CREATE TABLE roles(role_id int PRIMARY KEY, role_code text, role_name text, is_active boolean NOT NULL DEFAULT true);
      INSERT INTO roles VALUES (1, 'admin', 'Администратор', true), (2, 'operator', 'Оператор 1С', true);
      CREATE TABLE users(user_id bigint PRIMARY KEY, username text, full_name text, role_id int REFERENCES roles, is_active boolean NOT NULL DEFAULT true,
        is_service_account boolean NOT NULL DEFAULT false, employee_id bigint);
      INSERT INTO users VALUES (1, 'E2E-Тест', NULL, 1, true, false, NULL), (${MANAGER}, 'manager', 'Менеджер 1С', 2, true, false, 301),
        (${NO_PHONE}, 'nophone', NULL, 2, true, false, 302);
      CREATE TABLE permissions_state(id boolean PRIMARY KEY DEFAULT true, version int NOT NULL DEFAULT 1, updated_at timestamptz);
      INSERT INTO permissions_state VALUES (true, 1, now());
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY, domain text, label text, description text, sort_order int NOT NULL DEFAULT 0,
        is_dangerous boolean, is_active boolean NOT NULL DEFAULT true, updated_at timestamptz);
      INSERT INTO permissions_catalog(permission_name) VALUES ('onec.view'), ('onec.manage'), ('whatsapp.manage');
      CREATE TABLE role_permissions(role_id int, permission_name text, is_enabled boolean NOT NULL DEFAULT true, PRIMARY KEY(role_id, permission_name));
      INSERT INTO role_permissions(role_id, permission_name) VALUES (2, 'onec.view'), (2, 'onec.manage');
      CREATE TABLE role_policy_scopes(role_id int, scope_key text, scope_value text, PRIMARY KEY(role_id, scope_key));
      CREATE TABLE employees(employee_id bigint PRIMARY KEY, full_name text, is_active boolean NOT NULL DEFAULT true);
      INSERT INTO employees VALUES (301, 'Тест Менеджер', true), (302, 'Тест Без телефона', true);
      CREATE TABLE employee_work_contacts(contact_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, employee_id bigint NOT NULL REFERENCES employees,
        kind text NOT NULL, value text NOT NULL, value_normalized text NOT NULL, is_primary boolean NOT NULL DEFAULT false, position smallint NOT NULL DEFAULT 0);
      INSERT INTO employee_work_contacts(employee_id, kind, value, value_normalized, is_primary) VALUES (301, 'phone', '+7 701 000 00 01', '77010000001', true);
      CREATE TABLE whatsapp_broadcast_control(singleton_id smallint PRIMARY KEY DEFAULT 1, paused boolean NOT NULL DEFAULT false);
      INSERT INTO whatsapp_broadcast_control VALUES (1, false);
      CREATE TABLE notifications(notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id bigint, level text NOT NULL,
        title text NOT NULL, message text NOT NULL, entity_type text, entity_id text, source_type text NOT NULL, source_id text,
        is_read boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), idempotency_key text,
        balloon_mode text, balloon_shown_at timestamptz);
      CREATE UNIQUE INDEX ON notifications(idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE audit_log(LIKE public.audit_log INCLUDING ALL);
      CREATE TABLE audit_log_related_entity(LIKE public.audit_log_related_entity INCLUDING ALL);`);
    await installAuthorizationSnapshot((sql) => pool.query(sql), schema,
      readFileSync(new URL('../../../db/migrations/248_authorization_snapshot.sql', import.meta.url), 'utf8'));
    for (const file of ['193_onec_agent_foundation.sql', '196_onec_agent_commands.sql', '198_onec_etl.sql', '200_onec_etl_snapshots_revocation.sql',
      '247_onec_agent_expected_silence.sql', '250_onec_stock_snapshots.sql', '262_onec_alert_episodes.sql', '264_onec_alert_notifications.sql',
      '265_onec_alert_whatsapp.sql', '261_whatsapp_notification_deliveries.sql']) {
      await pool.query(readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 10000, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 4, DATABASE_SSL: false };
    const real = new DatabaseService(
      { get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>,
      { measure: <T>(_sql: string, op: () => Promise<T>) => op() } as PerformanceQueryTelemetryService,
    );
    // The code names public.user_authorization_snapshot; here it must be the schema's copy (as in the port's own test).
    const local = withLocalAuthorizationSnapshot(schema);
    const wrap = (client: DatabaseClient): DatabaseClient => ({ query: ((text: string, params?: unknown[]) => client.query(local(text), params as never)) as DatabaseClient['query'] }) as DatabaseClient;
    db = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'query') return (text: string, params?: unknown[]) => target.query(local(text), params as never);
        if (prop === 'transaction') return <T>(handler: (tx: DatabaseClient) => Promise<T>) => target.transaction((tx) => handler(wrap(tx)));
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    repo = new PgOnecRepository(db);
    notifications = new PgOnecAlertNotificationsRepository(db);
    channel = new WhatsAppNotificationRepository(db);
    port = new WhatsAppNotificationPort(channel, { getConfig: () => wa } as unknown as WhatsAppRuntimeConfigService);
    const audit = new OnecAuditWriter(repo);
    notifier = new OnecAlertNotifier(notifications, repo, audit, runtime, port);
    settings = new OnecAlertNotificationSettingsService(notifications, audit, runtime, port);
    await channel.startEpoch(new Date());
    // Switched on with nothing waiting: later alerts go out stage by stage.
    expect((await notifier.tick()).switchedOn).toBe(true);
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
    wa.enabled = true;
    wa.relayOwner = 'in_process';
    await pool.query(`TRUNCATE onec_alert_dispatch_recipients, onec_alert_dispatch_members, onec_alert_dispatches, onec_alerts,
        onec_alert_episodes, notifications, whatsapp_notification_deliveries RESTART IDENTITY CASCADE;
      UPDATE onec_alert_notification_policies SET recipient_role_codes = '{}', recipient_user_ids = '{${MANAGER}}', external_channels = '{}',
        whatsapp_chat_id = NULL, whatsapp_chat_name = NULL, delay_minutes = 0, quiet_hours = NULL, critical_ignores_quiet_hours = true,
        notify_resolved = true, version = 1,
        repeat_minutes = CASE WHEN group_code IN ('sync', 'commands', 'stock_snapshots') THEN NULL ELSE 120 END;
      UPDATE onec_alert_notification_state SET last_tick_at = now(), last_tick_error = NULL;
      DELETE FROM audit_log_related_entity; DELETE FROM audit_log;`);
  });

  it('an opening goes personally and to the chat with the minimum, keyed per attempt, re-checked by permission', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp,whatsapp_chat}', whatsapp_chat_id = '${CHAT}', recipient_user_ids = '{${MANAGER},${NO_PHONE}}'`);
    // Alert ids far from dispatch ids: the channel audit must relate the dispatch, not an alert with the same number.
    await pool.query(`SELECT setval(pg_get_serial_sequence('onec_alerts', 'alert_id'), 500)`);
    await raise('agent_silent', 'silent:a');
    const result = await notifier.tick();
    const [dispatch] = result.dispatches;
    expect(dispatch).toMatchObject({ kind: 'sent', recipients: 2 });
    const id = (dispatch as { dispatchId: number }).dispatchId;
    expect(await q(`SELECT external_state FROM onec_alert_dispatches`)).toEqual([{ external_state: 'queued' }]);
    expect(await external()).toEqual([
      { dispatch_id: String(id), user_id: String(MANAGER), chat_id: null, attempt: 1, status: 'queued', skip_reason: null, channel_state: null },
      { dispatch_id: String(id), user_id: String(NO_PHONE), chat_id: null, attempt: 1, status: 'skipped', skip_reason: 'NO_WORK_PHONE', channel_state: 'skipped' },
      { dispatch_id: String(id), user_id: null, chat_id: CHAT, attempt: 1, status: 'queued', skip_reason: null, channel_state: null },
    ]);
    const rows = await deliveries();
    expect(rows.map((row) => [row.idempotency_key, row.state, row.recipient_kind, row.required_permission])).toEqual([
      [`onec-alert:${id}:whatsapp:user:${MANAGER}:attempt1`, 'queued', 'user', 'onec.view'],
      [`onec-alert:${id}:whatsapp:user:${NO_PHONE}:attempt1`, 'skipped', 'user', 'onec.view'],
      [`onec-alert:${id}:whatsapp:chat:${CHAT}:attempt1`, 'queued', 'chat', null],
    ]);
    // Critical: no quiet hours, a 2-hour lifetime from now.
    const life = rows[0].expires_at.getTime() - rows[0].not_before.getTime();
    expect(life).toBeGreaterThan(119 * 60_000);
    expect(life).toBeLessThanOrEqual(120 * 60_000 + 5000);
    // The bell and the balloon are there as always; the audit counts the channel without addresses.
    expect(await q(`SELECT count(*)::int AS n FROM notifications`)).toEqual([{ n: 2 }]);
    const [audit] = await q<{ after_json: { recipients: { whatsapp: unknown }; externalState: string } }>(
      `SELECT after_json FROM audit_log WHERE event = 'onec.alert_notification.dispatched'`,
    );
    expect(audit.after_json.recipients.whatsapp).toEqual({ queued: 2, skipped: 1, chat: true });
    expect(JSON.stringify(audit.after_json)).not.toContain(CHAT);
    const related = await q<{ entity_type: string; entity_id: string }>(
      `SELECT DISTINCT r.entity_type, r.entity_id::text AS entity_id FROM audit_log_related_entity r JOIN audit_log a USING (audit_id)
        WHERE a.entity_type = 'whatsapp_notification' ORDER BY 1, 2`,
    );
    expect(related).toEqual([{ entity_type: 'onec_alert_dispatch', entity_id: String(id) }]);
  });

  it('a failing channel call rolls back only itself: the minimum and the other target are committed', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp,whatsapp_chat}', whatsapp_chat_id = '${CHAT}'`);
    const original = port.enqueue.bind(port);
    port.enqueue = async (tx, request) => {
      if ('chatId' in request.recipient) {
        await tx.query(`INSERT INTO whatsapp_notification_deliveries (idempotency_key) VALUES ('half-written')`).catch(() => undefined);
        throw new Error('channel down');
      }
      return original(tx, request);
    };
    try {
      await raise('agent_silent', 'silent:b');
      expect((await notifier.tick()).dispatches[0]).toMatchObject({ kind: 'sent' });
    } finally {
      port.enqueue = original;
    }
    expect((await external()).map((row) => [row.chat_id, row.status, row.skip_reason])).toEqual([
      [null, 'queued', null],
      [CHAT, 'skipped', 'ENQUEUE_FAILED'],
    ]);
    expect(await q(`SELECT count(*)::int AS n FROM notifications`)).toEqual([{ n: 1 }]);
    expect((await deliveries()).map((row) => row.recipient_kind)).toEqual(['user']);
  });

  it('a delayed opening queues its external part after the delay, or suppresses it when everything closed', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp}', delay_minutes = 10, notify_resolved = false`);
    await raise('agent_silent', 'silent:open');
    await notifier.tick();
    await raise('agent_silent', 'silent:closed');
    await notifier.tick();
    expect(await q(`SELECT external_state FROM onec_alert_dispatches ORDER BY dispatch_id`)).toEqual([
      { external_state: 'pending_delay' },
      { external_state: 'pending_delay' },
    ]);
    expect(await deliveries()).toEqual([]);
    await resolve('silent:closed');
    // Nothing happens before the delay is over.
    await notifier.tick();
    expect(await deliveries()).toEqual([]);
    await pool.query(`UPDATE onec_alert_dispatches SET external_due_at = now() - interval '1 second'`);
    await notifier.tick();
    expect(await q(`SELECT external_state FROM onec_alert_dispatches ORDER BY dispatch_id`)).toEqual([
      { external_state: 'queued' },
      { external_state: 'suppressed' },
    ]);
    expect((await external()).map((row) => [row.status, row.skip_reason])).toEqual([
      ['queued', null],
      ['skipped', 'RESOLVED_BEFORE_DELAY'],
    ]);
    expect((await deliveries()).map((row) => row.state)).toEqual(['queued']);
    expect(await q(`SELECT count(*)::int AS n FROM audit_log WHERE event = 'onec.alert_notification.external_released'`)).toEqual([{ n: 2 }]);
  });

  it('closing all members cancels the unstarted alarm deliveries; no recovery notice goes where the alarm never went', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp,whatsapp_chat}', whatsapp_chat_id = '${CHAT}'`);
    await raise('agent_silent', 'silent:c');
    await notifier.tick();
    await resolve('silent:c');
    await notifier.tick();
    // The recovery notice waits for the outcome of its alarm, which this tick cancelled.
    expect(await q(`SELECT stage, external_state FROM onec_alert_dispatches ORDER BY dispatch_id`)).toEqual([
      { stage: 'opened', external_state: 'cancelled' },
      { stage: 'resolved', external_state: 'pending_delay' },
    ]);
    await due();
    await notifier.tick();
    expect(await q(`SELECT stage, external_state FROM onec_alert_dispatches ORDER BY dispatch_id`)).toEqual([
      { stage: 'opened', external_state: 'cancelled' },
      { stage: 'resolved', external_state: 'suppressed' },
    ]);
    expect((await external()).filter((row) => row.dispatch_id === '2').map((row) => [row.chat_id, row.status, row.skip_reason])).toEqual([
      [null, 'skipped', 'ALARM_NOT_SENT'],
      [CHAT, 'skipped', 'ALARM_NOT_SENT'],
    ]);
    expect((await deliveries()).map((row) => [row.idempotency_key.split(':')[1], row.state, row.reason])).toEqual([
      ['1', 'cancelled', 'cancelled_by_source'],
      ['1', 'cancelled', 'cancelled_by_source'],
    ]);
    // Once closed, nothing is cancelled twice; the bell got both stages.
    await notifier.tick();
    expect(await q(`SELECT count(*)::int AS n FROM audit_log WHERE event = 'onec.alert_notification.external_cancelled'`)).toEqual([{ n: 1 }]);
    expect(await q(`SELECT count(*)::int AS n FROM notifications`)).toEqual([{ n: 2 }]);
  });

  it('the recovery notice follows the alarm only where it was sent (or may have been), not where it failed', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp,whatsapp_chat}', whatsapp_chat_id = '${CHAT}'`);
    await raise('agent_silent', 'silent:sent');
    await notifier.tick();
    await pool.query(`UPDATE whatsapp_notification_deliveries SET state = CASE recipient_kind WHEN 'user' THEN 'sent' ELSE 'failed' END,
      reason = CASE recipient_kind WHEN 'user' THEN NULL ELSE 'CHAT_NOT_FOUND' END, sent_at = now(), finished_at = now()`);
    await resolve('silent:sent');
    await notifier.tick();
    // The poll of this tick recorded both outcomes (nothing left to cancel); the notice decides on the next look.
    await due();
    await notifier.tick();
    expect(await q(`SELECT stage, external_state FROM onec_alert_dispatches ORDER BY dispatch_id`)).toEqual([
      { stage: 'opened', external_state: 'cancelled' },
      { stage: 'resolved', external_state: 'queued' },
    ]);
    expect((await external()).filter((row) => row.dispatch_id === '2').map((row) => [row.chat_id, row.status, row.skip_reason])).toEqual([
      [null, 'queued', null],
      [CHAT, 'skipped', 'ALARM_NOT_SENT'],
    ]);
    expect((await deliveries()).filter((row) => row.idempotency_key.startsWith('onec-alert:2:')).map((row) => row.idempotency_key)).toEqual([
      `onec-alert:2:whatsapp:user:${MANAGER}:attempt1`,
    ]);
    // An alarm already finished when the recovery is planned: decided at once, no waiting.
    await raise('agent_silent', 'silent:sent2');
    await notifier.tick();
    await pool.query(`UPDATE whatsapp_notification_deliveries SET state = 'unknown', finished_at = now() WHERE state = 'queued' AND idempotency_key LIKE 'onec-alert:3:%'`);
    await notifier.tick();
    await resolve('silent:sent2');
    await notifier.tick();
    expect(await q(`SELECT stage, external_state FROM onec_alert_dispatches WHERE dispatch_id = 4`)).toEqual([{ stage: 'resolved', external_state: 'queued' }]);
    expect((await external()).filter((row) => row.dispatch_id === '4').map((row) => [row.chat_id, row.status])).toEqual([
      [null, 'queued'],
      [CHAT, 'queued'],
    ]);
  });

  it('an aggregated recovery tells each target only of the episodes whose alarm reached it (R5-1)', async () => {
    // Alarm A went to the chat only, alarm B (after a policy change) to the manager only; both close before one tick.
    await setPolicy('agent_offline', `external_channels = '{whatsapp_chat}', whatsapp_chat_id = '${CHAT}'`);
    await raise('agent_silent', 'silent:A');
    await notifier.tick();
    await setPolicy('agent_offline', `external_channels = '{whatsapp}', whatsapp_chat_id = NULL`);
    await raise('agent_silent', 'silent:B');
    await notifier.tick();
    await pool.query(`UPDATE whatsapp_notification_deliveries SET state = 'sent', sent_at = now(), finished_at = now()`);
    await notifier.tick();
    await setPolicy('agent_offline', `external_channels = '{whatsapp,whatsapp_chat}', whatsapp_chat_id = '${CHAT}'`);
    await resolve('silent:A');
    await resolve('silent:B');
    await notifier.tick();
    const [recovery] = await q<{ dispatch_id: string; external_state: string }>(`SELECT dispatch_id::text, external_state FROM onec_alert_dispatches WHERE stage = 'resolved'`);
    expect(recovery.external_state).toBe('queued');
    expect(await q(`SELECT count(*)::int AS n FROM onec_alert_dispatch_members WHERE dispatch_id = $1`, [recovery.dispatch_id])).toEqual([{ n: 2 }]);
    const sent = await q<{ recipient_kind: string; body: string }>(
      `SELECT recipient_kind, body FROM whatsapp_notification_deliveries WHERE idempotency_key LIKE $1 ORDER BY recipient_kind`, [`onec-alert:${recovery.dispatch_id}:%`]);
    expect(sent.map((row) => row.recipient_kind)).toEqual(['chat', 'user']);
    for (const row of sent) expect(row.body).toContain('Восстановлено: 1.');
    // The bell carries both.
    const [bell] = await q<{ message: string }>(`SELECT message FROM notifications WHERE source_id = $1`, [recovery.dispatch_id]);
    expect(bell.message).toContain('Восстановлено: 2.');
  });

  it('a delivered escalation is enough for the recovery while the aggregated opening still waits for the morning (R5-2)', async () => {
    const [{ importance }] = await q<{ importance: string }>(`SELECT importance FROM onec_alert_notification_policies WHERE group_code = 'agent_offline'`);
    onTestFinished(() => setPolicy('agent_offline', `importance = '${importance}'`).then(() => undefined));
    await setPolicy('agent_offline', `external_channels = '{whatsapp}', importance = 'auto'`);
    await raise('agent_silent', 'silent:esc', 'warning');
    await notifier.tick();
    // The opening waits for the end of the quiet hours; the escalation went out and was sent.
    await pool.query(`UPDATE whatsapp_notification_deliveries SET not_before = now() + interval '8 hours', expires_at = now() + interval '10 hours'`);
    await raise('agent_silent', 'silent:esc', 'critical');
    await notifier.tick();
    expect(await q(`SELECT stage FROM onec_alert_dispatches ORDER BY dispatch_id`)).toEqual([{ stage: 'opened' }, { stage: 'escalated' }]);
    await pool.query(`UPDATE whatsapp_notification_deliveries SET state = 'sent', sent_at = now(), finished_at = now() WHERE idempotency_key LIKE 'onec-alert:2:%'`);
    await notifier.tick();
    // The opening's delivery is still in flight when the alert closes: the recovery does not wait for it.
    await resolve('silent:esc');
    await notifier.tick();
    expect(await q(`SELECT external_state FROM onec_alert_dispatches WHERE stage = 'resolved'`)).toEqual([{ external_state: 'queued' }]);
    expect(await q(`SELECT count(*)::int AS n FROM whatsapp_notification_deliveries WHERE idempotency_key LIKE 'onec-alert:3:%' AND state = 'queued'`)).toEqual([{ n: 1 }]);
  });

  it('the recovery asks the channel about an alarm not yet recorded here (R5-2-1)', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp}'`);
    await raise('agent_silent', 'silent:stale');
    await notifier.tick();
    // The channel sent it; the dispatcher has not polled yet (local channel_state is NULL).
    await pool.query(`UPDATE whatsapp_notification_deliveries SET state = 'sent', sent_at = now(), finished_at = now()`);
    expect(await q(`SELECT channel_state FROM onec_alert_dispatch_recipients WHERE channel = 'whatsapp'`)).toEqual([{ channel_state: null }]);
    await resolve('silent:stale');
    // The recovery is decided in this tick on the channel's word, before the poll records it.
    await notifier.tick();
    expect(await q(`SELECT external_state FROM onec_alert_dispatches WHERE stage = 'resolved'`)).toEqual([{ external_state: 'queued' }]);
    expect((await external()).filter((row) => row.dispatch_id === '2').map((row) => [row.status, row.skip_reason])).toEqual([['queued', null]]);
    await notifier.tick();
    expect(await q(`SELECT count(*)::int AS n FROM whatsapp_notification_deliveries WHERE idempotency_key LIKE 'onec-alert:2:%'`)).toEqual([{ n: 1 }]);
  });

  it('a recovery past its wait still sends where the channel confirms the alarm, skips the rest', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp,whatsapp_chat}', whatsapp_chat_id = '${CHAT}'`);
    await raise('agent_silent', 'silent:late');
    await notifier.tick();
    await resolve('silent:late');
    // A recovery dispatch planned 27 h ago and never decided (the dispatcher stood still); the channel sent the
    // manager's alarm, the chat's is somehow still queued there; nothing recorded here.
    await pool.query(`UPDATE whatsapp_notification_deliveries SET state = 'sent', sent_at = now(), finished_at = now() WHERE recipient_kind = 'user'`);
    const [opened] = await q<{ dispatch_id: string }>(`SELECT dispatch_id::text FROM onec_alert_dispatches WHERE stage = 'opened'`);
    const original = notifications.closedQueuedDispatches.bind(notifications);
    // Keep the closing cancellation away so the chat delivery stays in flight.
    notifications.closedQueuedDispatches = async () => [];
    try {
      await notifier.tick();
      await pool.query(`UPDATE onec_alert_dispatches SET created_at = now() - interval '27 hours', external_due_at = now() - interval '1 second' WHERE stage = 'resolved'`);
      await pool.query(`UPDATE onec_alert_dispatch_recipients SET channel_state = NULL, channel_reason = NULL WHERE dispatch_id = $1`, [opened.dispatch_id]);
      await notifier.tick();
    } finally {
      notifications.closedQueuedDispatches = original;
    }
    expect(await q(`SELECT external_state FROM onec_alert_dispatches WHERE stage = 'resolved'`)).toEqual([{ external_state: 'queued' }]);
    expect((await external()).filter((row) => row.dispatch_id !== opened.dispatch_id).map((row) => [row.chat_id, row.status, row.skip_reason])).toEqual([
      [null, 'queued', null],
      [CHAT, 'skipped', 'ALARM_NOT_SENT'],
    ]);
  });

  it('a recovery notice waiting for its delayed alarm is spared when the delay suppresses it', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp}', delay_minutes = 10`);
    await raise('agent_silent', 'silent:wait');
    await notifier.tick();
    await resolve('silent:wait');
    await notifier.tick();
    expect(await q(`SELECT stage, external_state FROM onec_alert_dispatches ORDER BY dispatch_id`)).toEqual([
      { stage: 'opened', external_state: 'pending_delay' },
      { stage: 'resolved', external_state: 'pending_delay' },
    ]);
    // Before the alarm's delay is over, the notice only postpones itself (no audit).
    await pool.query(`UPDATE onec_alert_dispatches SET external_due_at = now() - interval '1 second' WHERE stage = 'resolved'`);
    await notifier.tick();
    expect(await q(`SELECT external_state, external_due_at > now() AS later FROM onec_alert_dispatches WHERE stage = 'resolved'`)).toEqual([
      { external_state: 'pending_delay', later: true },
    ]);
    expect(await q(`SELECT count(*)::int AS n FROM audit_log WHERE event = 'onec.alert_notification.external_released'`)).toEqual([{ n: 0 }]);
    await due();
    await notifier.tick();
    await due();
    await notifier.tick();
    expect(await q(`SELECT stage, external_state FROM onec_alert_dispatches ORDER BY dispatch_id`)).toEqual([
      { stage: 'opened', external_state: 'suppressed' },
      { stage: 'resolved', external_state: 'suppressed' },
    ]);
    expect((await external()).map((row) => [row.dispatch_id, row.skip_reason])).toEqual([
      ['1', 'RESOLVED_BEFORE_DELAY'],
      ['2', 'ALARM_NOT_SENT'],
    ]);
    expect(await deliveries()).toEqual([]);
  });

  it('a blink (opened and closed between two ticks) sends no recovery notice to WhatsApp either', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp}'`);
    await raise('agent_silent', 'silent:blink2');
    await resolve('silent:blink2');
    await notifier.tick();
    await notifier.tick();
    expect(await q(`SELECT stage, external_state FROM onec_alert_dispatches ORDER BY dispatch_id`)).toEqual([
      { stage: 'opened', external_state: 'suppressed' },
      { stage: 'resolved', external_state: 'suppressed' },
    ]);
    expect(await deliveries()).toEqual([]);
    expect(await q(`SELECT count(*)::int AS n FROM notifications`)).toEqual([{ n: 2 }]);
  });

  it('a delivery cancelled by a backend restart (delivery_gap) is queued again as attempt 2, at most 3 attempts', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp}'`);
    await raise('agent_silent', 'silent:d');
    await notifier.tick();
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      const epoch = await channel.startEpoch(new Date());
      await channel.cancelEarlierEpochs(epoch, new Date());
      await notifier.tick();
    }
    expect((await external()).map((row) => [row.attempt, row.status, row.channel_state])).toEqual([
      [1, 'superseded', 'cancelled'],
      [2, 'superseded', 'cancelled'],
      [3, 'queued', 'cancelled'],
    ]);
    expect((await deliveries()).map((row) => [row.idempotency_key.split(':').pop(), row.state, row.reason])).toEqual([
      ['attempt1', 'cancelled', 'delivery_gap'],
      ['attempt2', 'cancelled', 'delivery_gap'],
      ['attempt3', 'cancelled', 'delivery_gap'],
    ]);
    // The bell row was not repeated.
    expect(await q(`SELECT count(*)::int AS n FROM notifications`)).toEqual([{ n: 1 }]);
  });

  it('a redelivery waiting behind a PATCH sees an alarm closed meanwhile and does not send it (R1-1)', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp}', notify_resolved = false`);
    await raise('agent_silent', 'silent:race');
    await notifier.tick();
    const epoch = await channel.startEpoch(new Date());
    await channel.cancelEarlierEpochs(epoch, new Date());
    // A PATCH holds the policy; the tick's redelivery waits for it, a writer closes the alarm meanwhile.
    const patch = await pool.connect();
    try {
      await patch.query('BEGIN');
      await patch.query(`SELECT 1 FROM onec_alert_notification_policies WHERE group_code = 'agent_offline' FOR UPDATE`);
      const tick = notifier.tick();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await resolve('silent:race');
      await patch.query('COMMIT');
      await tick;
    } finally {
      patch.release();
    }
    expect((await external()).map((row) => [row.attempt, row.status, row.channel_state])).toEqual([[1, 'queued', 'cancelled']]);
    expect(await deliveries()).toHaveLength(1);
  });

  it('a member locked by a writer defers the redelivery to the next tick', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp}', notify_resolved = false`);
    await raise('agent_silent', 'silent:locked');
    await notifier.tick();
    const epoch = await channel.startEpoch(new Date());
    await channel.cancelEarlierEpochs(epoch, new Date());
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT 1 FROM onec_alert_episodes FOR UPDATE`);
      await notifier.tick();
      expect((await external()).map((row) => [row.attempt, row.status, row.channel_state])).toEqual([[1, 'queued', null]]);
      await writer.query('COMMIT');
    } finally {
      writer.release();
    }
    await notifier.tick();
    expect((await external()).map((row) => [row.attempt, row.status])).toEqual([[1, 'superseded'], [2, 'queued']]);
  });

  it('a recovery notice held by quiet hours is redelivered after 6 h, within its first lifetime (R1-2)', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp}'`);
    await raise('agent_silent', 'silent:night');
    await notifier.tick();
    await pool.query(`UPDATE whatsapp_notification_deliveries SET state = 'sent', sent_at = now(), finished_at = now()`);
    await resolve('silent:night');
    await notifier.tick();
    await due();
    await notifier.tick();
    // As if the recovery was queued at night 7 h ago with quiet hours: its first lifetime ends in 5 h.
    const until = new Date(Date.now() + 5 * 60 * 60_000);
    await pool.query(`UPDATE onec_alert_dispatches SET created_at = now() - interval '7 hours' WHERE stage = 'resolved'`);
    await pool.query(`UPDATE onec_alert_dispatch_recipients r SET expires_at = $1 FROM onec_alert_dispatches d
      WHERE d.dispatch_id = r.dispatch_id AND d.stage = 'resolved' AND r.channel = 'whatsapp'`, [until]);
    const epoch = await channel.startEpoch(new Date());
    await channel.cancelEarlierEpochs(epoch, new Date());
    await notifier.tick();
    const rows = await q<{ attempt: number; status: string; expires_at: Date }>(`SELECT r.attempt, r.status, r.expires_at FROM onec_alert_dispatch_recipients r
      JOIN onec_alert_dispatches d USING (dispatch_id) WHERE d.stage = 'resolved' AND r.channel = 'whatsapp' ORDER BY r.attempt`);
    expect(rows.map((row) => [row.attempt, row.status])).toEqual([[1, 'superseded'], [2, 'queued']]);
    expect(rows[1].expires_at.getTime()).toBe(until.getTime());
    const [redelivered] = await q<{ expires_at: Date }>(`SELECT expires_at FROM whatsapp_notification_deliveries WHERE idempotency_key LIKE '%:attempt2'`);
    expect(redelivered.expires_at.getTime()).toBe(until.getTime());
  });

  it('a dispatch older than a week still has its fresh deliveries cancelled by closing and by a chat change (R2-1)', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp,whatsapp_chat}', whatsapp_chat_id = '${CHAT}', delay_minutes = 10, notify_resolved = false, repeat_minutes = NULL`);
    await raise('agent_silent', 'silent:old');
    await notifier.tick();
    // The dispatcher stood still for 8 days with the alarm open; the delay is long over.
    await pool.query(`UPDATE onec_alert_dispatches SET created_at = now() - interval '8 days', external_due_at = now() - interval '8 days'`);
    await notifier.tick();
    expect((await deliveries()).map((row) => [row.recipient_kind, row.state])).toEqual([['user', 'queued'], ['chat', 'queued']]);
    const [policy] = (await settings.overview()).groups.filter((group) => group.code === 'agent_offline').map((group) => group.policy);
    await settings.updatePolicy('agent_offline', String(policy.version), {
      importance: policy.importance, recipientRoleCodes: policy.recipientRoleCodes, recipientUserIds: policy.recipientUserIds,
      externalChannels: ['whatsapp', 'whatsapp_chat'], whatsappChatId: OTHER_CHAT, whatsappChatName: 'Офис', delayMinutes: 10,
      repeatMinutes: policy.repeatMinutes, notifyResolved: false, quietHours: null, criticalIgnoresQuietHours: true,
    }, actor(['onec.view', 'onec.manage', 'whatsapp.manage']), ctx);
    expect((await deliveries()).map((row) => [row.recipient_kind, row.state])).toEqual([['user', 'queued'], ['chat', 'cancelled']]);
    await resolve('silent:old');
    await notifier.tick();
    expect((await deliveries()).map((row) => [row.recipient_kind, row.state, row.reason])).toEqual([
      ['user', 'cancelled', 'cancelled_by_source'],
      ['chat', 'cancelled', 'cancelled_by_source'],
    ]);
  });

  it('a delivery that failed before the closing keeps the channel\'s reason (R2-2)', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp_chat}', whatsapp_chat_id = '${CHAT}', notify_resolved = false`);
    await raise('agent_silent', 'silent:failed');
    await notifier.tick();
    // The channel finished it before the dispatcher looked: the chat is gone.
    await pool.query(`UPDATE whatsapp_notification_deliveries SET state = 'failed', reason = 'CHAT_NOT_FOUND', finished_at = now()`);
    await resolve('silent:failed');
    await notifier.tick();
    expect(await q(`SELECT channel_state, channel_reason FROM onec_alert_dispatch_recipients WHERE channel = 'whatsapp'`)).toEqual([
      { channel_state: 'failed', channel_reason: 'CHAT_NOT_FOUND' },
    ]);
  });

  it('an alarm opened and closed between two ticks gets the bell and the balloon, but no WhatsApp (R3-1)', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp,whatsapp_chat}', whatsapp_chat_id = '${CHAT}'`);
    await raise('agent_silent', 'silent:blink');
    await resolve('silent:blink');
    await notifier.tick();
    const dispatches = await q<{ stage: string; external_state: string }>(`SELECT stage, external_state FROM onec_alert_dispatches ORDER BY dispatch_id`);
    expect(dispatches[0]).toEqual({ stage: 'opened', external_state: 'suppressed' });
    expect(await q(`SELECT count(*)::int AS n FROM notifications`)).toEqual([{ n: 1 }]);
    const opened = (await external()).filter((row) => row.dispatch_id === '1');
    expect(opened.map((row) => [row.chat_id, row.status, row.skip_reason])).toEqual([
      [null, 'skipped', 'RESOLVED_BEFORE_SEND'],
      [CHAT, 'skipped', 'RESOLVED_BEFORE_SEND'],
    ]);
    expect((await deliveries()).filter((row) => row.idempotency_key.startsWith('onec-alert:1:'))).toEqual([]);
  });

  it('a closed alarm is not redelivered after a restart', async () => {
    await setPolicy('agent_offline', `external_channels = '{whatsapp}', notify_resolved = false`);
    await raise('agent_silent', 'silent:e');
    await notifier.tick();
    const epoch = await channel.startEpoch(new Date());
    await channel.cancelEarlierEpochs(epoch, new Date());
    await resolve('silent:e');
    await notifier.tick();
    expect((await external()).map((row) => [row.attempt, row.status, row.channel_state])).toEqual([[1, 'queued', 'cancelled']]);
    expect(await deliveries()).toHaveLength(1);
  });

  it('quiet hours postpone an important alert to their end; the lifetime starts there', async () => {
    // Quiet all day except one minute: the current Almaty minute is inside for sure.
    const almaty = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const later = almaty.format(new Date(Date.now() + 3 * 60_000));
    const earlier = almaty.format(new Date(Date.now() - 3 * 60_000));
    await setPolicy('sync', `external_channels = '{whatsapp}', quiet_hours = '${earlier}-${later}'`);
    await raise('etl_entity_failed', 'etl:q', 'warning');
    await pool.query(`UPDATE onec_alert_episodes SET created_at = now() - interval '5 minutes'`);
    await notifier.tick();
    const [row] = await deliveries();
    expect(row.not_before.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(row.expires_at.getTime() - row.not_before.getTime()).toBe(2 * 60 * 60_000);
  });

  it('on stage (WhatsApp off) every external row is recorded as skipped and nothing waits', async () => {
    wa.enabled = false;
    await setPolicy('agent_offline', `external_channels = '{whatsapp}'`);
    await raise('agent_silent', 'silent:f');
    await notifier.tick();
    expect((await external()).map((row) => [row.status, row.skip_reason, row.channel_state])).toEqual([['skipped', 'WHATSAPP_DISABLED', 'skipped']]);
  });

  it('the policy: the chat needs whatsapp.manage, the chat channel needs a chat; a changed chat cancels the old one', async () => {
    const [current] = (await settings.overview()).groups.filter((group) => group.code === 'other');
    const base = { ...current.policy } as Record<string, unknown>;
    const body = {
      importance: base.importance, recipientRoleCodes: base.recipientRoleCodes, recipientUserIds: base.recipientUserIds,
      delayMinutes: 0, repeatMinutes: base.repeatMinutes, notifyResolved: true, quietHours: null, criticalIgnoresQuietHours: true,
    };
    const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));
    expect(await code(settings.updatePolicy('other', '1', { ...body, externalChannels: ['whatsapp_chat'], whatsappChatId: CHAT, whatsappChatName: 'Цех' },
      actor(['onec.view', 'onec.manage']), ctx))).toBe('ONEC_ALERT_WHATSAPP_MANAGE_REQUIRED');
    expect(await code(settings.updatePolicy('other', '1', { ...body, externalChannels: ['whatsapp_chat'] }, actor(['onec.view', 'onec.manage']), ctx)))
      .toBe('ONEC_ALERT_WHATSAPP_CHAT_REQUIRED');
    expect(await code(settings.updatePolicy('other', '1', { ...body, externalChannels: ['whatsapp_chat'], whatsappChatId: 'not-a-chat' },
      actor(['onec.view', 'onec.manage', 'whatsapp.manage']), ctx))).toBe('VALIDATION_FAILED');
    const saved = await settings.updatePolicy('other', '1', { ...body, externalChannels: ['whatsapp', 'whatsapp_chat'], whatsappChatId: CHAT, whatsappChatName: 'Цех' },
      actor(['onec.view', 'onec.manage', 'whatsapp.manage']), ctx);
    expect(saved.policy).toMatchObject({ externalChannels: ['whatsapp', 'whatsapp_chat'], whatsappChatId: CHAT, whatsappChatName: 'Цех', version: 2 });

    await raise('some_future_kind', 'future:1');
    await pool.query(`UPDATE onec_alert_episodes SET created_at = now() - interval '5 minutes'`);
    await notifier.tick();
    expect((await deliveries()).map((row) => [row.recipient_kind, row.state])).toEqual([['user', 'queued'], ['chat', 'queued']]);

    // Without whatsapp.manage the rest can still be changed while the chat is kept (absent fields keep it).
    const kept = await settings.updatePolicy('other', '2', { ...body, externalChannels: ['whatsapp', 'whatsapp_chat'] }, actor(['onec.view', 'onec.manage']), ctx);
    expect(kept.policy).toMatchObject({ whatsappChatId: CHAT, version: 3 });
    // Another chat: the unstarted delivery to the old one is cancelled in the same transaction; the personal one stays.
    await settings.updatePolicy('other', '3', { ...body, externalChannels: ['whatsapp', 'whatsapp_chat'], whatsappChatId: OTHER_CHAT, whatsappChatName: 'Офис' },
      actor(['onec.view', 'onec.manage', 'whatsapp.manage']), ctx);
    expect((await deliveries()).map((row) => [row.recipient_kind, row.state, row.reason])).toEqual([
      ['user', 'queued', null],
      ['chat', 'cancelled', 'cancelled_by_source'],
    ]);
    // Removing the personal channel cancels the personal delivery.
    await settings.updatePolicy('other', '4', { ...body, externalChannels: ['whatsapp_chat'] }, actor(['onec.view', 'onec.manage']), ctx);
    expect((await deliveries()).map((row) => row.state)).toEqual(['cancelled', 'cancelled']);
    const [audit] = await q<{ metadata_json: { whatsappCancelled: number }; diff_json: Record<string, unknown> }>(
      `SELECT metadata_json, diff_json FROM audit_log WHERE event = 'onec.alert_notification_policy.updated' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.metadata_json.whatsappCancelled).toBe(1);
  });

  it('«Проверить» sends WhatsApp to the caller and to the chat; «Последние оповещения» shows the channel states', async () => {
    await setPolicy('sync', `external_channels = '{whatsapp,whatsapp_chat}', whatsapp_chat_id = '${CHAT}'`);
    const test = await settings.sendTest('sync', actor(['onec.view', 'onec.manage']), ctx);
    expect(test.whatsapp).toMatchObject([
      { target: 'self', state: 'queued', reason: null },
      { target: 'chat', state: 'queued', reason: null },
    ]);
    // The channel's deliveries carry the request's correlation id; the command's audit names them (R1-3).
    const ids = test.whatsapp.map((item) => item.deliveryId);
    expect(await q(`SELECT correlation_id FROM whatsapp_notification_deliveries WHERE delivery_id = ANY($1::uuid[])`, [ids])).toEqual([
      { correlation_id: 'e2e-correlation' },
      { correlation_id: 'e2e-correlation' },
    ]);
    const [testAudit] = await q<{ after_json: { whatsapp: { deliveryId: string }[] } }>(`SELECT after_json FROM audit_log WHERE event = 'onec.alert_notification.test_sent'`);
    expect(testAudit.after_json.whatsapp.map((item) => item.deliveryId).sort()).toEqual([...ids].sort());
    await setPolicy('agent_offline', `external_channels = '{whatsapp}', recipient_user_ids = '{${MANAGER},${NO_PHONE}}'`);
    await raise('agent_silent', 'silent:g');
    await notifier.tick();
    const recent = await settings.recent('5');
    expect(recent.data[0].external.map((row) => [row.userId, row.state, row.reason])).toEqual([
      [MANAGER, 'queued', null],
      [NO_PHONE, 'skipped', 'NO_WORK_PHONE'],
    ]);
    const overview = await settings.overview();
    expect(overview.externalChannelsAvailable).toEqual(['whatsapp', 'whatsapp_chat']);
    expect(overview.groups.find((group) => group.code === 'agent_offline')?.withoutWorkPhone).toEqual([{ id: NO_PHONE, name: 'nophone' }]);
  });
});
