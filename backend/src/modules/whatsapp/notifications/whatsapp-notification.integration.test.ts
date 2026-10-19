import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { WahaClient } from '../waha.client';
import type { WhatsAppRuntimeConfigService } from '../whatsapp-runtime-config.service';
import type { WhatsAppService } from '../whatsapp.service';
import { installAuthorizationSnapshot, withLocalAuthorizationSnapshot } from '../order-send/authorization-snapshot.test-util';
import { WhatsAppNotificationPort } from './whatsapp-notification.port';
import { WhatsAppNotificationRepository } from './whatsapp-notification.repository';
import { WhatsAppNotificationWorker } from './whatsapp-notification-worker.service';
import type { WhatsAppNotificationRequest } from './whatsapp-notification.types';

// Real PostgreSQL in an isolated schema: set WHATSAPP_BROADCAST_TEST_DATABASE_URL (or TEST_DATABASE_URL).
const databaseUrl = process.env.WHATSAPP_BROADCAST_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const GROUP = '120363338054016575@g.us';
const OLD_GROUP = '77012345678-1612345678@g.us';
const PHONE = '77014952060';
const OPERATOR = 21; // has onec.view, employee 301 with a work phone
const NO_RIGHT = 22; // no onec.view, employee 302 with a work phone
const NO_PHONE = 23; // has onec.view, employee 303 without a phone

describe.skipIf(!databaseUrl)('WhatsApp notification channel (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_wa_notify_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let database: DatabaseService;
  let repository: WhatsAppNotificationRepository;
  let port: WhatsAppNotificationPort;
  let worker: WhatsAppNotificationWorker;
  const runtime = { enabled: true, relayOwner: 'in_process' as string };
  let now = new Date('2026-10-20T08:00:00Z');
  const sent: Array<{ chatId: string; text: string }> = [];
  let sendBehaviour: () => Promise<{ messageId?: string }> = async () => ({ messageId: `msg_${sent.length}` });
  let checkBehaviour: (phone: string) => Promise<{ exists: boolean; chatId: string | null }> = async (phone) => ({ exists: true, chatId: `${phone}@c.us` });
  let groups: string[] = [GROUP];
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);
  let local: (text: string) => string;
  /** Awaited inside the next worker transaction before its COMMIT (holds its locks while the test acts). */
  let holdNextCommit: (() => Promise<void>) | null = null;

  const makeWorker = () => {
    const runtimeConfig = { getConfig: () => ({ ...runtime, relayStaleLockMs: 10 * 60_000 }) } as unknown as WhatsAppRuntimeConfigService;
    const waha = {
      checkPhone: (phone: string) => checkBehaviour(phone),
      sendText: async (chatId: string, text: string) => {
        const result = await sendBehaviour();
        sent.push({ chatId, text });
        return result;
      },
    } as unknown as WahaClient;
    const whatsapp = {
      listGroups: async () => ({ groups: groups.map((id) => ({ id, name: id, participantCount: 3, announceOnly: false, communityParent: false, suspended: false })),
        truncated: false, fetchedAt: now.toISOString(), cached: true }),
    } as unknown as WhatsAppService;
    const created = new WhatsAppNotificationWorker(repository, database, runtimeConfig, waha, whatsapp);
    created.clock = () => now;
    return created;
  };

  /** A consumer transaction on its own connection (BEGIN … handler … COMMIT/ROLLBACK). */
  const inTx = async <T>(handler: (tx: { query: PoolClient['query'] }) => Promise<T>, finish: 'commit' | 'rollback' = 'commit'): Promise<T> => {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      try {
        const value = await handler({ query: ((text: string, params: unknown[] = []) => connection.query(local(text), params)) as never });
        if (holdNextCommit && finish === 'commit') { const hold = holdNextCommit; holdNextCommit = null; await hold(); }
        await connection.query(finish === 'commit' ? 'COMMIT' : 'ROLLBACK');
        return value;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    } finally {
      connection.release();
    }
  };
  /** An open consumer transaction, committed or rolled back by the test. */
  const openTx = async () => {
    const connection = await pool.connect();
    await connection.query('BEGIN');
    const tx = { query: ((text: string, params: unknown[] = []) => connection.query(local(text), params)) as never };
    return { tx, commit: async () => { await connection.query('COMMIT'); connection.release(); },
      rollback: async () => { await connection.query('ROLLBACK'); connection.release(); } };
  };

  const request = (overrides: Partial<WhatsAppNotificationRequest> = {}): WhatsAppNotificationRequest => ({
    idempotencyKey: `onec-alert:${randomUUID()}`, recipient: { userId: OPERATOR }, title: 'Агент 1С молчит', text: 'Нет связи 15 минут',
    level: 'warning', sourceType: 'onec_alert', sourceId: 77, requiredPermission: 'onec.view', ...overrides,
  });
  const enqueue = (overrides: Partial<WhatsAppNotificationRequest> = {}) => inTx((tx) => port.enqueue(tx as never, request(overrides)));
  const code = async (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));
  const row = async (id: string) => (await q('SELECT * FROM whatsapp_notification_deliveries WHERE delivery_id = $1', [id])).rows[0];
  const tick = async (ms = 11_000) => { now = new Date(now.getTime() + ms); await worker.work(); };

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}",public`);
    await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public`);
    await q(`CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public`);
    await q(`CREATE TABLE audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event text NOT NULL,entity_type text,entity_id text,user_id bigint,
      username text,role_code text,role text,request_id text NOT NULL,source text,related_order_id bigint,related_client_id bigint,related_payment_id bigint,
      related_production_event_id bigint,related_deadline_id bigint,related_user_id bigint,status_field text,status_id bigint,status_name text,status_code text,
      stage_code text,before_json jsonb,after_json jsonb,diff_json jsonb,metadata_json jsonb,created_at timestamptz DEFAULT now());
      CREATE TABLE audit_log_related_entity(audit_id uuid NOT NULL,entity_type text NOT NULL,entity_id bigint NOT NULL,PRIMARY KEY(audit_id,entity_type,entity_id));
      CREATE TABLE roles(role_id int PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE users(user_id bigint PRIMARY KEY, username citext, role_id int REFERENCES roles, is_active boolean NOT NULL DEFAULT true, employee_id bigint);
      INSERT INTO roles VALUES (1, true), (10, true);
      CREATE TABLE permissions_state(id boolean PRIMARY KEY DEFAULT true, version int NOT NULL DEFAULT 1);
      INSERT INTO permissions_state VALUES (true, 1);
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE role_permissions(role_id int, permission_name text, is_enabled boolean NOT NULL DEFAULT true, PRIMARY KEY(role_id, permission_name));
      CREATE TABLE role_policy_scopes(role_id int, scope_key text, scope_value text, PRIMARY KEY(role_id, scope_key));
      INSERT INTO permissions_catalog(permission_name) VALUES ('onec.view'), ('orders.view');
      INSERT INTO role_permissions(role_id, permission_name) VALUES (1, 'onec.view'), (1, 'orders.view'), (10, 'orders.view');
      CREATE TABLE employees(employee_id bigint PRIMARY KEY, full_name text, is_active boolean NOT NULL DEFAULT true);
      INSERT INTO employees VALUES (301, 'Тест Оператор', true), (302, 'Тест Менеджер', true), (303, 'Тест Без телефона', true);
      INSERT INTO users VALUES (${OPERATOR}, 'notify-operator', 1, true, 301), (${NO_RIGHT}, 'notify-manager', 10, true, 302), (${NO_PHONE}, 'notify-nophone', 1, true, 303);
      CREATE TABLE employee_work_contacts(contact_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, employee_id bigint NOT NULL REFERENCES employees,
        kind text NOT NULL, value text NOT NULL, value_normalized text NOT NULL, is_primary boolean NOT NULL DEFAULT false, position smallint NOT NULL DEFAULT 0);
      INSERT INTO employee_work_contacts(employee_id, kind, value, value_normalized, is_primary) VALUES
        (301, 'phone', '+7 701 495 20 60', '${PHONE}', true), (302, 'phone', '+7 701 000 00 02', '77010000002', true), (303, 'email', 'a@b.kz', 'a@b.kz', true);
      CREATE TABLE whatsapp_broadcast_control(singleton_id smallint PRIMARY KEY DEFAULT 1, paused boolean NOT NULL DEFAULT false);
      INSERT INTO whatsapp_broadcast_control VALUES (1, false);`);
    await installAuthorizationSnapshot((sql) => q(sql), schema,
      await readFile(new URL('../../../../db/migrations/248_authorization_snapshot.sql', import.meta.url), 'utf8'));
    await q(await readFile(new URL('../../../../db/migrations/261_whatsapp_notification_deliveries.sql', import.meta.url), 'utf8'));
    local = withLocalAuthorizationSnapshot(schema);
    database = {
      isConfigured: true,
      query: <T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(local(text), [...params]),
      withAdvisoryLock: async <T>(key: string, handler: (assertOwned: () => Promise<void>) => Promise<T>) => {
        const connection = await pool.connect();
        try {
          const acquired = (await connection.query<{ acquired: boolean }>(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) acquired`, [`${schema}:${key}`])).rows[0]?.acquired;
          if (!acquired) return null;
          try { return await handler(async () => undefined); } finally { await connection.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`${schema}:${key}`]); }
        } finally {
          connection.release();
        }
      },
      transaction: <T>(handler: (tx: unknown) => Promise<T>) => inTx(handler as never),
    } as unknown as DatabaseService;
    repository = new WhatsAppNotificationRepository(database);
    port = new WhatsAppNotificationPort(repository, { getConfig: () => runtime } as unknown as WhatsAppRuntimeConfigService);
    port.clock = () => now;
    worker = makeWorker();
    expect(await worker.ensureEpoch()).toBe(true);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      try { await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { client.release(); }
    }
    await pool?.end();
  });

  beforeEach(async () => {
    // Every test starts with an empty queue, an open gate and nothing paused.
    await q(`UPDATE whatsapp_notification_deliveries SET state = 'cancelled', reason = 'test_reset', finished_at = now() WHERE state IN ('queued', 'sending')`);
    await q(`UPDATE whatsapp_broadcast_control SET paused = false`);
    now = new Date(now.getTime() + 2 * 60 * 60_000);
    sent.length = 0;
    runtime.enabled = true; runtime.relayOwner = 'in_process';
    sendBehaviour = async () => ({ messageId: `msg_${randomUUID()}` });
    checkBehaviour = async (phone) => ({ exists: true, chatId: `${phone}@c.us` });
    groups = [GROUP];
  });

  it('queues once per key: a repeat returns the same delivery, another message under the key is refused', async () => {
    const input = request();
    const first = await inTx((tx) => port.enqueue(tx as never, input));
    expect(first).toMatchObject({ created: true, state: 'queued', reason: null });
    const again = await inTx((tx) => port.enqueue(tx as never, input));
    expect(again).toEqual({ ...first, created: false });
    expect(await code(inTx((tx) => port.enqueue(tx as never, { ...input, text: 'другое' })))).toBe('WHATSAPP_NOTIFICATION_KEY_REUSED');
    const stored = await row(first.deliveryId);
    expect(stored).toMatchObject({ recipient_kind: 'user', phone_normalized: PHONE, body: '*Агент 1С молчит*\n\nНет связи 15 минут', source_id: '77' });
    expect(stored.correlation_id).toBe(`whatsapp-notification:${first.deliveryId}`);
  });

  it('records the synchronous skips and never delivers them', async () => {
    runtime.enabled = false;
    expect(await enqueue()).toMatchObject({ state: 'skipped', reason: 'WHATSAPP_DISABLED' });
    runtime.enabled = true; runtime.relayOwner = 'none';
    expect(await enqueue()).toMatchObject({ state: 'skipped', reason: 'WHATSAPP_DISABLED' });
    runtime.relayOwner = 'in_process';
    expect(await enqueue({ recipient: { userId: 999 } })).toMatchObject({ state: 'skipped', reason: 'USER_INACTIVE' });
    expect(await enqueue({ recipient: { userId: NO_RIGHT } })).toMatchObject({ state: 'skipped', reason: 'PERMISSION_MISSING' });
    expect(await enqueue({ recipient: { userId: NO_PHONE } })).toMatchObject({ state: 'skipped', reason: 'NO_WORK_PHONE' });
    // Without a required permission the manager is reached.
    expect(await enqueue({ recipient: { userId: NO_RIGHT }, requiredPermission: null })).toMatchObject({ state: 'queued' });
    await tick();
    expect(sent.map((item) => item.chatId)).toEqual(['77010000002@c.us']);
  });

  it('validates the request: one recipient, group id forms of the groups picker, known permission, length', async () => {
    expect(await code(enqueue({ recipient: { chatId: 'bad' } }))).toBe('WHATSAPP_NOTIFICATION_INVALID');
    expect(await code(enqueue({ recipient: { chatId: GROUP }, requiredPermission: null }))).toBe('ok');
    expect(await code(enqueue({ recipient: { chatId: OLD_GROUP }, requiredPermission: null }))).toBe('ok');
    expect(await code(enqueue({ recipient: { chatId: GROUP } }))).toBe('WHATSAPP_NOTIFICATION_INVALID');
    expect(await code(enqueue({ requiredPermission: 'no.such' as never }))).toBe('WHATSAPP_NOTIFICATION_INVALID');
    expect(await code(enqueue({ text: 'x'.repeat(4096) }))).toBe('WHATSAPP_NOTIFICATION_TOO_LONG');
    expect(await code(enqueue({ expiresAt: new Date(now.getTime() + 8 * 24 * 60 * 60_000) }))).toBe('WHATSAPP_NOTIFICATION_INVALID');
  });

  it('delivers to the work phone, audits without the number or the text', async () => {
    const queued = await enqueue({ correlationId: 'onec-tick:1' });
    await tick();
    expect(sent).toEqual([{ chatId: `${PHONE}@c.us`, text: '*Агент 1С молчит*\n\nНет связи 15 минут' }]);
    expect(await row(queued.deliveryId)).toMatchObject({ state: 'sent', attempts: 1, destination_chat_id: `${PHONE}@c.us` });
    const audit = (await q(`SELECT event, request_id, related_user_id, metadata_json::text AS meta FROM audit_log WHERE entity_id = $1 ORDER BY created_at, event`,
      [queued.deliveryId])).rows;
    expect(audit.map((item) => item.event).sort()).toEqual(['whatsapp.notification.queued', 'whatsapp.notification.sent']);
    for (const item of audit) {
      expect(item.request_id).toBe('onec-tick:1');
      expect(Number(item.related_user_id)).toBe(OPERATOR);
      expect(item.meta).not.toContain('4952060');
      expect(item.meta).not.toContain('молчит');
    }
    const related = (await q(`SELECT r.entity_type, r.entity_id FROM audit_log_related_entity r JOIN audit_log a USING (audit_id) WHERE a.entity_id = $1`,
      [queued.deliveryId])).rows;
    expect(related).toContainEqual({ entity_type: 'onec_alert', entity_id: '77' });
    expect(await port.statuses(database as never, [queued.deliveryId])).toEqual([
      expect.objectContaining({ deliveryId: queued.deliveryId, state: 'sent', reason: null }),
    ]);
  });

  it('a group: delivered while it is one of the session groups, failed when it is gone', async () => {
    const ok = await enqueue({ recipient: { chatId: GROUP }, requiredPermission: null });
    await tick();
    expect(sent.map((item) => item.chatId)).toEqual([GROUP]);
    expect((await row(ok.deliveryId)).state).toBe('sent');
    groups = [];
    const gone = await enqueue({ recipient: { chatId: OLD_GROUP }, requiredPermission: null });
    await tick();
    expect(await row(gone.deliveryId)).toMatchObject({ state: 'failed', reason: 'CHAT_NOT_FOUND' });
  });

  it('a consumer rollback leaves neither the delivery nor its audit', async () => {
    const input = request();
    const result = await inTx((tx) => port.enqueue(tx as never, input), 'rollback');
    expect(await row(result.deliveryId)).toBeUndefined();
    expect((await q('SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1', [result.deliveryId])).rows[0].n).toBe(0);
  });

  it('a new epoch cancels what an earlier one left queued; what is queued after it is delivered', async () => {
    const old = await enqueue();
    const next = makeWorker();
    expect(await next.ensureEpoch()).toBe(true);
    // The epoch change itself is one statement; the next tick of the new process cancels the old row.
    expect((await row(old.deliveryId)).state).toBe('queued');
    await next.work();
    expect(await row(old.deliveryId)).toMatchObject({ state: 'cancelled', reason: 'delivery_gap' });
    // The previous process no longer delivers and leaves the fresh row alone; the new one delivers it.
    const fresh = await enqueue();
    await worker.work();
    expect(await row(fresh.deliveryId)).toMatchObject({ state: 'queued', attempts: 0 });
    expect(sent).toEqual([]);
    worker = next;
    await tick();
    expect((await row(fresh.deliveryId)).state).toBe('sent');
  });

  it('an enqueue in flight while the epoch changes: the epoch waits, then cancels it; a late epoch row is cancelled at the intent', async () => {
    const open = await openTx();
    const pending = await port.enqueue(open.tx as never, request());
    const next = makeWorker();
    const starting = next.ensureEpoch();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await open.commit();
    expect(await starting).toBe(true);
    await next.work();
    expect(await row(pending.deliveryId)).toMatchObject({ state: 'cancelled', reason: 'delivery_gap' });
    worker = next;
    // A row of an earlier epoch that slipped past the mass cancel (simulated) is cancelled before any send.
    const late = await enqueue();
    await q('UPDATE whatsapp_notification_deliveries SET delivery_epoch = delivery_epoch - 1 WHERE delivery_id = $1', [late.deliveryId]);
    await tick();
    expect(await row(late.deliveryId)).toMatchObject({ state: 'cancelled', reason: 'delivery_gap' });
    expect(sent).toEqual([]);
  });

  it('a process of an earlier epoch decides nothing: its negative WAHA view leaves the fresh row to the new process', async () => {
    const next = makeWorker();
    expect(await next.ensureEpoch()).toBe(true);
    const fresh = await enqueue({ recipient: { chatId: GROUP }, requiredPermission: null });
    groups = []; // the old process's group view does not have the new group yet
    checkBehaviour = async () => ({ exists: false, chatId: null });
    now = new Date(now.getTime() + 11_000);
    await worker.work();
    expect(await row(fresh.deliveryId)).toMatchObject({ state: 'queued', attempts: 0, destination_chat_id: null });
    // Even a direct pre-intent decision of the old epoch is refused.
    await repository.finishBeforeIntent(fresh.deliveryId, worker.currentEpoch() as number, 'failed', 'CHAT_NOT_FOUND', now);
    await repository.setDestination(fresh.deliveryId, worker.currentEpoch() as number, 'stale@g.us');
    expect(await row(fresh.deliveryId)).toMatchObject({ state: 'queued', destination_chat_id: null });
    groups = [GROUP];
    worker = next;
    await tick();
    expect((await row(fresh.deliveryId)).state).toBe('sent');
  });

  it('startup stays fast with a large queue of an earlier epoch; the backlog is cancelled in batches by ticks', async () => {
    await q(`INSERT INTO whatsapp_notification_deliveries (idempotency_key, request_hash, source_type, correlation_id, recipient_kind, recipient_user_id,
        body, level, delivery_epoch, not_before, expires_at, next_attempt_at, state)
      SELECT 'backlog-' || g, repeat('b', 64), 'onec_alert', 'c', 'user', ${OPERATOR}, 'x', 'info', 0, $1, $2, $2, 'queued'
        FROM generate_series(1, 1500) g`, [now, new Date(now.getTime() + 6 * 60 * 60_000)]);
    const next = makeWorker();
    const started = Date.now();
    expect(await next.ensureEpoch()).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    worker = next;
    for (let i = 0; i < 16; i += 1) await worker.work();
    expect((await q(`SELECT count(*)::int AS n FROM whatsapp_notification_deliveries WHERE idempotency_key LIKE 'backlog-%' AND state = 'queued'`)).rows[0].n).toBe(0);
  }, 60_000);

  it('an old-epoch row outside the cancel batch is never decided by a WAHA preflight', async () => {
    await q(`INSERT INTO whatsapp_notification_deliveries (idempotency_key, request_hash, source_type, correlation_id, recipient_kind, recipient_user_id,
        body, level, delivery_epoch, not_before, expires_at, next_attempt_at, state, created_at)
      SELECT 'old-batch-' || g, repeat('c', 64), 'onec_alert', 'c', 'user', ${OPERATOR}, 'x', 'info', 0, $1, $2, $1, 'queued', $1
        FROM generate_series(1, 150) g`, [now, new Date(now.getTime() + 6 * 60 * 60_000)]);
    const urgent = (await q(`INSERT INTO whatsapp_notification_deliveries (idempotency_key, request_hash, source_type, correlation_id, recipient_kind,
        recipient_user_id, employee_id, employee_contact_id, phone_normalized, body, level, delivery_epoch, not_before, expires_at, next_attempt_at, state, created_at)
      VALUES ('old-urgent-${randomUUID()}', repeat('d', 64), 'onec_alert', 'c', 'user', ${OPERATOR}, 301, 1, '77019990000', 'x', 'error', 0, $1, $2, $1, 'queued', $3)
      RETURNING delivery_id`, [now, new Date(now.getTime() + 6 * 60 * 60_000), new Date(now.getTime() + 1)])).rows[0].delivery_id;
    let calls = 0;
    checkBehaviour = async () => { calls += 1; return { exists: false, chatId: null }; };
    await tick();
    expect(await row(urgent)).toMatchObject({ state: 'queued' });
    for (let i = 0; i < 3; i += 1) await tick();
    expect(await row(urgent)).toMatchObject({ state: 'cancelled', reason: 'delivery_gap' });
    expect(calls).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM whatsapp_notification_deliveries WHERE idempotency_key LIKE 'old-batch-%' AND state <> 'cancelled'`)).rows[0].n).toBe(0);
  });

  it('a group that disappears while the delivery waits for the quota is not written to', async () => {
    const base = now.getTime();
    for (let i = 0; i < 20; i += 1) {
      await q(`INSERT INTO whatsapp_notification_deliveries (idempotency_key, request_hash, source_type, correlation_id, recipient_kind, chat_id,
          body, level, delivery_epoch, not_before, expires_at, next_attempt_at, state, intent_token, intent_at, sent_at, finished_at)
        VALUES ($1, repeat('e', 64), 'onec_alert', 'c', 'chat', '${GROUP}', 'x', 'info', 0, $2, $3, $2, 'sent', gen_random_uuid(), $2, $2, $2)`,
      [`chat-quota-${randomUUID()}`, new Date(base - 30 * 60_000 + i * 1000), new Date(base + 60 * 60_000)]);
    }
    const waiting = await enqueue({ recipient: { chatId: GROUP }, requiredPermission: null, expiresAt: new Date(base + 3 * 60 * 60_000) });
    await tick();
    expect(await row(waiting.deliveryId)).toMatchObject({ state: 'queued', destination_chat_id: GROUP });
    groups = [];
    await tick(40 * 60_000);
    expect(await row(waiting.deliveryId)).toMatchObject({ state: 'failed', reason: 'CHAT_NOT_FOUND' });
    expect(sent).toEqual([]);
  });

  it('cancel then enqueue in one consumer transaction against an epoch change: no deadlock', async () => {
    const old = await enqueue();
    const open = await openTx();
    expect(await port.cancel(open.tx as never, { deliveryId: old.deliveryId })).toMatchObject({ cancelled: true, state: 'cancelled' });
    const next = makeWorker();
    const starting = next.ensureEpoch();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const replacement = await port.enqueue(open.tx as never, request());
    await open.commit();
    expect(await starting).toBe(true);
    await next.work();
    expect(await row(old.deliveryId)).toMatchObject({ state: 'cancelled', reason: 'cancelled_by_source' });
    expect(await row(replacement.deliveryId)).toMatchObject({ state: 'cancelled', reason: 'delivery_gap' });
    worker = next;
  });

  it('cancel: a queued delivery by key; a started one is left as it is', async () => {
    const input = request();
    await inTx((tx) => port.enqueue(tx as never, input));
    expect(await inTx((tx) => port.cancel(tx as never, { idempotencyKey: input.idempotencyKey }))).toMatchObject({ cancelled: true });
    const done = await enqueue();
    await tick();
    expect(await inTx((tx) => port.cancel(tx as never, { deliveryId: done.deliveryId }))).toMatchObject({ cancelled: false, state: 'sent' });
    expect(await inTx((tx) => port.cancel(tx as never, { deliveryId: randomUUID() }))).toBeNull();
  });

  it('re-checks the recipient before sending: revoked permission, deactivation, another phone', async () => {
    const revoked = await enqueue();
    await q(`DELETE FROM role_permissions WHERE role_id = 1 AND permission_name = 'onec.view'`);
    await tick();
    expect(await row(revoked.deliveryId)).toMatchObject({ state: 'cancelled', reason: 'permission_revoked' });
    await q(`INSERT INTO role_permissions(role_id, permission_name) VALUES (1, 'onec.view')`);
    const changed = await enqueue();
    await q(`UPDATE employee_work_contacts SET value_normalized = '77015550000' WHERE employee_id = 301`);
    await tick();
    expect(await row(changed.deliveryId)).toMatchObject({ state: 'cancelled', reason: 'recipient_changed' });
    await q(`UPDATE employee_work_contacts SET value_normalized = '${PHONE}' WHERE employee_id = 301`);
    const inactive = await enqueue();
    await q(`UPDATE users SET is_active = false WHERE user_id = ${OPERATOR}`);
    await tick();
    expect(await row(inactive.deliveryId)).toMatchObject({ state: 'cancelled', reason: 'recipient_removed' });
    await q(`UPDATE users SET is_active = true WHERE user_id = ${OPERATOR}`);
    expect(sent).toEqual([]);
  });

  it('a revocation and the intent: whichever holds the locks first decides', async () => {
    // Revocation first: it holds permissions_state; the intent waits, then sees the permission gone.
    const first = await enqueue();
    const revoke = await openTx();
    await (revoke.tx as { query: (text: string) => Promise<unknown> }).query('UPDATE permissions_state SET version = version + 1');
    await (revoke.tx as { query: (text: string) => Promise<unknown> }).query(`DELETE FROM role_permissions WHERE role_id = 1 AND permission_name = 'onec.view'`);
    const working = tick();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await revoke.commit();
    await working;
    expect(await row(first.deliveryId)).toMatchObject({ state: 'cancelled', reason: 'permission_revoked' });
    await q(`INSERT INTO role_permissions(role_id, permission_name) VALUES (1, 'onec.view')`);
    // Intent first: it holds permissions_state FOR SHARE until its commit; the revocation waits and cannot stop it.
    const second = await enqueue();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const atCommit = new Promise<void>((resolve) => { reached = resolve; });
    holdNextCommit = null;
    const working2 = (async () => {
      now = new Date(now.getTime() + 11_000);
      // The epoch/stale/expiry transactions run first; hold only the intent (the one that writes «sending»).
      const original = repository.createIntent.bind(repository);
      repository.createIntent = async (...args) => { holdNextCommit = async () => { reached(); await held; }; return original(...args); };
      try { await worker.work(); } finally { repository.createIntent = original; }
    })();
    await atCommit;
    let revoked = false;
    const revoking = q('UPDATE permissions_state SET version = version + 1').then(() => { revoked = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(revoked).toBe(false);
    release();
    await working2;
    await revoking;
    expect((await row(second.deliveryId)).state).toBe('sent');
  });

  it('two transactions with one key: the second waits and returns the first delivery', async () => {
    const input = request();
    const a = await openTx();
    const first = await port.enqueue(a.tx as never, input);
    const b = await openTx();
    const second = port.enqueue(b.tx as never, input);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await a.commit();
    expect(await second).toMatchObject({ deliveryId: first.deliveryId, created: false });
    await b.commit();
    expect((await q('SELECT count(*)::int AS n FROM whatsapp_notification_deliveries WHERE idempotency_key = $1', [input.idempotencyKey])).rows[0].n).toBe(1);
  });

  it('a repeat after the lifetime and after the purge still returns the stored delivery', async () => {
    const input = request({ expiresAt: new Date(now.getTime() + 60 * 60_000) });
    const first = await inTx((tx) => port.enqueue(tx as never, input));
    await tick();
    now = new Date(now.getTime() + 2 * 60 * 60_000);
    expect(await inTx((tx) => port.enqueue(tx as never, input))).toMatchObject({ deliveryId: first.deliveryId, created: false });
    now = new Date(now.getTime() + 31 * 24 * 60 * 60_000);
    await worker.cleanup();
    expect(await inTx((tx) => port.enqueue(tx as never, input))).toMatchObject({ deliveryId: first.deliveryId, created: false, state: 'sent' });
  });

  it('the lifetime runs out while the intent waits for the recipient locks: not sent', async () => {
    const queued = await enqueue({ expiresAt: new Date(now.getTime() + 20_000) });
    const lock = await openTx();
    await (lock.tx as { query: (text: string) => Promise<unknown> }).query(`SELECT 1 FROM users WHERE user_id = ${OPERATOR} FOR UPDATE`);
    const working = tick();
    await new Promise((resolve) => setTimeout(resolve, 300));
    now = new Date(now.getTime() + 30_000);
    await lock.commit();
    await working;
    expect(await row(queued.deliveryId)).toMatchObject({ state: 'cancelled', reason: 'expired' });
    expect(sent).toEqual([]);
  });

  it('settle only by its own token: a wrong or repeated settle changes nothing', async () => {
    const queued = await enqueue();
    const intent = await repository.createIntent(queued.deliveryId, worker.currentEpoch() as number, () => now);
    expect(intent).toBeNull(); // no destination yet
    await q(`UPDATE whatsapp_notification_deliveries SET destination_chat_id = '${PHONE}@c.us' WHERE delivery_id = $1`, [queued.deliveryId]);
    const ready = await repository.createIntent(queued.deliveryId, worker.currentEpoch() as number, () => now);
    expect(ready).not.toBeNull();
    expect(await repository.settle(queued.deliveryId, randomUUID(), { state: 'sent', providerMessageId: 'x' }, now)).toBe(false);
    expect((await row(queued.deliveryId)).state).toBe('sending');
    expect(await repository.settle(queued.deliveryId, ready!.token, { state: 'sent', providerMessageId: 'x' }, now)).toBe(true);
    expect(await repository.settle(queued.deliveryId, ready!.token, { state: 'failed', reason: 'WAHA_REJECTED' }, now)).toBe(false);
    expect(await row(queued.deliveryId)).toMatchObject({ state: 'sent', provider_message_id: 'x' });
  });

  it('at most 20 an hour to one recipient: the 21st waits for the oldest to leave the hour', async () => {
    const base = now.getTime();
    for (let i = 0; i < 20; i += 1) {
      await q(`INSERT INTO whatsapp_notification_deliveries (idempotency_key, request_hash, source_type, correlation_id, recipient_kind, recipient_user_id,
          body, level, delivery_epoch, not_before, expires_at, next_attempt_at, state, intent_token, intent_at, sent_at, finished_at)
        VALUES ($1, repeat('a', 64), 'onec_alert', 'c', 'user', ${OPERATOR}, 'x', 'info', 0, $2, $3, $2, 'sent', gen_random_uuid(), $2, $2, $2)`,
      [`quota-${randomUUID()}`, new Date(base - 50 * 60_000 + i * 60_000), new Date(base + 60 * 60_000)]);
    }
    const queued = await enqueue();
    await tick();
    const waiting = await row(queued.deliveryId);
    expect(waiting.state).toBe('queued');
    expect(waiting.next_attempt_at.getTime()).toBe(base - 50 * 60_000 + 60 * 60_000 + 1);
    // Another recipient is not held back.
    const other = await enqueue({ recipient: { userId: NO_RIGHT }, requiredPermission: null });
    await tick();
    expect((await row(other.deliveryId)).state).toBe('sent');
  });

  it('paused: no WAHA call, no final state; expired rows are finished whatever their priority', async () => {
    let calls = 0;
    checkBehaviour = async () => { calls += 1; return { exists: false, chatId: null }; };
    await q('UPDATE whatsapp_broadcast_control SET paused = true');
    const longError = await enqueue({ level: 'error', expiresAt: new Date(now.getTime() + 5 * 60 * 60_000) });
    const shortInfo = await enqueue({ level: 'info', expiresAt: new Date(now.getTime() + 60_000) });
    await tick();
    await tick(2 * 60_000);
    expect(calls).toBe(0);
    expect((await row(longError.deliveryId)).state).toBe('queued');
    expect(await row(shortInfo.deliveryId)).toMatchObject({ state: 'cancelled', reason: 'expired' });
    await q('UPDATE whatsapp_broadcast_control SET paused = false');
  });

  it('lifetime, quiet hours and the pause', async () => {
    const later = await enqueue({ notBefore: new Date(now.getTime() + 30 * 60_000), expiresAt: new Date(now.getTime() + 60 * 60_000) });
    await tick();
    expect((await row(later.deliveryId)).state).toBe('queued');
    await q('UPDATE whatsapp_broadcast_control SET paused = true');
    await tick(31 * 60_000);
    expect((await row(later.deliveryId)).state).toBe('queued');
    await tick(30 * 60_000);
    expect(await row(later.deliveryId)).toMatchObject({ state: 'cancelled', reason: 'expired' });
    await q('UPDATE whatsapp_broadcast_control SET paused = false');
    const paused = await enqueue();
    await q('UPDATE whatsapp_broadcast_control SET paused = true');
    await tick();
    expect((await row(paused.deliveryId)).state).toBe('queued');
    await q('UPDATE whatsapp_broadcast_control SET paused = false');
    await tick();
    expect((await row(paused.deliveryId)).state).toBe('sent');
  });

  it('at most once: unknown and a stale «sending» are never repeated; a definite rejection fails', async () => {
    sendBehaviour = async () => { throw new Error('socket hang up'); };
    const unknown = await enqueue();
    await tick();
    expect(await row(unknown.deliveryId)).toMatchObject({ state: 'unknown', attempts: 1 });
    sendBehaviour = async () => { throw new ApiError(502, 'WAHA_PROVIDER_ERROR', 'x', { httpStatus: 422 }); };
    const rejected = await enqueue();
    await tick();
    expect(await row(rejected.deliveryId)).toMatchObject({ state: 'failed', reason: 'WAHA_REJECTED' });
    const stale = await enqueue();
    await q(`UPDATE whatsapp_notification_deliveries SET state = 'sending', intent_token = gen_random_uuid(), intent_at = $2, destination_chat_id = 'x@c.us'
      WHERE delivery_id = $1`, [stale.deliveryId, new Date(now.getTime() - 11 * 60_000)]);
    await tick();
    expect(await row(stale.deliveryId)).toMatchObject({ state: 'unknown', reason: 'INTENT_STALE' });
    // Nothing of the three is tried again: the fake records only accepted messages, and none was accepted.
    sendBehaviour = async () => ({ messageId: 'ok' });
    await tick();
    expect(sent).toEqual([]);
    expect((await row(unknown.deliveryId)).attempts).toBe(1);
  });

  it('WAHA down before anything is sent: retried later; not on WhatsApp: failed', async () => {
    checkBehaviour = async () => { throw new ApiError(503, 'WAHA_UNAVAILABLE', 'down'); };
    const retried = await enqueue();
    await tick();
    expect(await row(retried.deliveryId)).toMatchObject({ state: 'queued', reason: 'WAHA_UNAVAILABLE' });
    checkBehaviour = async (phone) => ({ exists: true, chatId: `${phone}@c.us` });
    await tick(61_000);
    expect((await row(retried.deliveryId)).state).toBe('sent');
    checkBehaviour = async () => ({ exists: false, chatId: null });
    await q(`UPDATE employee_work_contacts SET value_normalized = '77017770000' WHERE employee_id = 301`);
    const absent = await enqueue();
    await tick();
    expect(await row(absent.deliveryId)).toMatchObject({ state: 'failed', reason: 'EMPLOYEE_NOT_ON_WHATSAPP' });
    await q(`UPDATE employee_work_contacts SET value_normalized = '${PHONE}' WHERE employee_id = 301`);
  });

  it('frequency gate: one message per 10 s; errors go first', async () => {
    const info = await enqueue({ level: 'info' });
    const error = await enqueue({ level: 'error' });
    await tick();
    expect((await row(error.deliveryId)).state).toBe('sent');
    expect((await row(info.deliveryId)).state).toBe('queued');
    now = new Date(now.getTime() + 2_000);
    await worker.work();
    expect((await row(info.deliveryId)).state).toBe('queued');
    await tick(10_000);
    expect((await row(info.deliveryId)).state).toBe('sent');
  });

  it('purge clears body and address; the key keeps answering forever', async () => {
    const input = request({ recipient: { chatId: GROUP }, requiredPermission: null });
    const done = await inTx((tx) => port.enqueue(tx as never, input));
    await tick();
    const userInput = request();
    const userDone = await inTx((tx) => port.enqueue(tx as never, userInput));
    await tick();
    now = new Date(now.getTime() + 31 * 24 * 60 * 60_000);
    await worker.cleanup();
    for (const id of [done.deliveryId, userDone.deliveryId]) {
      expect(await row(id)).toMatchObject({ state: 'sent', title: null, body: null, phone_normalized: null, chat_id: null, destination_chat_id: null });
      expect((await row(id)).purged_at).not.toBeNull();
    }
    expect(await inTx((tx) => port.enqueue(tx as never, input))).toMatchObject({ deliveryId: done.deliveryId, created: false, state: 'sent' });
    expect(await inTx((tx) => port.enqueue(tx as never, userInput))).toMatchObject({ deliveryId: userDone.deliveryId, created: false });
  });

  it('startup never throws: without the state row the worker delivers nothing until its epoch starts', async () => {
    const saved = (await q('SELECT epoch FROM whatsapp_notification_worker_state')).rows[0].epoch;
    await q('DELETE FROM whatsapp_notification_worker_state');
    const broken = makeWorker();
    broken.onModuleDestroy();
    expect(await broken.ensureEpoch()).toBe(false);
    expect(broken.currentEpoch()).toBeNull();
    await broken.work();
    await q('INSERT INTO whatsapp_notification_worker_state (singleton, epoch) VALUES (true, $1)', [saved]);
    const queued = await enqueue();
    // The next tick starts the epoch (the row queued before it belongs to the earlier one) and delivers only what follows.
    now = new Date(now.getTime() + 11_000);
    await broken.work();
    expect(broken.currentEpoch()).toBe(Number(saved) + 1);
    expect(await row(queued.deliveryId)).toMatchObject({ state: 'cancelled', reason: 'delivery_gap' });
    worker = broken;
    const after = await enqueue();
    await tick();
    expect((await row(after.deliveryId)).state).toBe('sent');
  });
});
