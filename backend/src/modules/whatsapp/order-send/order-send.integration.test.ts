import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { ROLE_POLICIES } from '../../../permissions/policies/role-policies';
import type { WahaClient } from '../waha.client';
import type { WhatsAppRuntimeConfigService } from '../whatsapp-runtime-config.service';
import { OrderSendActors } from './order-send-actors';
import { runMigrationFile } from './migration-file.test-util';
import { OrderSendFileStore } from './order-send-file-store';
import { readOrderFormData } from './forms/order-form-data';
import { parseOrderSendSettings, parseOrderSendCommand } from './order-send.dto';
import { OrderSendRepository } from './order-send.repository';
import { OrderSendService } from './order-send.service';
import { OrderSendWorker } from './order-send-worker.service';
import { MySendsRepository } from '../my-sends/my-sends.repository';
import type { OrderSendSettingsInput } from './order-send.types';

// Real PostgreSQL in an isolated schema: set WHATSAPP_BROADCAST_TEST_DATABASE_URL (or TEST_DATABASE_URL).
const databaseUrl = process.env.WHATSAPP_BROADCAST_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const GROUP = '120363338054016575@g.us';
const OTHER_GROUP = '120363429893275855@g.us';
const FULL: PermissionName[] = ['orders.view', 'orders.export', 'orders.view_financials', 'whatsapp.manage'];
const admin: CurrentUser = { id: '11', username: 'order-send-admin', role: 'admin', roleId: 1, permissions: FULL };
const manager: CurrentUser = { id: '12', username: 'order-send-manager', role: 'manager', roleId: 10, permissions: ['orders.view', 'orders.export'],
  policyScopes: ROLE_POLICIES.manager };
const PHONE_DIGITS = '7014952060';

describe.skipIf(!databaseUrl)('order send from the order card (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_order_send_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let database: DatabaseService;
  let repository: OrderSendRepository;
  let store: OrderSendFileStore;
  let worker: OrderSendWorker;
  let service: OrderSendService;
  let directory: string;
  const sent: Array<{ chatId: string; filename: string; mimetype: string; caption: string; bytes: Buffer }> = [];
  let sendBehaviour: () => Promise<{ messageId?: string }> = async () => ({ messageId: `true_7${PHONE_DIGITS}@c.us_ABCDEF` });
  let checkBehaviour: (phone: string) => Promise<{ exists: boolean; chatId: string | null }> = async (phone) => ({ exists: true, chatId: `${phone}@c.us` });
  let imageBehaviour: (index: number) => Promise<{ messageId?: string }> = async (index) => ({ messageId: `img_${index}` });
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    pool.on('connect', (connection) => { void connection.query(`SET search_path="${schema}",public`); });
    client = await pool.connect();
    await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await q(`SET search_path="${schema}",public`);
    await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await q(`CREATE TABLE audit_log(audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event text NOT NULL,entity_type text,entity_id text,user_id bigint,
      username text,role_code text,role text,request_id text NOT NULL,source text,related_order_id bigint,related_client_id bigint,related_payment_id bigint,
      related_production_event_id bigint,related_deadline_id bigint,related_user_id bigint,status_field text,status_id bigint,status_name text,status_code text,
      stage_code text,before_json jsonb,after_json jsonb,diff_json jsonb,metadata_json jsonb,created_at timestamptz DEFAULT now());
      CREATE TABLE audit_log_related_entity(audit_id uuid NOT NULL,entity_type text NOT NULL,entity_id bigint NOT NULL,PRIMARY KEY(audit_id,entity_type,entity_id));
      CREATE TABLE roles(role_id int PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
      CREATE EXTENSION IF NOT EXISTS citext;
      CREATE TABLE users(user_id bigint PRIMARY KEY, username citext, role_id int REFERENCES roles, is_active boolean NOT NULL DEFAULT true, employee_id bigint);
      INSERT INTO roles VALUES (1, true), (10, true);
      CREATE TABLE permissions_state(id boolean PRIMARY KEY DEFAULT true, version int NOT NULL DEFAULT 1);
      INSERT INTO permissions_state VALUES (true, 1);
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE role_permissions(role_id int, permission_name text, is_enabled boolean NOT NULL DEFAULT true, PRIMARY KEY(role_id, permission_name));
      CREATE TABLE role_policy_scopes(role_id int, scope_key text, scope_value text, PRIMARY KEY(role_id, scope_key));
      INSERT INTO permissions_catalog(permission_name) VALUES ('orders.view'),('orders.export'),('orders.view_financials'),('whatsapp.manage');
      INSERT INTO role_permissions(role_id, permission_name) SELECT 1, permission_name FROM permissions_catalog;
      INSERT INTO role_permissions(role_id, permission_name) VALUES (10, 'orders.view'), (10, 'orders.export');
      INSERT INTO role_policy_scopes VALUES (1, 'orders.view', 'all'), (1, 'orders.export', 'all'), (10, 'orders.view', 'own'), (10, 'orders.export', 'own');
      INSERT INTO users VALUES (11, 'order-send-admin', 1, true), (12, 'order-send-manager', 10, true);
      CREATE TABLE whatsapp_broadcast_control(singleton_id smallint PRIMARY KEY DEFAULT 1, paused boolean NOT NULL DEFAULT false);
      INSERT INTO whatsapp_broadcast_control VALUES (1, false);
      CREATE TABLE clients(client_id bigint PRIMARY KEY, client_name text);
      CREATE TABLE client_phones(phone_id serial PRIMARY KEY, client_id bigint REFERENCES clients(client_id) ON UPDATE CASCADE ON DELETE CASCADE, phone_number text, is_primary boolean DEFAULT false);
      CREATE TABLE sheet_material_types(sheet_material_type_id int PRIMARY KEY, name text);
      CREATE TABLE milling_types(milling_type_id int PRIMARY KEY, milling_type_name text);
      CREATE TABLE edge_types(edge_type_id int PRIMARY KEY, edge_type_name text);
      CREATE TABLE films(film_id int PRIMARY KEY, film_name text);
      CREATE TABLE orders(order_id bigint PRIMARY KEY, order_name text, client_id bigint, order_date date, completion_date date, planned_completion_date date,
        manager_id bigint, created_by bigint, total_amount numeric, discount numeric, final_amount numeric, paid_amount numeric, sheet_material_type_id int,
        delete_flag boolean DEFAULT false, deleted_at timestamptz, order_kind text DEFAULT 'production_order');
      CREATE TABLE order_details(detail_id serial PRIMARY KEY, order_id bigint, detail_number int, height numeric, width numeric, quantity int, note text,
        doweling boolean DEFAULT false, milling_cost_per_sqm numeric, detail_cost numeric, milling_type_id int, edge_type_id int, film_id int,
        sheet_material_type_id int, delete_flag boolean DEFAULT false);
      CREATE TABLE payment_types(type_paid_id int PRIMARY KEY, type_paid_name text);
      CREATE TABLE payments(payment_id serial PRIMARY KEY, order_id bigint, type_paid_id int, payment_date date, amount numeric, delete_flag boolean DEFAULT false);
      CREATE TABLE employees(employee_id bigint PRIMARY KEY, full_name text, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE doweling_orders(doweling_order_id serial PRIMARY KEY, order_id bigint, doweling_order_name text, design_engineer_id int, delete_flag boolean DEFAULT false);
      CREATE TABLE order_doweling_links(order_doweling_link_id serial PRIMARY KEY, order_id bigint, doweling_order_id int, delete_flag boolean DEFAULT false);
      INSERT INTO clients VALUES (501, 'Тест Клиент'), (502, 'Тест Другой');
      INSERT INTO milling_types VALUES (1, 'Фасад'); INSERT INTO edge_types VALUES (1, 'R3'); INSERT INTO films VALUES (1, 'Белый'), (2, 'Дуб');
      INSERT INTO payment_types VALUES (1, 'ТестКаспи');
      INSERT INTO orders VALUES (9001, 'E2E-Тест-1', 501, '2026-10-01', '2026-10-15', NULL, 11, 11, 99000, 0, 99000, 40000, NULL, false, NULL, 'production_order'),
        (9002, 'E2E-Тест-2', 502, '2026-10-01', NULL, NULL, 11, 11, 5000, 0, 5000, 0, NULL, false, NULL, 'production_order');
      INSERT INTO payments(order_id, type_paid_id, payment_date, amount) VALUES (9001, 1, '2026-10-02', 40000);
      INSERT INTO client_phones(client_id, phone_number, is_primary) VALUES (501, '8 ${PHONE_DIGITS.slice(0, 3)} ${PHONE_DIGITS.slice(3, 6)} ${PHONE_DIGITS.slice(6, 8)} ${PHONE_DIGITS.slice(8)}', true);`);
    await q(`INSERT INTO order_details(order_id, detail_number, height, width, quantity, note, milling_cost_per_sqm, milling_type_id, edge_type_id, film_id)
      SELECT 9001, n, 700 + n, 400, 1, 'Деталь ' || n, 12345, 1, 1, CASE WHEN n % 2 = 0 THEN 1 ELSE 2 END FROM generate_series(1, 3) n`);
    await q(`INSERT INTO order_details(order_id, detail_number, height, width, quantity, milling_cost_per_sqm, film_id) VALUES (9002, 1, 500, 500, 2, 1000, 1)`);
    const { readFile } = await import('node:fs/promises');
    await q(await readFile(new URL('../../../../db/migrations/230_whatsapp_order_send.sql', import.meta.url), 'utf8'));
    await q(await readFile(new URL('../../../../db/migrations/233_whatsapp_order_send_queue.sql', import.meta.url), 'utf8'));
    await q(await readFile(new URL('../../../../db/migrations/235_employee_work_contacts.sql', import.meta.url), 'utf8'));
    await q(await readFile(new URL('../../../../db/migrations/237_whatsapp_order_send_client_phone.sql', import.meta.url), 'utf8'));
    // Schema 238 (a supplier request as a send): the journal reads the request and the supplier of such rows.
    await q(`CREATE TABLE suppliers(supplier_id smallint PRIMARY KEY, supplier_name text);
      CREATE TABLE supplier_requests(supplier_request_id bigint PRIMARY KEY, request_number text)`);
    await runMigrationFile((sql) => q(sql), await readFile(new URL('../../../../db/migrations/238_whatsapp_supplier_send.sql', import.meta.url), 'utf8'));
    database = {
      isConfigured: true,
      query: <T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(text, [...params]),
      // Same contract as DatabaseService.withAdvisoryLock: a try-lock on its own connection, null when busy.
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
      transaction: async <T>(handler: (tx: unknown) => Promise<T>) => {
        const connection = await pool.connect();
        try {
          await connection.query(`SET search_path="${schema}",public`);
          await connection.query('BEGIN');
          try {
            const value = await handler({ query: <R extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => connection.query<R>(text, [...params]) });
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
    directory = await mkdtemp(join(tmpdir(), 'order-send-'));
    repository = new OrderSendRepository(database);
    store = new OrderSendFileStore(database, { get: () => directory } as never);
    const actors = new OrderSendActors();
    const runtime = { getConfig: () => ({ enabled: true, relayOwner: 'in_process', relayStaleLockMs: 10 * 60_000 }) } as unknown as WhatsAppRuntimeConfigService;
    const waha = {
      checkPhone: (phone: string) => checkBehaviour(phone),
      sendFile: async (chatId: string, bytes: Buffer, filename: string, mimetype: string, caption: string) => {
        const result = await sendBehaviour();
        sent.push({ chatId, filename, mimetype, caption, bytes });
        return result;
      },
      sendImage: async (chatId: string, bytes: Buffer, filename: string, caption: string) => {
        const index = sent.length;
        const result = await imageBehaviour(index);
        sent.push({ chatId, filename, mimetype: 'image/png', caption, bytes });
        return result;
      },
    } as unknown as WahaClient;
    worker = new OrderSendWorker(repository, store, actors, database, runtime, waha);
    // Delivery is driven explicitly by the tests.
    worker.kick = async () => undefined;
    service = new OrderSendService(repository, store, worker, database);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      try { await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { client.release(); }
    }
    await pool?.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const settingsInput = async (overrides: Partial<OrderSendSettingsInput> = {}): Promise<OrderSendSettingsInput> => {
    const current = (await service.settings()).settings;
    return {
      version: current.version, enabled: true, minIntervalMinutes: 1, sendWindowMinutes: 0, clientForms: ['order_pdf', 'order_excel', 'production_pdf'],
      clientCaption: 'Заказ {order_name} для {client}',
      chats: current.chats.length ? current.chats.map(({ chatKey, groupChatId, label, forms, caption }) => ({ chatKey, groupChatId, label, forms, caption }))
        : [{ chatKey: null, groupChatId: GROUP, label: 'Цех ЧПУ', forms: ['production_pdf', 'production_excel'], caption: 'В работу {order_name}' }],
      ...overrides,
    };
  };
  const configure = async (overrides: Partial<OrderSendSettingsInput> = {}) => service.updateSettings(await settingsInput(overrides), admin, `req-${randomUUID()}`);
  const send = (orderId: number, body: { target: { kind: 'client' } | { kind: 'chat'; chatKey: string }; form: never | string; idempotencyKey?: string },
    actor: CurrentUser = admin) => service.send(orderId, { idempotencyKey: randomUUID(), ...body } as never, actor, `req-${randomUUID()}`);
  const code = async (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));
  const chatKey = async () => (await service.settings()).settings.chats[0].chatKey;
  const row = async (sendId: string) => (await q('SELECT * FROM whatsapp_order_sends WHERE send_id = $1', [sendId])).rows[0];

  beforeEach(async () => {
    await q(`DELETE FROM whatsapp_order_sends`);
    await q(`DELETE FROM whatsapp_order_send_refusals`);
    await q(`UPDATE whatsapp_order_send_settings SET last_delivery_at = NULL`);
    await q('UPDATE whatsapp_broadcast_control SET paused = false');
    await q('UPDATE users SET is_active = true');
    await q(`INSERT INTO role_permissions(role_id, permission_name) SELECT 1, permission_name FROM permissions_catalog ON CONFLICT DO NOTHING`);
    store.maxStoreBytes = 512 * 1024 * 1024;
    worker.clock = () => new Date();
    repository.random = () => 0;
    await q(`UPDATE whatsapp_order_send_settings SET next_delivery_at = NULL`);
    sent.length = 0;
    sendBehaviour = async () => ({ messageId: `true_7${PHONE_DIGITS}@c.us_ABCDEF` });
    checkBehaviour = async (phone) => ({ exists: true, chatId: `${phone}@c.us` });
    imageBehaviour = async (index) => ({ messageId: `img_${index}` });
    await configure({ enabled: true, minIntervalMinutes: 1 });
  });

  it('settings need version CAS and audit groups only as masks', async () => {
    const settings = (await service.settings()).settings;
    expect(await code(service.updateSettings({ ...(await settingsInput()), version: settings.version - 1 }, admin, 'req'))).toBe('ORDER_SEND_SETTINGS_VERSION_CONFLICT');
    const audit = JSON.stringify((await q(`SELECT before_json, after_json FROM audit_log WHERE event = 'whatsapp.order_send_settings.updated'`)).rows);
    expect(audit).toContain('1203…@g.us');
    expect(audit).not.toContain(GROUP);
  });

  it('queues a client send with the normalized phone, a stored file and an audit row without the phone', async () => {
    const { send: view } = await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never });
    expect(view).toMatchObject({ state: 'queued', targetKind: 'client', recipientLabel: 'Клиент', recipientMasked: '7701***2060', form: 'order_pdf' });
    const stored = await row(view.sendId);
    expect(stored.phone_normalized).toBe(`7${PHONE_DIGITS}`);
    expect(stored.destination_chat_id).toBeNull();
    expect(await readdir(join(directory, 'order-sends'))).toContain(stored.file_key);
    const audit = JSON.stringify((await q(`SELECT * FROM audit_log WHERE entity_id = $1`, [view.sendId])).rows);
    expect(audit).toContain('whatsapp.order_send.requested');
    expect(audit).not.toContain(PHONE_DIGITS);
  });

  it('replays a lost response from the ledger even when the send became impossible, and refuses a reused key', async () => {
    const idempotencyKey = randomUUID();
    const first = await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never, idempotencyKey });
    await configure({ enabled: false });
    const replay = await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never, idempotencyKey });
    expect(replay.send.sendId).toBe(first.send.sendId);
    expect(await code(send(9002, { target: { kind: 'client' }, form: 'order_pdf' as never, idempotencyKey }))).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a same-key race replays once committed (or answers retryable BUSY while the first is in flight); another send queues behind', async () => {
    const idempotencyKey = randomUUID();
    // Hold the settings lock so both commands start before either commits.
    const holder = await pool.connect();
    await holder.query(`SET search_path="${schema}",public`);
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM whatsapp_order_send_settings WHERE singleton FOR UPDATE');
    const a = code(send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never, idempotencyKey }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const b = send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never, idempotencyKey }).then((result) => result.send.sendId, (error: unknown) => (error as ApiError).code);
    expect(await b).toBe('ORDER_SEND_BUSY');
    await holder.query('COMMIT');
    holder.release();
    expect(await a).toBe('ok');
    const retry = await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never, idempotencyKey });
    expect((await q('SELECT count(*)::int n FROM whatsapp_order_sends')).rows[0].n).toBe(1);
    expect(retry.send.state).toBe('queued');
    const behind = (await send(9002, { target: { kind: 'chat', chatKey: await chatKey() }, form: 'production_pdf' as never })).send;
    expect(behind).toMatchObject({ state: 'queued', position: 2 });
  });

  it('two commands that wait on the settings lock with the same key: the second replays instead of ACTIVE', async () => {
    const idempotencyKey = randomUUID();
    const holder = await pool.connect();
    await holder.query(`SET search_path="${schema}",public`);
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM whatsapp_order_send_settings WHERE singleton FOR UPDATE');
    // Bypass the store try-lock to put two transactions on the settings lock (the repository-level guarantee).
    const enqueue = () => repository.enqueue({ actorId: admin.id, idempotencyKey, fingerprint: 'f'.repeat(64), chatKey: null,
      prepare: async () => ({ sendId: randomUUID(), orderId: 9001, clientId: 501, actor: admin, requestId: 'req', idempotencyKey, fingerprint: 'f'.repeat(64),
        targetKind: 'client', chatKey: null, form: 'order_pdf', destinationChatId: null, phoneNormalized: `7${PHONE_DIGITS}`, recipientMasked: '7701***2060',
        fileKey: `${randomUUID()}.pdf`, sha256: 'a'.repeat(64), sizeBytes: 10, fileName: 'a.pdf', caption: '', parts: [] }) });
    const first = enqueue();
    const second = enqueue();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await holder.query('COMMIT');
    holder.release();
    const [ra, rb] = await Promise.all([first, second]);
    expect(ra.row.send_id).toBe(rb.row.send_id);
    expect([ra.replayed, rb.replayed].sort()).toEqual([false, true]);
  });

  it('refuses forms that are not allowed, financial forms without finances, and a missing phone, with a refused audit row', async () => {
    const filesBefore = (await readdir(join(directory, 'order-sends')).catch(() => [])).length;
    expect(await code(send(9001, { target: { kind: 'chat', chatKey: await chatKey() }, form: 'order_pdf' as never }))).toBe('ORDER_SEND_FORM_NOT_ALLOWED');
    const noFinances = { ...admin, id: '12', username: 'order-send-manager', role: 'manager' as const, roleId: 10,
      permissions: ['orders.view', 'orders.export'] as PermissionName[], policyScopes: ROLE_POLICIES.admin };
    expect(await code(send(9001, { target: { kind: 'client' }, form: 'order_excel' as never }, noFinances))).toBe('ORDER_SEND_FINANCIALS_REQUIRED');
    expect(await code(send(9002, { target: { kind: 'client' }, form: 'order_pdf' as never }))).toBe('CLIENT_PHONE_MISSING');
    const refused = (await q(`SELECT metadata_json FROM audit_log WHERE event = 'whatsapp.order_send.refused'`)).rows;
    expect(refused.length).toBeGreaterThanOrEqual(3);
    expect(await readdir(join(directory, 'order-sends')).catch(() => [])).toHaveLength(filesBefore);
  });

  it('applies the export scope: a manager cannot send a foreign order, and the refusal is audited', async () => {
    const requestId = `req-${randomUUID()}`;
    expect(await code(service.send(9001, { target: { kind: 'client' }, form: 'production_pdf', idempotencyKey: randomUUID() }, manager, requestId)))
      .toBe('PERMISSION_DENIED');
    const refused = (await q(`SELECT user_id, request_id, related_order_id, status_code FROM audit_log WHERE event = 'whatsapp.order_send.refused' AND request_id = $1`, [requestId])).rows;
    expect(refused).toEqual([{ user_id: '12', request_id: requestId, related_order_id: '9001', status_code: 'PERMISSION_DENIED' }]);
  });

  it('a revocation that commits while the worker waits on the settings lock stops the delivery', async () => {
    const view = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    const holder = await pool.connect();
    await holder.query(`SET search_path="${schema}",public`);
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM whatsapp_order_send_settings WHERE singleton FOR UPDATE');
    const delivery = worker.work();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await q(`DELETE FROM role_permissions WHERE role_id = 1 AND permission_name = 'orders.view_financials'`);
    await holder.query('COMMIT');
    holder.release();
    await delivery;
    expect(await row(view.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'permission_revoked' });
    expect(sent).toHaveLength(0);
  });

  it('between the check and the intent the order, the client and its phones are locked', async () => {
    const view = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    const original = repository.createIntent.bind(repository);
    const blocked: string[] = [];
    repository.createIntent = (sendId, verify, clock) => original(sendId, async (tx, row, settings) => {
      const reason = await verify(tx, row, settings);
      const other = await pool.connect();
      try {
        await other.query(`SET search_path="${schema}",public`);
        for (const [name, sql] of [
          ['manager', `UPDATE orders SET manager_id = 12 WHERE order_id = 9001`],
          ['phone edit', `UPDATE client_phones SET phone_number = '87771234567' WHERE client_id = 501`],
          ['new primary phone', `INSERT INTO client_phones(client_id, phone_number, is_primary) VALUES (501, '87001112233', true)`],
        ] as const) {
          await other.query('BEGIN');
          await other.query(`SET LOCAL lock_timeout = '200ms'`);
          await other.query(sql).then(() => undefined, (error: { code?: string }) => { if (error.code === '55P03') blocked.push(name); });
          await other.query('ROLLBACK');
        }
      } finally {
        other.release();
      }
      return reason;
    }, clock);
    try {
      await worker.work();
    } finally {
      repository.createIntent = original;
    }
    expect(blocked).toEqual(['manager', 'phone edit', 'new primary phone']);
    expect((await row(view.sendId)).state).toBe('sent');
  });

  it('after an unknown outcome the same order+recipient+form needs an explicit confirmation by the send id', async () => {
    sendBehaviour = async () => ({});
    const first = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    await worker.work();
    expect((await row(first.sendId)).state).toBe('unknown');
    await q(`UPDATE whatsapp_order_send_settings SET last_delivery_at = NULL`);
    const refused = await service.send(9001, { target: { kind: 'client' }, form: 'order_pdf', idempotencyKey: randomUUID() }, admin, 'req')
      .catch((error: ApiError) => error);
    expect(refused).toMatchObject({ code: 'ORDER_SEND_PREVIOUS_UNKNOWN', details: { sendId: first.sendId } });
    // Another form or recipient is not affected.
    expect(await code(send(9001, { target: { kind: 'chat', chatKey: await chatKey() }, form: 'production_pdf' as never }))).toBe('ok');
    await q(`DELETE FROM whatsapp_order_sends WHERE state = 'queued'`);
    expect(await code(service.send(9001, { target: { kind: 'client' }, form: 'order_pdf', idempotencyKey: randomUUID(), confirmAfterUnknown: randomUUID() }, admin, 'req')))
      .toBe('ORDER_SEND_PREVIOUS_UNKNOWN');
    const confirmed = await service.send(9001, { target: { kind: 'client' }, form: 'order_pdf', idempotencyKey: randomUUID(), confirmAfterUnknown: first.sendId }, admin, 'req');
    expect(confirmed.send.state).toBe('queued');
  });

  it('the send window: the next delivery waits threshold + a random delay drawn once at the last delivery', async () => {
    await configure({ minIntervalMinutes: 10, sendWindowMinutes: 5 });
    // The request validation refuses a window over half the threshold; the DB CHECK is the last line.
    expect(await code(Promise.resolve().then(async () => parseOrderSendSettings({ ...(await settingsInput()), minIntervalMinutes: 10, sendWindowMinutes: 6 }))))
      .toBe('VALIDATION_ERROR');
    expect(await code(service.updateSettings({ ...(await settingsInput()), minIntervalMinutes: 10, sendWindowMinutes: 6 }, admin, 'req'))).toContain('check constraint');
    const drawn: number[] = [];
    repository.random = (max) => { drawn.push(max); return 3 * 60_000; };
    const first = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    await worker.work();
    expect((await row(first.sendId)).state).toBe('sent');
    expect(drawn).toEqual([5 * 60_000 + 1]);
    const timing = (await q(`SELECT last_delivery_at, next_delivery_at FROM whatsapp_order_send_settings`)).rows[0];
    expect(new Date(timing.next_delivery_at).getTime() - new Date(timing.last_delivery_at).getTime()).toBe(13 * 60_000);
    // 11 minutes later: the threshold has passed (the command is accepted) but the drawn moment has not.
    await q(`UPDATE whatsapp_order_send_settings SET last_delivery_at = last_delivery_at - interval '11 minutes',
      next_delivery_at = next_delivery_at - interval '11 minutes'`);
    const second = (await send(9001, { target: { kind: 'chat', chatKey: await chatKey() }, form: 'production_pdf' as never })).send;
    await worker.work();
    expect((await row(second.sendId)).state).toBe('queued');
    expect(new Date((await row(second.sendId)).next_attempt_at).getTime()).toBe(new Date(timing.next_delivery_at).getTime() - 11 * 60_000);
    // Past the drawn moment: delivered, and the next delay is drawn from this delivery.
    await q(`UPDATE whatsapp_order_send_settings SET next_delivery_at = now() - interval '1 second'`);
    await q(`UPDATE whatsapp_order_sends SET next_attempt_at = now() WHERE send_id = $1`, [second.sendId]);
    await worker.work();
    expect((await row(second.sendId)).state).toBe('sent');
    // Changing the threshold or the window redraws the pending delay from the last delivery.
    repository.random = () => 0;
    await configure({ minIntervalMinutes: 4, sendWindowMinutes: 2 });
    const redrawn = (await q(`SELECT last_delivery_at, next_delivery_at FROM whatsapp_order_send_settings`)).rows[0];
    expect(new Date(redrawn.next_delivery_at).getTime() - new Date(redrawn.last_delivery_at).getTime()).toBe(4 * 60_000);
  });

  it('a queued send lives 24 hours from the command; a settings change never extends it', async () => {
    await configure({ minIntervalMinutes: 120, sendWindowMinutes: 60 });
    const before = Date.now();
    const waiting = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    const expires = new Date((await row(waiting.sendId)).queue_expires_at).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 24 * 60 * 60_000);
    expect(expires).toBeLessThan(Date.now() + 24 * 60 * 60_000 + 1000);
    expect(waiting.expiresAt).toBe(new Date(expires).toISOString());
    await configure({ minIntervalMinutes: 600, sendWindowMinutes: 300 });
    expect(new Date((await row(waiting.sendId)).queue_expires_at).getTime()).toBe(expires);
    await worker.cleanup(new Date(expires - 1000));
    expect((await row(waiting.sendId)).state).toBe('queued');
    await worker.cleanup(new Date(expires + 1000));
    expect((await row(waiting.sendId)).state).toBe('expired');
  });

  it('cleanup does not expire a send whose life was extended after it was picked as a candidate', async () => {
    const view = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    await q(`UPDATE whatsapp_order_sends SET queue_expires_at = now() - interval '1 second' WHERE send_id = $1`, [view.sendId]);
    const original = repository.finishBeforeIntent.bind(repository);
    // Between the unlocked candidate query and the locked transition a settings change commits a longer life.
    repository.finishBeforeIntent = async (sendId, outcome, now) => {
      await q(`UPDATE whatsapp_order_sends SET queue_expires_at = now() + interval '30 minutes' WHERE send_id = $1`, [sendId]);
      return original(sendId, outcome, now);
    };
    try {
      await worker.cleanup();
    } finally {
      repository.finishBeforeIntent = original;
    }
    expect((await row(view.sendId)).state).toBe('queued');
    expect((await q(`SELECT count(*)::int n FROM audit_log WHERE entity_id = $1 AND event = 'whatsapp.order_send.expired'`, [view.sendId])).rows[0].n).toBe(0);
  });

  it('changing the threshold or window re-plans a send that already waits on the old gate', async () => {
    await configure({ minIntervalMinutes: 20, sendWindowMinutes: 10 });
    repository.random = () => 10 * 60_000;
    const first = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    await worker.work();
    expect((await row(first.sendId)).state).toBe('sent');
    await q(`UPDATE whatsapp_order_send_settings SET last_delivery_at = last_delivery_at - interval '21 minutes',
      next_delivery_at = next_delivery_at - interval '21 minutes'`);
    const waiting = (await send(9001, { target: { kind: 'chat', chatKey: await chatKey() }, form: 'production_pdf' as never })).send;
    await worker.work();
    expect((await row(waiting.sendId)).state).toBe('queued');
    expect(new Date((await row(waiting.sendId)).next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
    // The administrator lowers the threshold and drops the window: the new moment has already come.
    repository.random = () => 0;
    await configure({ minIntervalMinutes: 5, sendWindowMinutes: 0 });
    await worker.work();
    expect((await row(waiting.sendId)).state).toBe('sent');
  });

  it('the gate and TTL use the time after the locks, not the iteration start', async () => {
    const first = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    const started = new Date();
    let calls = 0;
    // The intent decision happens 10 s after the lock was taken (slow preparation).
    worker.clock = () => new Date(started.getTime() + (calls++ === 0 ? 0 : 10_000));
    await worker.work(started);
    const settings = (await q(`SELECT last_delivery_at FROM whatsapp_order_send_settings`)).rows[0];
    expect(new Date(settings.last_delivery_at).getTime()).toBe(started.getTime() + 10_000);
    expect((await row(first.sendId)).state).toBe('sent');
    const second = (await q(`UPDATE whatsapp_order_send_settings SET last_delivery_at = NULL RETURNING 1`)).rowCount;
    expect(second).toBe(1);
    const late = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    const expiresAt = new Date((await row(late.sendId)).queue_expires_at).getTime();
    calls = 0;
    worker.clock = () => new Date(calls++ === 0 ? expiresAt - 1000 : expiresAt + 1000);
    await worker.work(new Date(expiresAt - 1000));
    expect((await row(late.sendId)).state).toBe('expired');
  });

  it('keeps the file when the COMMIT answer is lost and removes it after a real rollback', async () => {
    const original = repository.enqueue.bind(repository);
    repository.enqueue = async (params) => { await original(params); throw new Error('connection lost after COMMIT'); };
    const idempotencyKey = randomUUID();
    try {
      expect(await code(send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never, idempotencyKey }))).toContain('connection lost');
    } finally {
      repository.enqueue = original;
    }
    const replay = await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never, idempotencyKey });
    const kept = await row(replay.send.sendId);
    expect(await readdir(join(directory, 'order-sends'))).toContain(kept.file_key);
    await q(`DELETE FROM whatsapp_order_sends`);
    const before = new Set(await readdir(join(directory, 'order-sends')));
    await q(`CREATE OR REPLACE FUNCTION fail_order_send() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'insert refused'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_order_send BEFORE INSERT ON whatsapp_order_sends FOR EACH ROW EXECUTE FUNCTION fail_order_send();`);
    try {
      expect(await code(send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never }))).toContain('insert refused');
    } finally {
      await q('DROP TRIGGER trg_fail_order_send ON whatsapp_order_sends');
    }
    expect(new Set(await readdir(join(directory, 'order-sends')))).toEqual(before);
  });

  it('the store: files over 1 MiB, the quota refusal and the orphan sweep', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const stored = (await store.withStoreLock((owned) => store.write(big, 'xlsx', owned)))!;
    expect(stored.sizeBytes).toBe(big.byteLength);
    expect((await store.withStoreLock((owned) => store.read(stored.fileKey, stored.sha256, owned)))!.equals(big)).toBe(true);
    store.maxStoreBytes = 1;
    expect(await code(send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never }))).toBe('ORDER_SEND_STORAGE_FULL');
    expect((await q('SELECT count(*)::int n FROM whatsapp_order_sends')).rows[0].n).toBe(0);
    expect((await q(`SELECT last_delivery_at FROM whatsapp_order_send_settings`)).rows[0].last_delivery_at).toBeNull();
    store.maxStoreBytes = 512 * 1024 * 1024;
    const removed = await store.withStoreLock((owned) => store.sweep(new Set(), owned, new Date(Date.now() + 2 * 60 * 60_000)));
    expect(removed).toContain(stored.fileKey);
  });

  it('a production Excel sent to a chat carries no prices or payments', async () => {
    const { send: view } = await send(9001, { target: { kind: 'chat', chatKey: await chatKey() }, form: 'production_excel' as never });
    await worker.work();
    expect((await row(view.sendId)).state).toBe('sent');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(sent[0].bytes);
    const text = JSON.stringify(workbook.getWorksheet(1)?.getSheetValues());
    expect(text).not.toContain('12345');
    expect(text).not.toContain('40000');
    expect(text).not.toContain('ТестКаспи');
    expect(sent[0]).toMatchObject({ chatId: GROUP, caption: 'В работу E2E-Тест-1' });
  });

  it('delivers to the client chat id from WhatsApp, then the global threshold delays the next delivery', async () => {
    const first = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    await worker.work();
    expect(await row(first.sendId)).toMatchObject({ state: 'sent', destination_chat_id: `7${PHONE_DIGITS}@c.us`, provider_ack: true });
    expect(sent[0].mimetype).toBe('application/pdf');
    // Inside the threshold the command queues the send instead of refusing it.
    const early = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    expect(early).toMatchObject({ state: 'queued', position: 1 });
    await worker.work();
    expect((await row(early.sendId)).state).toBe('queued');
    await q(`DELETE FROM whatsapp_order_sends WHERE send_id = $1`, [early.sendId]);
    // A send queued before the cooldown was reserved (e.g. after a relay outage) still waits for the gate.
    await q(`UPDATE whatsapp_order_send_settings SET last_delivery_at = now() - interval '2 minutes', next_delivery_at = NULL`);
    const second = (await send(9001, { target: { kind: 'chat', chatKey: await chatKey() }, form: 'production_pdf' as never })).send;
    await q(`UPDATE whatsapp_order_send_settings SET last_delivery_at = now(), next_delivery_at = NULL`);
    await worker.work();
    expect((await row(second.sendId)).state).toBe('queued');
    expect(sent).toHaveLength(1);
    await q(`UPDATE whatsapp_order_send_settings SET last_delivery_at = now() - interval '2 minutes', next_delivery_at = NULL`);
    await q(`UPDATE whatsapp_order_sends SET next_attempt_at = now() WHERE send_id = $1`, [second.sendId]);
    await worker.work();
    expect((await row(second.sendId)).state).toBe('sent');
  });

  it('cancels instead of redirecting when the recipient, the rights or the settings change after the command', async () => {
    const key = await chatKey();
    const toChat = (await send(9001, { target: { kind: 'chat', chatKey: key }, form: 'production_pdf' as never })).send;
    const current = await settingsInput();
    await service.updateSettings({ ...current, chats: [{ ...current.chats[0], groupChatId: OTHER_GROUP }] }, admin, 'req');
    expect(await row(toChat.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'recipient_removed' });
    expect((await service.settings()).settings.chats[0].chatKey).not.toBe(key);

    const toClient = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    await q(`UPDATE client_phones SET phone_number = '87771234567' WHERE client_id = 501`);
    await worker.work();
    expect(await row(toClient.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'recipient_changed' });
    await q(`UPDATE client_phones SET phone_number = '8 701 495 20 60' WHERE client_id = 501`);

    const revoked = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    await q(`DELETE FROM role_permissions WHERE role_id = 1 AND permission_name = 'orders.view'`);
    await worker.work();
    expect(await row(revoked.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'permission_revoked' });
    await q(`INSERT INTO role_permissions(role_id, permission_name) VALUES (1, 'orders.view')`);

    const disabled = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    await configure({ enabled: false });
    expect(await row(disabled.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'disabled' });
    expect(sent).toHaveLength(0);
  });

  it('settles a missing ACK id and a timeout as unknown, a WAHA rejection as failed, and recovers a lost intent', async () => {
    const outcomes: Array<[() => Promise<{ messageId?: string }>, string, string]> = [
      [async () => ({}), 'unknown', 'PROVIDER_ACK_MISSING_ID'],
      [async () => { throw new ApiError(503, 'WAHA_UNAVAILABLE', 'timeout'); }, 'unknown', 'WAHA_UNAVAILABLE'],
      [async () => { throw new ApiError(502, 'WAHA_PROVIDER_ERROR', 'bad', { httpStatus: 422 }); }, 'failed', 'WAHA_REJECTED'],
      [async () => { throw new ApiError(502, 'WAHA_PROVIDER_ERROR', 'boom', { httpStatus: 500 }); }, 'unknown', 'WAHA_PROVIDER_ERROR'],
    ];
    for (const [behaviour, state, errorCode] of outcomes) {
      // Each case starts clean: an unknown outcome would otherwise require a confirmed repeat.
      await q(`DELETE FROM whatsapp_order_sends`);
      await q(`UPDATE whatsapp_order_send_settings SET last_delivery_at = NULL`);
      sendBehaviour = behaviour;
      const view = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
      await worker.work();
      expect(await row(view.sendId)).toMatchObject({ state, error_code: errorCode });
    }
    await q(`DELETE FROM whatsapp_order_sends`);
    await q(`UPDATE whatsapp_order_send_settings SET last_delivery_at = NULL`);
    const lost = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    await q(`UPDATE whatsapp_order_sends SET state = 'sending', attempt_count = 1, lock_token = gen_random_uuid(), send_started_at = now() - interval '1 hour',
      destination_chat_id = '77014952060@c.us' WHERE send_id = $1`, [lost.sendId]);
    expect(await repository.markStaleIntentsUnknown(10 * 60_000)).toBe(1);
    expect(await row(lost.sendId)).toMatchObject({ state: 'unknown', error_code: 'PROCESS_LOST_AFTER_INTENT' });
  });

  it('a number without WhatsApp fails without spending the threshold; paused keeps the send queued; the queue TTL expires it', async () => {
    checkBehaviour = async () => ({ exists: false, chatId: null });
    const missing = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    await worker.work();
    expect(await row(missing.sendId)).toMatchObject({ state: 'failed', error_code: 'CLIENT_NOT_ON_WHATSAPP' });
    expect((await q(`SELECT last_delivery_at FROM whatsapp_order_send_settings`)).rows[0].last_delivery_at).toBeNull();
    checkBehaviour = async (phone) => ({ exists: true, chatId: `${phone}@c.us` });
    const paused = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    await q('UPDATE whatsapp_broadcast_control SET paused = true');
    await worker.work();
    expect((await row(paused.sendId)).state).toBe('queued');
    await q(`UPDATE whatsapp_order_sends SET queue_expires_at = now() - interval '1 second' WHERE send_id = $1`, [paused.sendId]);
    await worker.cleanup();
    expect((await row(paused.sendId)).state).toBe('expired');
  });

  it('retention removes the file, the recipient and the provider id (which carries the phone) after 7 days', async () => {
    const view = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    await worker.work();
    const before = await row(view.sendId);
    expect(before.provider_message_id).toContain(PHONE_DIGITS);
    await q(`UPDATE whatsapp_order_sends SET created_at = now() - interval '8 days' WHERE send_id = $1`, [view.sendId]);
    await worker.cleanup(new Date(Date.now() + 2 * 60 * 60_000));
    const after = await row(view.sendId);
    expect(after).toMatchObject({ state: 'sent', provider_ack: true, file_key: null, destination_chat_id: null, phone_normalized: null, provider_message_id: null });
    expect(JSON.stringify(after)).not.toContain(PHONE_DIGITS);
    expect(await readdir(join(directory, 'order-sends'))).not.toContain(before.file_key);
  });

  it('the menu hides group ids and financial forms from a user without finances', async () => {
    const menu = await service.menu({ ...admin, permissions: ['orders.view', 'orders.export'] });
    expect(JSON.stringify(menu)).not.toContain('@g.us');
    expect(menu.client.forms).toEqual(['production_pdf']);
    expect(menu.forms.map((form) => form.code)).toEqual(['production_pdf', 'production_excel', 'production_image']);
    expect(menu.chats[0]).toMatchObject({ label: 'Цех ЧПУ', forms: ['production_pdf', 'production_excel'] });
    const view = (await send(9001, { target: { kind: 'chat', chatKey: menu.chats[0].chatKey }, form: 'production_pdf' as never })).send;
    expect(view).toMatchObject({ recipientLabel: 'Цех ЧПУ', recipientMasked: '1203…@g.us', actor: { username: 'order-send-admin' } });
  });
  it('the form takes the doweling order of the first live link, like the card, and never a removed one', async () => {
    await q(`INSERT INTO employees VALUES (71, 'Тест Конструктор'), (72, 'Тест Другой')`);
    await q(`INSERT INTO doweling_orders(doweling_order_id, doweling_order_name, design_engineer_id) VALUES (100, 'Тест-П-100', 71), (200, 'Тест-П-200', 72)`);
    await q(`INSERT INTO order_doweling_links(order_id, doweling_order_id, delete_flag) VALUES (9002, 100, false), (9002, 200, true)`);
    const read = () => database.transaction((tx) => readOrderFormData(tx as never, 9002));
    expect(await read()).toMatchObject({ prisadkaName: 'Тест-П-100', prisadkaDesignerName: 'Тест Конструктор' });
    await q(`UPDATE order_doweling_links SET delete_flag = true WHERE order_id = 9002`);
    expect(await read()).toMatchObject({ prisadkaName: null, prisadkaDesignerName: null });
    await q(`DELETE FROM order_doweling_links WHERE order_id = 9002`);
    await q(`DELETE FROM doweling_orders WHERE doweling_order_id IN (100, 200)`);
    await q(`DELETE FROM employees WHERE employee_id IN (71, 72)`);
  });
  // ---- the queue (03.10): FIFO behind the gate, duplicates, limits, manual cancel, image forms.
  const slotPassed = () => q(`UPDATE whatsapp_order_send_settings SET last_delivery_at = now() - interval '2 minutes', next_delivery_at = NULL`);
  const wake = () => q(`UPDATE whatsapp_order_sends SET next_attempt_at = now() WHERE state = 'queued'`);

  it('sends made before the threshold wait in the queue and leave one by one in command order', async () => {
    const a = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    const b = (await send(9001, { target: { kind: 'chat', chatKey: await chatKey() }, form: 'production_pdf' as never })).send;
    const c = (await send(9002, { target: { kind: 'chat', chatKey: await chatKey() }, form: 'production_pdf' as never })).send;
    expect([a.position, b.position, c.position]).toEqual([1, 2, 3]);
    expect(Date.parse(b.estimatedAt as string)).toBeGreaterThan(Date.parse(a.estimatedAt as string));
    await worker.work();
    expect((await row(a.sendId)).state).toBe('sent');
    await worker.work();
    expect((await row(b.sendId)).state).toBe('queued');
    for (const expected of [b, c]) {
      await slotPassed();
      await wake();
      await worker.work();
      expect((await row(expected.sendId)).state).toBe('sent');
    }
    expect(sent[0].chatId).toBe(`7${PHONE_DIGITS}@c.us`);
    expect(sent.slice(1).map((item) => item.chatId.endsWith('@g.us'))).toEqual([true, true]);
    expect(sent.slice(1).map((item) => item.filename)).toEqual([expect.stringContaining('для производства'), expect.stringContaining('для производства')]);
    const audit = (await q(`SELECT metadata_json FROM audit_log WHERE entity_id = $1 AND event = 'whatsapp.order_send.requested'`, [c.sendId])).rows[0];
    expect(audit.metadata_json).toMatchObject({ position: 3 });
  });

  it('refuses the same form to the same recipient while it waits, and caps the queue per author and in total', async () => {
    const first = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    const duplicate = await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never }).catch((error: ApiError) => error);
    expect(duplicate).toMatchObject({ code: 'ORDER_SEND_ALREADY_QUEUED', details: { sendId: first.sendId } });
    expect((await send(9001, { target: { kind: 'client' }, form: 'order_excel' as never })).send.state).toBe('queued');
    await q(`INSERT INTO whatsapp_order_sends (send_id, order_id, client_id, actor_id, request_id, idempotency_key, fingerprint, target_kind, form_code,
        phone_normalized, recipient_masked, file_key, sha256, size_bytes, file_name, queue_expires_at)
      SELECT gen_random_uuid(), 9002, 502, 11, 'req', gen_random_uuid(), repeat('a', 64), 'client', 'order_pdf', '77014952060', '7701***2060',
        gen_random_uuid()::text || '.pdf', repeat('b', 64), 10, 'x.pdf', now() + interval '1 day' FROM generate_series(1, 18)`);
    expect(await code(send(9002, { target: { kind: 'chat', chatKey: await chatKey() }, form: 'production_pdf' as never }))).toBe('ORDER_SEND_QUEUE_FULL');
    await q(`INSERT INTO whatsapp_order_sends (send_id, order_id, client_id, actor_id, request_id, idempotency_key, fingerprint, target_kind, form_code,
        phone_normalized, recipient_masked, file_key, sha256, size_bytes, file_name, queue_expires_at)
      SELECT gen_random_uuid(), 9002, 502, 12, 'req', gen_random_uuid(), repeat('a', 64), 'client', 'order_pdf', '77014952060', '7701***2060',
        gen_random_uuid()::text || '.pdf', repeat('b', 64), 10, 'x.pdf', now() + interval '1 day' FROM generate_series(1, 80)`);
    const full = await send(9001, { target: { kind: 'chat', chatKey: await chatKey() }, form: 'production_excel' as never }).catch((error: ApiError) => error);
    expect(full).toMatchObject({ code: 'ORDER_SEND_QUEUE_FULL', details: { scope: 'total' } });
    const refused = (await q(`SELECT count(*)::int n FROM audit_log WHERE event = 'whatsapp.order_send.refused' AND status_code = 'ORDER_SEND_ALREADY_QUEUED'`)).rows[0];
    expect(refused.n).toBeGreaterThan(0);
  });

  it('the author cancels his waiting send, a WhatsApp manager any; a foreign one is not found; a sending one cannot be cancelled', async () => {
    await q(`INSERT INTO role_permissions(role_id, permission_name) VALUES (10, 'orders.view'), (10, 'orders.export') ON CONFLICT DO NOTHING`);
    const own = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
    const other = (await send(9001, { target: { kind: 'chat', chatKey: await chatKey() }, form: 'production_pdf' as never })).send;
    const stranger: CurrentUser = { id: '12', username: 'order-send-manager', role: 'manager', roleId: 10, permissions: ['orders.view'] };
    expect(await code(service.cancel(own.sendId, stranger, 'req-x'))).toBe('ORDER_SEND_NOT_FOUND');
    const byAuthor = await service.cancel(own.sendId, { ...admin, permissions: ['orders.view'] }, 'req-author');
    expect(byAuthor.send).toMatchObject({ state: 'cancelled', cancelReason: 'manual' });
    expect((await service.cancel(own.sendId, admin, 'req-again')).send.state).toBe('cancelled');
    const byManager = await service.cancel(other.sendId, { ...stranger, permissions: ['whatsapp.manage'] }, 'req-manager');
    expect(byManager.send.state).toBe('cancelled');
    expect((await row(other.sendId)).cancelled_by).toBe('12');
    const audit = (await q(`SELECT user_id, related_user_id, request_id, metadata_json FROM audit_log WHERE entity_id = $1 AND event = 'whatsapp.order_send.cancelled'`,
      [other.sendId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: '12', related_user_id: '11', request_id: 'req-manager', metadata_json: { cancelReason: 'manual', byAuthor: false } });
    const going = (await send(9002, { target: { kind: 'chat', chatKey: await chatKey() }, form: 'production_pdf' as never })).send;
    await q(`UPDATE whatsapp_order_sends SET state = 'sending', attempt_count = 1, lock_token = gen_random_uuid(), send_started_at = now() WHERE send_id = $1`, [going.sendId]);
    expect(await code(service.cancel(going.sendId, admin, 'req-late'))).toBe('ORDER_SEND_NOT_CANCELLABLE');
    await worker.work();
    expect(sent).toHaveLength(0);
  });

  it('an image form goes as pictures one after another, the caption on the first; a later page lost → unknown PARTIAL_DELIVERY', async () => {
    await configure({ clientForms: ['order_image', 'order_pdf'] });
    await q(`INSERT INTO order_details(order_id, detail_number, height, width, quantity, milling_cost_per_sqm, film_id)
      SELECT 9001, 100 + n, 500, 500, 1, 1000, 1 FROM generate_series(1, 80) n`);
    try {
      const view = (await send(9001, { target: { kind: 'client' }, form: 'order_image' as never })).send;
      expect(view.partsTotal).toBe(2);
      await worker.work();
      const stored = await row(view.sendId);
      expect(stored.state).toBe('sent');
      expect(sent.map((item) => [item.mimetype, item.caption !== ''])).toEqual([['image/png', true], ['image/png', false]]);
      expect(sent[0].filename).toContain('(1 из 2)');
      const part = (await q(`SELECT provider_message_id FROM whatsapp_order_send_parts WHERE send_id = $1`, [view.sendId])).rows[0];
      expect(part.provider_message_id).toBe('img_1');
      sent.length = 0;
      await slotPassed();
      imageBehaviour = async (index) => (index === 0 ? { messageId: 'img_0' } : Promise.reject(new ApiError(504, 'WAHA_TIMEOUT', 'timeout')));
      const partial = (await send(9001, { target: { kind: 'client' }, form: 'order_image' as never })).send;
      await worker.work();
      expect(await row(partial.sendId)).toMatchObject({ state: 'unknown', error_code: 'PARTIAL_DELIVERY' });
      const settled = (await q(`SELECT metadata_json FROM audit_log WHERE entity_id = $1 AND event = 'whatsapp.order_send.unknown'`, [partial.sendId])).rows[0];
      expect(settled.metadata_json).toMatchObject({ partsTotal: 2, partsSent: 1 });
      expect(await code(send(9001, { target: { kind: 'client' }, form: 'order_image' as never }))).toBe('ORDER_SEND_PREVIOUS_UNKNOWN');
      // Nothing delivered on the first page → failed as for a file.
      await slotPassed();
      imageBehaviour = async () => Promise.reject(new ApiError(502, 'WAHA_PROVIDER_ERROR', 'rejected', { httpStatus: 422 }));
      const rejected = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
      await q(`UPDATE whatsapp_order_sends SET form_code = 'order_image' WHERE send_id = $1`, [rejected.sendId]);
      await worker.work();
      expect(await row(rejected.sendId)).toMatchObject({ state: 'failed', error_code: 'WAHA_REJECTED' });
    } finally {
      await q(`DELETE FROM order_details WHERE order_id = 9001 AND detail_number > 100`);
    }
  });

  // ---- a chosen phone of the client (04.10): contacts per order, identity by «client + number», never redirected.
  const PRIMARY = `8 ${PHONE_DIGITS.slice(0, 3)} ${PHONE_DIGITS.slice(3, 6)} ${PHONE_DIGITS.slice(6, 8)} ${PHONE_DIGITS.slice(8)}`;
  const SECOND = '87771234567';
  /** Client 501 gets exactly these phones (the first is primary); returns their ids in order. */
  const clientPhones = async (numbers: string[]): Promise<number[]> => {
    await q(`DELETE FROM client_phones WHERE client_id = 501`);
    const ids: number[] = [];
    for (const [index, number] of numbers.entries()) {
      ids.push(Number((await q(`INSERT INTO client_phones(client_id, phone_number, is_primary) VALUES (501, $1, $2) RETURNING phone_id`,
        [number, index === 0])).rows[0].phone_id));
    }
    return ids;
  };
  /** The client target as the card sends it: a chosen phone goes with the token the contacts endpoint gave for it. */
  const toClient = async (phoneId?: number) => {
    if (!phoneId) return { kind: 'client' } as never;
    const contact = (await service.clientContacts(9001, admin)).contacts.find((item) => item.phoneId === phoneId);
    return { kind: 'client', phoneId, phoneToken: contact?.token ?? 'f'.repeat(64) } as never;
  };

  describe('a chosen phone of the client', () => {
    // The tests run the full release whatever the built-in switch says (the compatible release has it off).
    beforeEach(() => { repository.clientPhoneChoice = true; });
    afterEach(async () => { repository.clientPhoneChoice = true; await clientPhones([PRIMARY]); });

    it('lists the phones of the order client for the menu: masks only, the primary first, unreadable and repeated numbers left out', async () => {
      const [primary, second] = await clientPhones([PRIMARY, SECOND, 'офис 12-34', `+7${PHONE_DIGITS}`]);
      const contacts = await service.clientContacts(9001, admin);
      expect(contacts).toEqual({ clientId: 501, contacts: [
        { phoneId: primary, masked: `7${PHONE_DIGITS.slice(0, 3)}***${PHONE_DIGITS.slice(-4)}`, isPrimary: true, isDefault: true, token: expect.stringMatching(/^[0-9a-f]{64}$/) },
        { phoneId: second, masked: '7777***4567', isPrimary: false, isDefault: false, token: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ] });
      expect(contacts.contacts[0].token).not.toBe(contacts.contacts[1].token);
      expect(JSON.stringify(contacts)).not.toContain(PHONE_DIGITS);
      // Another order — its own client: nothing of client 501 leaks into it.
      expect((await service.clientContacts(9002, admin)).clientId).toBe(502);
      expect(await code(service.clientContacts(999999, admin))).toBe('ORDER_NOT_FOUND');
    });

    it('sends to the chosen phone; the default send keeps the old rule; both carry the «client + number» fingerprint', async () => {
      const [, second] = await clientPhones([PRIMARY, SECOND]);
      const chosen = (await send(9001, { target: await toClient(second), form: 'order_pdf' })).send;
      expect(chosen.recipientMasked).toBe('7777***4567');
      expect(await row(chosen.sendId)).toMatchObject({ target_kind: 'client', client_phone_id: String(second), phone_normalized: '77771234567' });
      await worker.work();
      expect(await row(chosen.sendId)).toMatchObject({ state: 'sent', destination_chat_id: '77771234567@c.us' });
      await slotPassed();
      const byDefault = (await send(9001, { target: await toClient(), form: 'order_pdf' })).send;
      const stored = await row(byDefault.sendId);
      expect(stored).toMatchObject({ client_phone_id: null, phone_normalized: `7${PHONE_DIGITS}` });
      expect(stored.recipient_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.recipient_fingerprint).not.toBe((await row(chosen.sendId)).recipient_fingerprint);
      // A phone of another client, or one that is gone, is never accepted for this order.
      const foreign = Number((await q(`INSERT INTO client_phones(client_id, phone_number, is_primary) VALUES (502, '87019998877', true) RETURNING phone_id`)).rows[0].phone_id);
      expect(await code(send(9001, { target: await toClient(foreign), form: 'order_excel' }))).toBe('CLIENT_PHONE_MISSING');
      // A chosen phone without the token, or a token without the phone, is not a valid command.
      for (const target of [{ kind: 'client', phoneId: second }, { kind: 'client', phoneToken: 'a'.repeat(64) }]) {
        expect(await code(Promise.resolve().then(() => parseOrderSendCommand({ target, form: 'order_pdf', idempotencyKey: randomUUID() })))).toBe('VALIDATION_ERROR');
      }
      expect(await code(send(9001, { target: await toClient(987654), form: 'order_excel' }))).toBe('CLIENT_PHONE_MISSING');
      await q(`DELETE FROM client_phones WHERE phone_id = $1`, [foreign]);
    });

    it('the menu showed one number, the phone row was edited meanwhile: the send is refused, never sent to the new number', async () => {
      const [, second] = await clientPhones([PRIMARY, SECOND]);
      const shown = await toClient(second);
      await q(`UPDATE client_phones SET phone_number = '87770000009' WHERE phone_id = $1`, [second]);
      expect(await code(send(9001, { target: shown, form: 'order_pdf' }))).toBe('ORDER_SEND_PHONE_CHANGED');
      expect((await q(`SELECT count(*)::int n FROM whatsapp_order_sends`)).rows[0].n).toBe(0);
      const refusal = (await q(`SELECT status_code FROM audit_log WHERE event = 'whatsapp.order_send.refused' ORDER BY created_at DESC LIMIT 1`)).rows[0];
      expect(refusal.status_code).toBe('ORDER_SEND_PHONE_CHANGED');
      // A fresh menu gives the token of the new number: the user sees it and may send there.
      expect((await send(9001, { target: await toClient(second), form: 'order_pdf' })).send.recipientMasked).toBe('7777***0009');
    });

    it('a client whose primary number is unreadable: the only readable phone is offered as a chosen one, not as the default', async () => {
      const [, second] = await clientPhones(['офис 12-34', SECOND]);
      const contacts = (await service.clientContacts(9001, admin)).contacts;
      expect(contacts).toEqual([expect.objectContaining({ phoneId: second, isPrimary: false, isDefault: false })]);
      expect(await code(send(9001, { target: await toClient(), form: 'order_pdf' }))).toBe('CLIENT_PHONE_INVALID');
      expect((await send(9001, { target: await toClient(second), form: 'order_pdf' })).send.recipientMasked).toBe('7777***4567');
    });

    it('rollback to the compatible release: committed chosen-phone commands are replayed and delivered, new ones are refused for good', async () => {
      const [, second] = await clientPhones([PRIMARY, SECOND]);
      // The full release committed a chosen-phone command; its answer was lost.
      const target = await toClient(second);
      const key = randomUUID();
      const committed = (await send(9001, { target, form: 'order_pdf', idempotencyKey: key })).send;
      const uncommitted = { target, form: 'order_excel', idempotencyKey: randomUUID() };
      // The backend is rolled back to the compatible release.
      repository.clientPhoneChoice = false;
      // The browser retries the same command through the same parser: it is replayed, not refused as invalid.
      const parsed = parseOrderSendCommand({ target, form: 'order_pdf', idempotencyKey: key });
      const replay = await service.send(9001, parsed as never, admin, 'req-replay-k2a');
      expect(replay.send.sendId).toBe(committed.sendId);
      expect((await q(`SELECT count(*)::int n FROM whatsapp_order_sends`)).rows[0].n).toBe(1);
      // A command that never committed is refused definitely (the browser drops its pending key); the default send works.
      expect(await code(send(9001, uncommitted))).toBe('ORDER_SEND_PHONE_CHOICE_UNAVAILABLE');
      expect((await service.clientContacts(9001, admin)).contacts).toEqual([]);
      expect((await send(9001, { target: await toClient(), form: 'order_excel' })).send.state).toBe('queued');
      // The row with the chosen phone is delivered by the compatible release to that very phone…
      await worker.work();
      expect(await row(committed.sendId)).toMatchObject({ state: 'sent', destination_chat_id: '77771234567@c.us' });
      // …and cancelled, not redirected, when that phone was edited meanwhile.
      repository.clientPhoneChoice = true;
      await q(`DELETE FROM whatsapp_order_sends`);
      const [, again] = await clientPhones([PRIMARY, SECOND]);
      const edited = (await send(9001, { target: await toClient(again), form: 'order_pdf' })).send;
      repository.clientPhoneChoice = false;
      await q(`UPDATE client_phones SET phone_number = '87770000002' WHERE phone_id = $1`, [again]);
      await worker.work();
      expect(await row(edited.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'recipient_changed' });
    });

    it('a final refusal is kept with the command key: the same request later — the number back, another release — is still refused', async () => {
      const [, second] = await clientPhones([PRIMARY, SECOND]);
      const target = await toClient(second);
      const key = randomUUID();
      // The phone row is edited: the command is refused and the refusal is recorded.
      await q(`UPDATE client_phones SET phone_number = '87770000003' WHERE phone_id = $1`, [second]);
      const first = await send(9001, { target, form: 'order_pdf', idempotencyKey: key }).catch((error: ApiError) => error);
      expect(first).toMatchObject({ code: 'ORDER_SEND_PHONE_CHANGED', details: { final: true } });
      // The number is put back — the old token fits again — and the delayed first request arrives: still refused, no send.
      await q(`UPDATE client_phones SET phone_number = $2 WHERE phone_id = $1`, [second, SECOND]);
      const late = await send(9001, { target, form: 'order_pdf', idempotencyKey: key }).catch((error: ApiError) => error);
      expect(late).toMatchObject({ code: 'ORDER_SEND_PHONE_CHANGED', details: { final: true } });
      expect((await q(`SELECT count(*)::int n FROM whatsapp_order_sends`)).rows[0].n).toBe(0);
      // The same choice under a new key goes through.
      expect((await send(9001, { target, form: 'order_pdf' })).send.state).toBe('queued');
      await q(`DELETE FROM whatsapp_order_sends`);

      // The compatible release refused a chosen-phone command; the full release comes back: the late request stays refused.
      const k2aKey = randomUUID();
      repository.clientPhoneChoice = false;
      expect(await send(9001, { target, form: 'order_pdf', idempotencyKey: k2aKey }).catch((error: ApiError) => error))
        .toMatchObject({ code: 'ORDER_SEND_PHONE_CHOICE_UNAVAILABLE', details: { final: true } });
      repository.clientPhoneChoice = true;
      expect(await code(send(9001, { target, form: 'order_pdf', idempotencyKey: k2aKey }))).toBe('ORDER_SEND_PHONE_CHOICE_UNAVAILABLE');
      expect((await q(`SELECT count(*)::int n FROM whatsapp_order_sends`)).rows[0].n).toBe(0);

      // A chosen phone was deleted before the command committed: refused for good; another phone under a new key is sent.
      const [, gone] = await clientPhones([PRIMARY, SECOND]);
      const goneTarget = await toClient(gone);
      const goneKey = randomUUID();
      await q(`DELETE FROM client_phones WHERE phone_id = $1`, [gone]);
      expect(await send(9001, { target: goneTarget, form: 'order_pdf', idempotencyKey: goneKey }).catch((error: ApiError) => error))
        .toMatchObject({ code: 'CLIENT_PHONE_MISSING', details: { final: true } });
      expect(await code(send(9001, { target: goneTarget, form: 'order_pdf', idempotencyKey: goneKey }))).toBe('CLIENT_PHONE_MISSING');
      expect((await send(9001, { target: await toClient(), form: 'order_pdf' })).send.state).toBe('queued');
      // Other refusals (they may pass later) are not recorded: the same key goes through once the reason is gone.
      await q(`DELETE FROM whatsapp_order_sends`);
      const retryKey = randomUUID();
      await configure({ enabled: false });
      expect(await send(9001, { target: await toClient(), form: 'order_pdf', idempotencyKey: retryKey }).catch((error: ApiError) => error))
        .toMatchObject({ code: 'ORDER_SEND_DISABLED' });
      await configure({ enabled: true });
      expect((await send(9001, { target: await toClient(), form: 'order_pdf', idempotencyKey: retryKey })).send.state).toBe('queued');
      // Retention never removes a recorded refusal: long after, with the number back and the full release, the old keys stay refused.
      await q(`DELETE FROM whatsapp_order_sends`);
      await q(`UPDATE whatsapp_order_send_refusals SET created_at = now() - interval '60 days'`);
      await worker.cleanup(new Date(Date.now() + 2 * 60 * 60_000));
      expect((await q(`SELECT count(*)::int n FROM whatsapp_order_send_refusals`)).rows[0].n).toBe(3);
      expect(await code(send(9001, { target, form: 'order_pdf', idempotencyKey: key }))).toBe('ORDER_SEND_PHONE_CHANGED');
      expect(await code(send(9001, { target, form: 'order_pdf', idempotencyKey: k2aKey }))).toBe('ORDER_SEND_PHONE_CHOICE_UNAVAILABLE');
      expect((await q(`SELECT count(*)::int n FROM whatsapp_order_sends`)).rows[0].n).toBe(0);
    });

    it('a final refusal is audited in the transaction that records it: both or neither', async () => {
      const [, second] = await clientPhones([PRIMARY, SECOND]);
      const target = await toClient(second);
      await q(`UPDATE client_phones SET phone_number = '87770000004' WHERE phone_id = $1`, [second]);
      const key = randomUUID();
      // The audit cannot be written: the refusal is not recorded either, and the command is not answered as final.
      await q(`ALTER TABLE audit_log RENAME TO audit_log_off`);
      let failure: unknown;
      try { failure = await send(9001, { target, form: 'order_pdf', idempotencyKey: key }).catch((error: unknown) => error); }
      finally { await q(`ALTER TABLE audit_log_off RENAME TO audit_log`); }
      expect(failure).not.toBeInstanceOf(ApiError);
      expect((await q(`SELECT count(*)::int n FROM whatsapp_order_send_refusals`)).rows[0].n).toBe(0);
      // With the audit available: one refusal row and one audit event with the request id, the order and no number or token.
      const refused = await service.send(9001, { target, form: 'order_pdf', idempotencyKey: key } as never, admin, 'req-final-refusal').catch((error: ApiError) => error);
      expect(refused).toMatchObject({ code: 'ORDER_SEND_PHONE_CHANGED', details: { final: true } });
      expect((await q(`SELECT request_id, order_id, error_code FROM whatsapp_order_send_refusals`)).rows).toEqual([
        { request_id: 'req-final-refusal', order_id: '9001', error_code: 'ORDER_SEND_PHONE_CHANGED' }]);
      const audits = (await q(`SELECT request_id, related_order_id, status_code, metadata_json FROM audit_log WHERE event = 'whatsapp.order_send.refused'
        AND status_code = 'ORDER_SEND_PHONE_CHANGED' AND request_id = 'req-final-refusal'`)).rows;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ request_id: 'req-final-refusal', related_order_id: '9001',
        metadata_json: { final: true, targetKind: 'client', clientPhoneId: second, form: 'order_pdf' } });
      expect(JSON.stringify(audits[0])).not.toMatch(/7777|[0-9a-f]{64}/);
      // A repeat of the recorded refusal adds no second audit event.
      const countRefusals = async () => (await q(`SELECT count(*)::int n FROM audit_log WHERE event = 'whatsapp.order_send.refused'
        AND status_code = 'ORDER_SEND_PHONE_CHANGED'`)).rows[0].n;
      const before = await countRefusals();
      await send(9001, { target, form: 'order_pdf', idempotencyKey: key }).catch(() => undefined);
      expect(await countRefusals()).toBe(before);
    });

    it('a chosen phone that became unreadable is refused for good as «changed»; another phone is then sent under a new key', async () => {
      const [, second] = await clientPhones([PRIMARY, SECOND]);
      const target = await toClient(second);
      const key = randomUUID();
      await q(`UPDATE client_phones SET phone_number = '+12025550123' WHERE phone_id = $1`, [second]);
      expect(await send(9001, { target, form: 'order_pdf', idempotencyKey: key }).catch((error: ApiError) => error))
        .toMatchObject({ code: 'ORDER_SEND_PHONE_CHANGED', details: { final: true } });
      expect((await send(9001, { target: await toClient(), form: 'order_pdf' })).send.state).toBe('queued');
      // The default rule keeps its own answer for an unreadable primary number (not final: the phone may be fixed).
      await clientPhones(['+12025550123']);
      expect(await send(9001, { target: await toClient(), form: 'order_excel' }).catch((error: ApiError) => error))
        .toMatchObject({ code: 'CLIENT_PHONE_INVALID' });
    });

    it('a send without a chosen phone never names the client_phone_id column (it is written only for a chosen phone)', async () => {
      await clientPhones([PRIMARY, SECOND]);
      await q(`ALTER TABLE whatsapp_order_sends DROP COLUMN client_phone_id`);
      try {
        const view = (await send(9001, { target: await toClient(), form: 'order_pdf' })).send;
        expect((await row(view.sendId)).recipient_fingerprint).toMatch(/^[0-9a-f]{64}$/);
        await worker.work();
        expect(await row(view.sendId)).toMatchObject({ state: 'sent', destination_chat_id: `7${PHONE_DIGITS}@c.us` });
      } finally {
        await q(`ALTER TABLE whatsapp_order_sends ADD COLUMN client_phone_id BIGINT`);
      }
    });

    it('the same form to the same number is one recipient however it was chosen; another number is another recipient', async () => {
      const [primary, second] = await clientPhones([PRIMARY, SECOND]);
      const waiting = (await send(9001, { target: await toClient(), form: 'order_pdf' })).send;
      const duplicate = await send(9001, { target: await toClient(primary), form: 'order_pdf' }).catch((error: ApiError) => error);
      expect(duplicate).toMatchObject({ code: 'ORDER_SEND_ALREADY_QUEUED', details: { sendId: waiting.sendId } });
      expect((await send(9001, { target: await toClient(second), form: 'order_pdf' })).send.state).toBe('queued');
    });

    it('history made before fingerprints: the same number or a purged one is the same recipient, a known other number is not', async () => {
      const [primary, second] = await clientPhones([PRIMARY, SECOND]);
      const legacy = async (state: string, phone: string | null) => {
        const view = (await send(9001, { target: await toClient(), form: 'order_pdf' })).send;
        await q(`UPDATE whatsapp_order_sends SET recipient_fingerprint = NULL, client_phone_id = NULL, state = $2, phone_normalized = $3,
          error_code = CASE WHEN $2 = 'unknown' THEN 'WAHA_UNCERTAIN' END WHERE send_id = $1`, [view.sendId, state, phone]);
        return view.sendId;
      };
      // A waiting legacy row on the primary number: the primary is a duplicate, the second number is not.
      const waiting = await legacy('queued', `7${PHONE_DIGITS}`);
      expect(await code(send(9001, { target: await toClient(primary), form: 'order_pdf' }))).toBe('ORDER_SEND_ALREADY_QUEUED');
      expect((await send(9001, { target: await toClient(second), form: 'order_pdf' })).send.state).toBe('queued');
      await q(`DELETE FROM whatsapp_order_sends`);
      // An unknown legacy outcome on the primary number: a repeat there needs a confirmation, the second number does not.
      const unknown = await legacy('unknown', `7${PHONE_DIGITS}`);
      expect(await code(send(9001, { target: await toClient(), form: 'order_pdf' }))).toBe('ORDER_SEND_PREVIOUS_UNKNOWN');
      expect((await send(9001, { target: await toClient(second), form: 'order_pdf' })).send.state).toBe('queued');
      await q(`DELETE FROM whatsapp_order_sends WHERE send_id <> $1`, [unknown]);
      // After retention the legacy number is gone: nobody knows where it went — every number needs the confirmation.
      await q(`UPDATE whatsapp_order_sends SET phone_normalized = NULL WHERE send_id = $1`, [unknown]);
      expect(await code(send(9001, { target: await toClient(second), form: 'order_pdf' }))).toBe('ORDER_SEND_PREVIOUS_UNKNOWN');
      expect((await send(9001, { target: await toClient(second), form: 'order_pdf', confirmAfterUnknown: unknown } as never)).send.state).toBe('queued');
      expect(waiting).toBeTruthy();
    });

    it('a fingerprinted unknown outcome still asks for a confirmation after retention removed the number', async () => {
      const [, second] = await clientPhones([PRIMARY, SECOND]);
      const view = (await send(9001, { target: await toClient(second), form: 'order_pdf' })).send;
      await q(`UPDATE whatsapp_order_sends SET state = 'unknown', error_code = 'WAHA_UNCERTAIN', created_at = now() - interval '8 days' WHERE send_id = $1`, [view.sendId]);
      await worker.cleanup(new Date(Date.now() + 2 * 60 * 60_000));
      expect((await row(view.sendId)).phone_normalized).toBeNull();
      expect(await code(send(9001, { target: await toClient(second), form: 'order_pdf' }))).toBe('ORDER_SEND_PREVIOUS_UNKNOWN');
      // The primary number is another recipient: no confirmation needed.
      expect((await send(9001, { target: await toClient(), form: 'order_pdf' })).send.state).toBe('queued');
    });

    it('the worker never redirects a chosen phone: edited or deleted → cancelled; a change of the primary does not touch it', async () => {
      const [, second] = await clientPhones([PRIMARY, SECOND]);
      const edited = (await send(9001, { target: await toClient(second), form: 'order_pdf' })).send;
      await q(`UPDATE client_phones SET phone_number = '87770000001' WHERE phone_id = $1`, [second]);
      await worker.work();
      expect(await row(edited.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'recipient_changed' });
      const deleted = (await send(9001, { target: await toClient(second), form: 'order_pdf' })).send;
      await q(`DELETE FROM client_phones WHERE phone_id = $1`, [second]);
      await worker.work();
      expect(await row(deleted.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'recipient_changed' });
      expect(sent).toHaveLength(0);
      // The chosen phone stays; another phone becomes primary meanwhile: the send still goes to the chosen number.
      const [first, other] = await clientPhones([PRIMARY, SECOND]);
      const kept = (await send(9001, { target: await toClient(other), form: 'order_pdf' })).send;
      await q(`UPDATE client_phones SET is_primary = false WHERE phone_id = $1`, [first]);
      await q(`INSERT INTO client_phones(client_id, phone_number, is_primary) VALUES (501, '87015550000', true)`);
      await worker.work();
      expect(await row(kept.sendId)).toMatchObject({ state: 'sent', destination_chat_id: '77771234567@c.us' });
      // A default send still follows the primary: changed primary → cancelled, as before.
      await slotPassed();
      await clientPhones([PRIMARY, SECOND]);
      const byDefault = (await send(9001, { target: await toClient(), form: 'order_excel' })).send;
      await q(`UPDATE client_phones SET is_primary = (phone_number = $1) WHERE client_id = 501`, [SECOND]);
      await worker.work();
      expect(await row(byDefault.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'recipient_changed' });
    });
  });

  // ---- an employee as a recipient (03.10): contacts, identity across retention, never redirected.
  const EMPLOYEE_PHONE = '77015550101';
  const setupEmployee = async (opts: { id?: number; phones?: string[]; forms?: string[] } = {}) => {
    const id = opts.id ?? 7201;
    await q(`INSERT INTO employees(employee_id, full_name) VALUES ($1, 'Тест Сотрудник Мастер') ON CONFLICT (employee_id) DO UPDATE SET is_active = true`, [id]);
    await q(`DELETE FROM employee_work_contacts WHERE employee_id = $1`, [id]);
    for (const [index, phone] of (opts.phones ?? [EMPLOYEE_PHONE]).entries()) {
      await q(`INSERT INTO employee_work_contacts(employee_id, kind, value, value_normalized, is_primary, position) VALUES ($1, 'phone', $2, $2, $3, $4)`,
        [id, phone, index === 0, index]);
    }
    await q(`UPDATE users SET employee_id = $1 WHERE user_id = 12`, [id]);
    const current = await settingsInput();
    await service.updateSettings({ ...current, employees: [{ recipientKey: null, employeeId: id, channel: 'whatsapp',
      forms: (opts.forms ?? ['production_pdf', 'order_pdf']) as never, caption: 'Мастеру {order_name}' }] } as never, admin, `req-${randomUUID()}`);
    const recipient = (await service.settings()).settings.employees.find((item) => item.employeeId === id)!;
    const contacts = (await q(`SELECT contact_id, value_normalized FROM employee_work_contacts WHERE employee_id = $1 ORDER BY position`, [id])).rows;
    return { id, recipientKey: recipient.recipientKey, contacts };
  };
  const toEmployee = (recipientKey: string, contactId?: number, contactToken?: string) =>
    ({ kind: 'employee', recipientKey, ...(contactId ? { contactId } : {}), ...(contactToken ? { contactToken } : {}) }) as never;

  it('the menu offers settings employees as «логин / ФИО» with masked phones; Telegram is refused by the API', async () => {
    const employee = await setupEmployee({ phones: [EMPLOYEE_PHONE, '77015550102'] });
    const menu = await service.menu(admin);
    const item = menu.employees.find((entry) => entry.recipientKey === employee.recipientKey)!;
    expect(item.label).toBe('order-send-manager / Тест Сотрудник Мастер');
    expect(item.contacts).toEqual([
      { contactId: Number(employee.contacts[0].contact_id), masked: '7701***0101', isPrimary: true, token: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { contactId: Number(employee.contacts[1].contact_id), masked: '7701***0102', isPrimary: false, token: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    // The employee's contact row is edited after the menu was built: the token of the shown number no longer fits.
    const second = item.contacts[1];
    await q(`UPDATE employee_work_contacts SET value = '87015550199', value_normalized = '77015550199' WHERE contact_id = $1`, [second.contactId]);
    expect(await code(send(9001, { target: toEmployee(employee.recipientKey, second.contactId, second.token), form: 'order_pdf' as never }))).toBe('ORDER_SEND_PHONE_CHANGED');
    await q(`UPDATE employee_work_contacts SET value = '77015550102', value_normalized = '77015550102' WHERE contact_id = $1`, [second.contactId]);
    expect((await send(9001, { target: toEmployee(employee.recipientKey, second.contactId, second.token), form: 'order_pdf' as never })).send.state).toBe('queued');
    await q(`DELETE FROM whatsapp_order_sends`);
    expect(JSON.stringify(menu)).not.toContain(EMPLOYEE_PHONE);
    // users.username is citext as in the real schema: the directory still returns a real array of logins.
    expect((await service.settings()).employeeDirectory.find((entry) => entry.employeeId === employee.id))
      .toMatchObject({ usernames: ['order-send-manager'], phones: 2 });
    const settings = await settingsInput();
    expect(await code(Promise.resolve().then(() => parseOrderSendSettings({ ...settings, employees: [{ recipientKey: null, employeeId: employee.id,
      channel: 'telegram', forms: ['order_pdf'], caption: '' }] })))).toBe('ORDER_SEND_CHANNEL_UNSUPPORTED');
    // A client of the previous release saves settings without «employees»: the employees stay.
    const legacy = parseOrderSendSettings({ ...(await settingsInput()), employees: undefined });
    await service.updateSettings(legacy, admin, 'req-legacy');
    expect((await service.settings()).settings.employees.map((entry) => entry.recipientKey)).toEqual([employee.recipientKey]);
  });

  it('sends to the primary or a chosen phone of the employee, audited with the employee link', async () => {
    const employee = await setupEmployee({ phones: [EMPLOYEE_PHONE, '77015550102'] });
    const first = (await send(9001, { target: toEmployee(employee.recipientKey), form: 'order_pdf' as never })).send;
    expect(first).toMatchObject({ targetKind: 'employee', recipientLabel: 'Тест Сотрудник Мастер', recipientMasked: '7701***0101' });
    await worker.work();
    expect(await row(first.sendId)).toMatchObject({ state: 'sent', destination_chat_id: `${EMPLOYEE_PHONE}@c.us`, employee_id: String(employee.id) });
    expect(sent[0].caption).toContain('Мастеру');
    const links = (await q(`SELECT a.event FROM audit_log a JOIN audit_log_related_entity r ON r.audit_id = a.audit_id
      WHERE a.entity_id = $1 AND r.entity_type = 'employee' AND r.entity_id = $2 ORDER BY a.created_at`, [first.sendId, employee.id])).rows.map((r) => r.event);
    expect(links).toEqual(expect.arrayContaining(['whatsapp.order_send.requested', 'whatsapp.order_send.intent', 'whatsapp.order_send.sent']));
    await slotPassed();
    const second = (await send(9001, { target: toEmployee(employee.recipientKey, Number(employee.contacts[1].contact_id)), form: 'order_pdf' as never })).send;
    expect(second.recipientMasked).toBe('7701***0102');
    expect(await code(send(9001, { target: toEmployee(employee.recipientKey, 999999), form: 'order_pdf' as never }))).toBe('EMPLOYEE_CONTACT_MISSING');
  });

  it('a refusal to an employee recipient (also an archived one) is audited with the employee link', async () => {
    const employee = await setupEmployee();
    await send(9001, { target: toEmployee(employee.recipientKey), form: 'order_pdf' as never });
    expect(await code(send(9001, { target: toEmployee(employee.recipientKey), form: 'order_pdf' as never }))).toBe('ORDER_SEND_ALREADY_QUEUED');
    await service.updateSettings({ ...(await settingsInput()), employees: [] } as never, admin, `req-${randomUUID()}`);
    expect(await code(send(9001, { target: toEmployee(employee.recipientKey), form: 'order_pdf' as never }))).toBe('ORDER_SEND_RECIPIENT_UNKNOWN');
    const refusals = (await q(`SELECT a.status_code, a.metadata_json->>'employeeId' employee, r.entity_id related FROM audit_log a
      LEFT JOIN audit_log_related_entity r ON r.audit_id = a.audit_id AND r.entity_type = 'employee'
      WHERE a.event = 'whatsapp.order_send.refused' AND a.metadata_json->>'recipientKey' = $1 ORDER BY a.created_at`, [employee.recipientKey])).rows;
    expect(refusals).toEqual([
      { status_code: 'ORDER_SEND_ALREADY_QUEUED', employee: String(employee.id), related: String(employee.id) },
      { status_code: 'ORDER_SEND_RECIPIENT_UNKNOWN', employee: String(employee.id), related: String(employee.id) },
    ]);
  });

  it('the same form to the same employee on the same number is one recipient — across a primary change and retention', async () => {
    const employee = await setupEmployee({ phones: [EMPLOYEE_PHONE, '77015550102'] });
    const waiting = (await send(9001, { target: toEmployee(employee.recipientKey), form: 'order_pdf' as never })).send;
    const duplicate = await send(9001, { target: toEmployee(employee.recipientKey, Number(employee.contacts[0].contact_id)), form: 'order_pdf' as never })
      .catch((error: ApiError) => error);
    expect(duplicate).toMatchObject({ code: 'ORDER_SEND_ALREADY_QUEUED', details: { sendId: waiting.sendId } });
    // Another number of the same employee is another recipient.
    expect((await send(9001, { target: toEmployee(employee.recipientKey, Number(employee.contacts[1].contact_id)), form: 'order_pdf' as never })).send.state)
      .toBe('queued');
    await q(`DELETE FROM whatsapp_order_sends WHERE send_id <> $1`, [waiting.sendId]);
    // The send ends unknown, retention removes the phone: a repeat to the same number still needs a confirmation,
    // even after the number became primary under another contact row.
    await q(`UPDATE whatsapp_order_sends SET state = 'unknown', error_code = 'WAHA_UNCERTAIN', created_at = now() - interval '8 days' WHERE send_id = $1`, [waiting.sendId]);
    await worker.cleanup(new Date(Date.now() + 2 * 60 * 60_000));
    expect((await row(waiting.sendId)).phone_normalized).toBeNull();
    expect((await row(waiting.sendId)).recipient_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    await q(`DELETE FROM employee_work_contacts WHERE employee_id = $1`, [employee.id]);
    await q(`INSERT INTO employee_work_contacts(employee_id, kind, value, value_normalized, is_primary) VALUES ($1, 'phone', '8 701 555 01 01', $2, true)`,
      [employee.id, EMPLOYEE_PHONE]);
    expect(await code(send(9001, { target: toEmployee(employee.recipientKey), form: 'order_pdf' as never }))).toBe('ORDER_SEND_PREVIOUS_UNKNOWN');
    expect((await send(9001, { target: toEmployee(employee.recipientKey), form: 'order_pdf' as never, confirmAfterUnknown: waiting.sendId } as never)).send.state)
      .toBe('queued');
  });

  it('the worker never redirects: a changed phone, an inactive employee or a removed recipient cancel; a Telegram row fails without WhatsApp', async () => {
    const employee = await setupEmployee();
    const changed = (await send(9001, { target: toEmployee(employee.recipientKey), form: 'order_pdf' as never })).send;
    await q(`UPDATE employee_work_contacts SET value_normalized = '77015550199', value = '77015550199' WHERE contact_id = $1`, [employee.contacts[0].contact_id]);
    await worker.work();
    expect(await row(changed.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'recipient_changed' });
    await q(`UPDATE employee_work_contacts SET value_normalized = $2, value = $2 WHERE contact_id = $1`, [employee.contacts[0].contact_id, EMPLOYEE_PHONE]);
    const inactive = (await send(9001, { target: toEmployee(employee.recipientKey), form: 'order_pdf' as never })).send;
    await q(`UPDATE employees SET is_active = false WHERE employee_id = $1`, [employee.id]);
    await worker.work();
    expect(await row(inactive.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'recipient_removed' });
    await q(`UPDATE employees SET is_active = true WHERE employee_id = $1`, [employee.id]);
    const telegramKey = randomUUID();
    await q(`INSERT INTO whatsapp_order_send_employees(recipient_key, employee_id, channel, forms, position) VALUES ($1, $2, 'telegram', '{order_pdf}', 5)`,
      [telegramKey, employee.id]);
    const viaTelegram = (await send(9001, { target: toEmployee(employee.recipientKey), form: 'order_pdf' as never })).send;
    await q(`UPDATE whatsapp_order_sends SET recipient_key = $2 WHERE send_id = $1`, [viaTelegram.sendId, telegramKey]);
    let checked = 0;
    const original = checkBehaviour;
    checkBehaviour = async (phone) => { checked += 1; return original(phone); };
    try { await worker.work(); } finally { checkBehaviour = original; }
    expect(await row(viaTelegram.sendId)).toMatchObject({ state: 'failed', error_code: 'ORDER_SEND_CHANNEL_UNSUPPORTED' });
    expect(checked).toBe(0);
    // Removing the employee from the settings cancels his waiting sends.
    const removed = (await send(9001, { target: toEmployee(employee.recipientKey), form: 'order_pdf' as never })).send;
    await service.updateSettings({ ...(await settingsInput()), employees: [] } as never, admin, 'req-remove');
    expect(await row(removed.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'recipient_removed' });
    // The archived recipient keeps the employee: deleting the employee is refused (RESTRICT).
    expect(await code(q(`DELETE FROM employees WHERE employee_id = $1`, [employee.id]))).toContain('foreign key');
  });

  // ---- rows of a release this backend does not know (a form added later). These run last: they drop
  // the form CHECK of this schema.
  describe('rows of a newer release', () => {
    beforeAll(async () => {
      await q(`ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_form_code;
        ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS whatsapp_order_sends_form_code_check;
        ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS whatsapp_order_sends_file_key_check;
        ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS whatsapp_order_sends_cancel_reason_check;
        ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS parts_total SMALLINT NOT NULL DEFAULT 1;
        ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS cancelled_by BIGINT;
        CREATE TABLE IF NOT EXISTS whatsapp_order_send_parts (send_id UUID NOT NULL REFERENCES whatsapp_order_sends(send_id) ON DELETE CASCADE,
          part_no SMALLINT NOT NULL, file_key TEXT, sha256 TEXT, size_bytes INTEGER, provider_message_id TEXT, sent_at TIMESTAMPTZ,
          purged_at TIMESTAMPTZ, PRIMARY KEY (send_id, part_no));`);
    });

    const png = async () => (await store.withStoreLock((owned) => store.write(Buffer.from(`png-${randomUUID()}`), 'png', owned)))!;

    it('never delivers a form it does not know, and spends no slot', async () => {
      const unknown = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
      await q(`UPDATE whatsapp_order_sends SET form_code = 'order_video' WHERE send_id = $1`, [unknown.sendId]);
      await worker.work();
      expect(await row(unknown.sendId)).toMatchObject({ state: 'failed', error_code: 'ORDER_SEND_FORM_UNSUPPORTED' });
      expect(sent).toHaveLength(0);
      expect((await q(`SELECT last_delivery_at FROM whatsapp_order_send_settings`)).rows[0].last_delivery_at).toBeNull();
    });

    it('reads histories with unknown forms and a manual cancel without failing', async () => {
      const view = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
      await q(`UPDATE whatsapp_order_sends SET form_code = 'order_video', state = 'cancelled', cancel_reason = 'manual', cancelled_by = 11
        WHERE send_id = $1`, [view.sendId]);
      expect((await service.listForOrder(9001, admin)).sends.find((item) => item.sendId === view.sendId)).toMatchObject({ form: 'order_video', cancelReason: 'manual' });
      const mySends = new MySendsRepository(database);
      // This schema has no calendar tables: only the order card part of «my sends» is read here.
      (mySends as unknown as { calendarSends: () => Promise<never[]> }).calendarSends = async () => [];
      const mine = await mySends.list(admin.id);
      expect(mine.find((item) => item.id === view.sendId)?.title).toContain('order_video');
    });

    it('retention purges the pages 2..N with their provider ids and removes every picture from the disk', async () => {
      const view = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
      const first = await png();
      const second = await png();
      await q(`UPDATE whatsapp_order_sends SET form_code = 'order_image', parts_total = 2, file_key = $2, sha256 = $3, state = 'sent', provider_ack = true,
          sent_at = now(), provider_message_id = 'true_77014952060@c.us_A', created_at = now() - interval '8 days' WHERE send_id = $1`,
      [view.sendId, first.fileKey, first.sha256]);
      await q(`INSERT INTO whatsapp_order_send_parts (send_id, part_no, file_key, sha256, size_bytes, provider_message_id, sent_at)
        VALUES ($1, 2, $2, $3, $4, 'true_77014952060@c.us_B', now())`, [view.sendId, second.fileKey, second.sha256, second.sizeBytes]);
      expect(await repository.fileReferenced(second.fileKey)).toBe(true);
      await worker.cleanup(new Date(Date.now() + 2 * 60 * 60_000));
      const part = (await q(`SELECT * FROM whatsapp_order_send_parts WHERE send_id = $1`, [view.sendId])).rows[0];
      expect(part).toMatchObject({ file_key: null, provider_message_id: null });
      expect(part.purged_at).not.toBeNull();
      const files = await readdir(join(directory, 'order-sends'));
      expect(files).not.toContain(first.fileKey);
      expect(files).not.toContain(second.fileKey);
    });

    it('a picture send interrupted while sending becomes unknown once, with one audit event', async () => {
      const view = (await send(9001, { target: { kind: 'client' }, form: 'order_pdf' as never })).send;
      await q(`UPDATE whatsapp_order_sends SET form_code = 'order_image', parts_total = 3, state = 'sending', attempt_count = 1, lock_token = gen_random_uuid(),
          send_started_at = now() - interval '1 hour' WHERE send_id = $1`, [view.sendId]);
      expect(await repository.markStaleIntentsUnknown(10 * 60_000)).toBe(1);
      expect(await repository.markStaleIntentsUnknown(10 * 60_000)).toBe(0);
      expect(await row(view.sendId)).toMatchObject({ state: 'unknown', error_code: 'PROCESS_LOST_AFTER_INTENT' });
      const events = (await q(`SELECT count(*)::int n FROM audit_log WHERE entity_id = $1 AND event = 'whatsapp.order_send.unknown'`, [view.sendId])).rows[0];
      expect(events.n).toBe(1);
    });
  });
});
