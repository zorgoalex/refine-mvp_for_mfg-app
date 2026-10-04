import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { ROLE_POLICIES } from '../../../permissions/policies/role-policies';
import type { WahaClient } from '../waha.client';
import type { WhatsAppRuntimeConfigService } from '../whatsapp-runtime-config.service';
import { OrderSendActors } from './order-send-actors';
import { OrderSendFileStore } from './order-send-file-store';
import { parseSupplierSendCommand } from './order-send.dto';
import { OrderSendRepository } from './order-send.repository';
import { OrderSendService } from './order-send.service';
import { OrderSendWorker } from './order-send-worker.service';
import { SupplierSendRepository } from './supplier-send.repository';
import { SupplierSendService } from './supplier-send.service';
import { runMigrationFile } from './migration-file.test-util';

// Real PostgreSQL in an isolated schema with the real migrations of the send queue and of the contacts, real
// foreign keys and column types: set WHATSAPP_BROADCAST_TEST_DATABASE_URL (or TEST_DATABASE_URL).
const databaseUrl = process.env.WHATSAPP_BROADCAST_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const PERMISSIONS: PermissionName[] = ['orders.view', 'procurement.view', 'procurement.manage', 'whatsapp.manage'];
const admin: CurrentUser = { id: '11', username: 'supplier-send-admin', role: 'admin', roleId: 1, permissions: PERMISSIONS };
const manager: CurrentUser = { id: '12', username: 'supplier-send-manager', role: 'manager', roleId: 10,
  permissions: ['orders.view', 'procurement.view', 'procurement.manage'], policyScopes: ROLE_POLICIES.manager };
const PHONE = '77015550101';
const SECOND_PHONE = '77015550202';
const COUNTERPARTY = '0b0f3c2e-1111-4222-8333-444455556666';
const TEXT = 'Тест заявка № 1\n1. МДФ 16 мм — 5 листов\nСрок: 20.10.2026';

describe.skipIf(!databaseUrl)('supplier request to WhatsApp (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_supplier_send_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let client: PoolClient;
  let database: DatabaseService;
  let sends: OrderSendRepository;
  let repository: SupplierSendRepository;
  let worker: OrderSendWorker;
  let service: SupplierSendService;
  let orderService: OrderSendService;
  let directory: string;
  let requestNumber = 0;
  const texts: Array<{ chatId: string; text: string }> = [];
  let textBehaviour: (index: number) => Promise<{ messageId?: string }> = async (index) => ({ messageId: `text_${index}` });
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);

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
      CREATE TABLE outbox_events(event_id bigserial PRIMARY KEY, event_type text NOT NULL, aggregate_type text NOT NULL, aggregate_id text NOT NULL,
        payload_json jsonb NOT NULL, idempotency_key text, created_at timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX uq_outbox_events_idempotency_key ON outbox_events(idempotency_key);
      CREATE TABLE roles(role_id int PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE employees(employee_id bigint PRIMARY KEY, full_name text, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE users(user_id bigint PRIMARY KEY, username citext, role_id int REFERENCES roles, is_active boolean NOT NULL DEFAULT true,
        is_service_account boolean NOT NULL DEFAULT false, employee_id bigint REFERENCES employees);
      INSERT INTO roles VALUES (1, true), (10, true);
      CREATE TABLE permissions_state(id boolean PRIMARY KEY DEFAULT true, version int NOT NULL DEFAULT 1);
      INSERT INTO permissions_state VALUES (true, 1);
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE role_permissions(role_id int, permission_name text, is_enabled boolean NOT NULL DEFAULT true, PRIMARY KEY(role_id, permission_name));
      CREATE TABLE role_policy_scopes(role_id int, scope_key text, scope_value text, PRIMARY KEY(role_id, scope_key));
      INSERT INTO permissions_catalog(permission_name) VALUES ('orders.view'),('procurement.view'),('procurement.manage'),('whatsapp.manage');
      INSERT INTO role_policy_scopes VALUES (1, 'orders.view', 'all'), (10, 'orders.view', 'own');
      INSERT INTO users VALUES (11, 'supplier-send-admin', 1, true, false), (12, 'supplier-send-manager', 10, true, false);
      CREATE TABLE whatsapp_broadcast_control(singleton_id smallint PRIMARY KEY DEFAULT 1, paused boolean NOT NULL DEFAULT false);
      INSERT INTO whatsapp_broadcast_control VALUES (1, false);
      CREATE TABLE clients(client_id bigint PRIMARY KEY, client_name text);
      CREATE TABLE vendors(vendor_id smallint PRIMARY KEY, vendor_name text);
      CREATE TABLE suppliers(supplier_id smallint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, supplier_name varchar(250) NOT NULL, phone varchar(32),
        is_active boolean NOT NULL DEFAULT true, ref_key_1c uuid);
      CREATE UNIQUE INDEX idx_suppliers__ref_key_1c ON suppliers(ref_key_1c) WHERE ref_key_1c IS NOT NULL;
      CREATE TABLE sheet_material_types(sheet_material_type_id bigint PRIMARY KEY, name text, width_mm int, height_mm int);
      CREATE TABLE films(film_id bigint PRIMARY KEY, film_name text);
      CREATE TABLE orders(order_id bigint PRIMARY KEY, order_name text, client_id bigint, manager_id bigint REFERENCES users(user_id),
        created_by bigint REFERENCES users(user_id), delete_flag boolean DEFAULT false, deleted_at timestamptz, order_kind text DEFAULT 'production_order');
      CREATE TABLE supplier_requests(supplier_request_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, request_number text NOT NULL UNIQUE,
        supplier_id smallint REFERENCES suppliers(supplier_id), supplier_key text NOT NULL, supplier_name text NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'draft', comment text, expected_date date, version integer NOT NULL DEFAULT 0);
      CREATE TABLE supplier_request_lines(supplier_request_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        supplier_request_id bigint NOT NULL REFERENCES supplier_requests(supplier_request_id) ON DELETE CASCADE, line_no integer NOT NULL,
        resource_kind varchar(32) NOT NULL, sheet_material_type_id bigint REFERENCES sheet_material_types, film_id bigint REFERENCES films,
        quantity numeric(14,3) NOT NULL, stock_quantity numeric(14,3) NOT NULL DEFAULT 0, unit_code varchar(8) NOT NULL);
      CREATE TABLE order_resource_procurement(order_resource_procurement_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        order_id bigint NOT NULL REFERENCES orders(order_id));
      CREATE TABLE supplier_request_line_orders(supplier_request_line_order_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        supplier_request_line_id bigint NOT NULL REFERENCES supplier_request_lines(supplier_request_line_id) ON DELETE CASCADE,
        order_resource_procurement_id bigint NOT NULL REFERENCES order_resource_procurement(order_resource_procurement_id), quantity numeric(14,3) NOT NULL DEFAULT 1);
      INSERT INTO sheet_material_types VALUES (1, 'Тест МДФ 16', 2800, 2070);
      INSERT INTO suppliers(supplier_id, supplier_name, ref_key_1c) VALUES (1, 'Тест Поставщик', NULL), (2, 'Тест Поставщик 1С', '${COUNTERPARTY}'),
        (3, 'Тест Без телефона', NULL);
      INSERT INTO orders VALUES (9001, 'E2E-Тест-1', NULL, 12, 11), (9002, 'E2E-Тест-2', NULL, 11, 11);`);
    for (const migration of ['230_whatsapp_order_send', '233_whatsapp_order_send_queue', '235_employee_work_contacts', '236_party_contacts',
      '237_whatsapp_order_send_client_phone', '238_whatsapp_supplier_send']) {
      const sql = await readFile(new URL(`../../../../db/migrations/${migration}.sql`, import.meta.url), 'utf8');
      if (migration.startsWith('238_')) await runMigrationFile((text) => q(text), sql); else await q(sql);
    }
    database = {
      isConfigured: true,
      query: <T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => pool.query<T>(text, [...params]),
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
    directory = await mkdtemp(join(tmpdir(), 'supplier-send-'));
    sends = new OrderSendRepository(database);
    repository = new SupplierSendRepository(database, sends);
    const store = new OrderSendFileStore(database, { get: () => directory } as never);
    const runtime = { getConfig: () => ({ enabled: true, relayOwner: 'in_process', relayStaleLockMs: 10 * 60_000 }) } as unknown as WhatsAppRuntimeConfigService;
    const waha = {
      checkPhone: async (phone: string) => ({ exists: true, chatId: `${phone}@c.us` }),
      sendText: async (chatId: string, text: string) => {
        const result = await textBehaviour(texts.length);
        texts.push({ chatId, text });
        return result;
      },
    } as unknown as WahaClient;
    worker = new OrderSendWorker(sends, store, new OrderSendActors(), database, runtime, waha, undefined, repository);
    // Delivery is driven explicitly by the tests.
    worker.kick = async () => undefined;
    service = new SupplierSendService(repository, sends, worker, database);
    orderService = new OrderSendService(sends, store, worker, database);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      try { await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { client.release(); }
    }
    await pool?.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await q(`DELETE FROM whatsapp_order_sends; DELETE FROM whatsapp_order_send_refusals; DELETE FROM outbox_events; DELETE FROM audit_log;
      TRUNCATE supplier_requests, order_resource_procurement CASCADE;
      DELETE FROM supplier_contacts;
      UPDATE suppliers SET is_active = true; UPDATE suppliers SET ref_key_1c = NULL WHERE supplier_id <> 2;
      UPDATE suppliers SET ref_key_1c = '${COUNTERPARTY}' WHERE supplier_id = 2;
      INSERT INTO supplier_contacts(contact_id, supplier_id, kind, value, value_normalized, is_primary, position) VALUES
        (101, 1, 'phone', '+7 701 555 01 01', '${PHONE}', true, 0), (102, 1, 'phone', '8 701 555 02 02', '${SECOND_PHONE}', false, 1),
        (103, 1, 'email', 'test@example.invalid', 'test@example.invalid', true, 2), (201, 2, 'phone', '+7 701 555 03 03', '77015550303', true, 0);
      UPDATE orders SET manager_id = 12 WHERE order_id = 9001; UPDATE orders SET manager_id = 11 WHERE order_id = 9002;
      UPDATE users SET is_active = true;
      DELETE FROM role_permissions; INSERT INTO role_permissions(role_id, permission_name) SELECT 1, permission_name FROM permissions_catalog;
      INSERT INTO role_permissions(role_id, permission_name) VALUES (10, 'orders.view'), (10, 'procurement.view'), (10, 'procurement.manage');
      UPDATE whatsapp_broadcast_control SET paused = false;
      UPDATE whatsapp_order_send_settings SET last_delivery_at = NULL, next_delivery_at = NULL`);
    texts.length = 0;
    textBehaviour = async (index) => ({ messageId: `text_${index}` });
    repository.makesSends = true;
    sends.random = () => 0;
    worker.clock = () => new Date();
    await configure({ supplierRequestsEnabled: true });
  });

  const configure = async (overrides: { enabled?: boolean; supplierRequestsEnabled?: boolean }) => {
    const current = (await orderService.settings()).settings;
    return orderService.updateSettings({
      version: current.version, enabled: true, minIntervalMinutes: 1, sendWindowMinutes: 0, clientForms: [], clientCaption: 'Заказ {order_name}',
      chats: [], employees: [], ...overrides,
    }, admin, `req-${randomUUID()}`);
  };
  /** A request of one line; `orderIds` — the orders its line is for. */
  const makeRequest = async (options: { supplierKey?: string; orderIds?: number[]; status?: string } = {}) => {
    const supplierKey = options.supplierKey ?? 's:1';
    requestNumber += 1;
    const id = Number((await q(`INSERT INTO supplier_requests(request_number, supplier_id, supplier_key, supplier_name, status, comment, expected_date)
      VALUES ($1, $2, $3, 'Тест Поставщик', $4, 'Тест комментарий', '2026-10-20') RETURNING supplier_request_id`,
    [`26-${String(requestNumber).padStart(4, '0')}`, supplierKey.startsWith('s:') ? Number(supplierKey.slice(2)) : null, supplierKey,
      options.status ?? 'draft'])).rows[0].supplier_request_id);
    const line = (await q(`INSERT INTO supplier_request_lines(supplier_request_id, line_no, resource_kind, sheet_material_type_id, quantity, unit_code)
      VALUES ($1, 1, 'sheet_material', 1, 5, 'sheet') RETURNING supplier_request_line_id`, [id])).rows[0].supplier_request_line_id;
    for (const orderId of options.orderIds ?? [9002]) {
      const procurement = (await q('INSERT INTO order_resource_procurement(order_id) VALUES ($1) RETURNING order_resource_procurement_id', [orderId])).rows[0];
      await q('INSERT INTO supplier_request_line_orders(supplier_request_line_id, order_resource_procurement_id) VALUES ($1, $2)',
        [line, procurement.order_resource_procurement_id]);
    }
    return id;
  };
  /** The command of the window: the text on the screen and the phone the menu showed (the primary one by default). */
  const command = async (supplierRequestId: number, overrides: Record<string, unknown> = {}, actor: CurrentUser = admin, contactIndex = 0) => {
    const menu = await service.menu(supplierRequestId, actor);
    const contact = menu.contacts[contactIndex];
    return parseSupplierSendCommand(supplierRequestId, {
      text: TEXT, edited: false, templateId: 7, templateVersion: 3, textVersion: menu.requestVersion,
      contactId: contact?.contactId ?? 999, contactToken: contact?.token ?? 'a'.repeat(64), idempotencyKey: randomUUID(), ...overrides,
    });
  };
  const send = async (supplierRequestId: number, overrides: Record<string, unknown> = {}, actor: CurrentUser = admin, contactIndex = 0) =>
    (await service.send(await command(supplierRequestId, overrides, actor, contactIndex), actor, `req-${randomUUID()}`)).send;
  const code = async (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));
  const failure = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);
  const row = async (sendId: string) => (await q('SELECT * FROM whatsapp_order_sends WHERE send_id = $1', [sendId])).rows[0];
  const events = async (sendId: string) => (await q<{ event_type: string }>(
    'SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY event_id', [sendId])).rows.map((item) => item.event_type.replace('whatsapp.supplier_send.', ''));
  const openGate = () => q('UPDATE whatsapp_order_send_settings SET last_delivery_at = NULL, next_delivery_at = NULL');

  it('the menu shows the supplier and his phones only as masks with tokens, and says why a request cannot be sent', async () => {
    const menu = await service.menu(await makeRequest(), admin);
    expect(menu).toMatchObject({ enabled: true, unavailableReason: null, supplier: { supplierId: 1, name: 'Тест Поставщик' }, requestVersion: 0 });
    expect(menu.contacts.map((contact) => [contact.contactId, contact.masked, contact.isPrimary])).toEqual([[101, '7701***0101', true], [102, '7701***0202', false]]);
    expect(JSON.stringify(menu)).not.toContain(PHONE);
    expect(menu.contacts[0].token).toMatch(/^[0-9a-f]{64}$/);
    // A request of a 1C counterparty goes to the one supplier linked to it.
    expect((await service.menu(await makeRequest({ supplierKey: `c:${COUNTERPARTY}` }), admin)).supplier).toMatchObject({ supplierId: 2 });
    expect((await service.menu(await makeRequest({ supplierKey: 'n:тест имя' }), admin)).unavailableReason).toBe('not_linked');
    expect((await service.menu(await makeRequest({ supplierKey: 'none' }), admin)).unavailableReason).toBe('not_linked');
    expect((await service.menu(await makeRequest({ supplierKey: 's:3' }), admin)).unavailableReason).toBe('no_phone');
    expect((await service.menu(await makeRequest({ status: 'closed' }), admin)).unavailableReason).toBe('status');
    await configure({ supplierRequestsEnabled: false });
    expect(await service.menu(await makeRequest(), admin)).toMatchObject({ enabled: false, unavailableReason: 'disabled' });
    // Not all orders of the request are the user's: no menu and no send (as the commands of the request).
    const foreign = await makeRequest({ orderIds: [9001, 9002] });
    expect(await code(service.menu(foreign, manager))).toBe('SUPPLIER_REQUEST_SCOPE');
    expect(await code(service.menu(999_999, admin))).toBe('SUPPLIER_REQUEST_NOT_FOUND');
  });

  it('queues the text of the window for the chosen phone, audits it without the number or the text, and delivers it', async () => {
    const requestId = await makeRequest();
    const view = await send(requestId);
    expect(view).toMatchObject({ targetKind: 'supplier', orderId: null, supplierRequestId: requestId, recipientLabel: 'Тест Поставщик',
      recipientMasked: '7701***0101', form: 'supplier_text', state: 'queued', partsTotal: 1, position: 1 });
    const stored = await row(view.sendId);
    expect(stored).toMatchObject({ order_id: null, target_kind: 'supplier', phone_normalized: PHONE, supplier_id: '1', supplier_contact_id: '101',
      supplier_key: 's:1', supplier_request_version: 0, text_body: TEXT, text_length: TEXT.length, text_edited: false, template_id: '7', template_version: 3 });
    const audit = (await q(`SELECT a.event, a.related_order_id, a.metadata_json,
        (SELECT array_agg(r.entity_type || ':' || r.entity_id ORDER BY r.entity_type) FROM audit_log_related_entity r WHERE r.audit_id = a.audit_id) related
      FROM audit_log a WHERE a.entity_id = $1`, [view.sendId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ event: 'whatsapp.supplier_send.requested', related_order_id: '9002',
      related: ['order:9002', 'supplier:1', `supplier_request:${requestId}`] });
    expect(audit[0].metadata_json).toMatchObject({ supplierRequestId: requestId, supplierId: 1, textLength: TEXT.length, textEdited: false, orderIds: [9002] });
    const trace = JSON.stringify((await q('SELECT * FROM audit_log')).rows) + JSON.stringify((await q('SELECT * FROM outbox_events')).rows);
    expect(trace).not.toContain(PHONE);
    expect(trace).not.toContain('МДФ 16 мм');
    expect(trace).not.toContain(stored.fingerprint);
    expect((await q('SELECT payload_json, idempotency_key FROM outbox_events')).rows[0]).toMatchObject({
      idempotency_key: `whatsapp_supplier_send:${view.sendId}:requested`,
      payload_json: { eventType: 'whatsapp.supplier_send.requested', supplierRequestId: requestId, supplierId: 1, orderIds: [9002], actorUserId: 11 } });

    await worker.work();
    expect(texts).toEqual([{ chatId: `${PHONE}@c.us`, text: TEXT }]);
    expect(await row(view.sendId)).toMatchObject({ state: 'sent', provider_message_id: 'text_0' });
    expect(await events(view.sendId)).toEqual(['requested', 'sent']);
    // The journal of the queue names the request and the supplier.
    const journal = await orderService.queue({ history: true, page: 1 });
    expect(journal.items[0]).toMatchObject({ sendId: view.sendId, formTitle: 'Текст заявки поставщику', supplierRequestNumber: stored.file_name.replace('Заявка № ', '') });
  });

  it('a lost answer is replayed by the key; the key with another text is refused; the same text waiting is a duplicate, another text is a new send', async () => {
    const requestId = await makeRequest();
    const first = await command(requestId);
    const view = (await service.send(first, admin, 'req-a')).send;
    expect((await service.send(first, admin, 'req-b')).send.sendId).toBe(view.sendId);
    expect(await events(view.sendId)).toEqual(['requested']);
    expect(await code(service.send({ ...first, text: 'Тест другой текст' }, admin, 'req-c'))).toBe('IDEMPOTENCY_KEY_REUSED');
    const duplicate = await failure(send(requestId));
    expect(duplicate).toMatchObject({ code: 'ORDER_SEND_ALREADY_QUEUED', details: { sendId: view.sendId } });
    // The same text to another number of the supplier and an edited text to the same number are other sends.
    expect((await send(requestId, {}, admin, 1)).recipientMasked).toBe('7701***0202');
    expect((await send(requestId, { text: `${TEXT}\nТест правка`, edited: true })).state).toBe('queued');
    expect((await q(`SELECT count(*)::int n FROM whatsapp_order_sends`)).rows[0].n).toBe(3);
  });

  it('a long text goes as several messages in order; a later message lost → unknown PARTIAL_DELIVERY and a repeat needs the confirmation', async () => {
    const requestId = await makeRequest();
    const lines = Array.from({ length: 300 }, (_, index) => `${index + 1}. Тест позиция ${'МДФ '.repeat(8)}— ${index + 1} листов`);
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(8192);
    const view = await send(requestId, { text });
    expect(view.partsTotal).toBeGreaterThanOrEqual(3);
    const parts = (await q('SELECT part_no, text_body FROM whatsapp_order_send_parts WHERE send_id = $1 ORDER BY part_no', [view.sendId])).rows;
    expect(parts.map((part) => part.part_no)).toEqual(Array.from({ length: view.partsTotal - 1 }, (_, index) => index + 2));
    const stored = [(await row(view.sendId)).text_body as string, ...parts.map((part) => part.text_body as string)];
    expect(stored.every((message) => message.length <= 4096)).toBe(true);
    expect(stored.join('\n')).toBe(text);

    await worker.work();
    expect(texts.map((item) => item.text)).toEqual(stored);
    expect(await row(view.sendId)).toMatchObject({ state: 'sent' });
    expect((await q(`SELECT metadata_json FROM audit_log WHERE entity_id = $1 AND event = 'whatsapp.supplier_send.sent'`, [view.sendId])).rows[0].metadata_json)
      .toMatchObject({ partsTotal: view.partsTotal, partsSent: view.partsTotal });

    // The second message of another send is lost: nothing is repeated, the outcome is unknown with how many went.
    texts.length = 0;
    await openGate();
    textBehaviour = async (index) => { if (index === 1) throw new ApiError(502, 'WAHA_UNAVAILABLE', 'down'); return { messageId: `text_${index}` }; };
    const edited = `${text}\nТест правка`;
    const second = await send(requestId, { text: edited, edited: true });
    await worker.work();
    expect(texts).toHaveLength(1);
    expect(await row(second.sendId)).toMatchObject({ state: 'unknown', error_code: 'PARTIAL_DELIVERY', provider_message_id: 'text_0' });
    expect(await events(second.sendId)).toEqual(['requested', 'unknown']);
    expect((await q(`SELECT payload_json FROM outbox_events WHERE aggregate_id = $1 AND event_type LIKE '%unknown'`, [second.sendId])).rows[0].payload_json)
      .toMatchObject({ partsSent: 1, partsTotal: second.partsTotal, errorCode: 'PARTIAL_DELIVERY' });
    const again = await failure(send(requestId, { text: edited, edited: true }));
    expect(again).toMatchObject({ code: 'ORDER_SEND_PREVIOUS_UNKNOWN', details: { sendId: second.sendId } });
    // The refusal is recorded against its key: a late copy of that command stays refused after the confirmed repeat
    // was delivered — it can never become one more send.
    const lost = await command(requestId, { text: edited, edited: true });
    expect(await failure(service.send(lost, admin, 'req-lost'))).toMatchObject({ code: 'ORDER_SEND_PREVIOUS_UNKNOWN', details: { final: true, sendId: second.sendId } });
    const confirmed = await send(requestId, { text: edited, edited: true, confirmAfterUnknown: second.sendId });
    expect(confirmed.state).toBe('queued');
    textBehaviour = async (index) => ({ messageId: `text_${index}` });
    await openGate();
    await worker.work();
    expect(await row(confirmed.sendId)).toMatchObject({ state: 'sent' });
    expect(await failure(service.send(lost, admin, 'req-late'))).toMatchObject({ code: 'ORDER_SEND_PREVIOUS_UNKNOWN', details: { final: true } });
    expect((await q(`SELECT count(*)::int n FROM whatsapp_order_sends WHERE text_length = $1`, [edited.length])).rows[0].n).toBe(2);
  });

  it('a text that cannot be sent is refused by the parser: empty, too long, control characters; line endings are normalized', async () => {
    const body = { edited: false, templateId: null, templateVersion: null, textVersion: 0, contactId: 101, contactToken: 'a'.repeat(64), idempotencyKey: randomUUID() };
    const reason = (text: string) => { try { parseSupplierSendCommand(1, { ...body, text }); return 'ok'; } catch (error) { return (error as ApiError).details?.reason ?? (error as ApiError).code; } };
    expect(reason('  \n ')).toBe('empty');
    expect(reason('а'.repeat(20_001))).toBe('too_long');
    expect(reason('Тест\u0007')).toBe('control_characters');
    expect(reason('а'.repeat(20_000))).toBe('ok');
    expect(parseSupplierSendCommand(1, { ...body, text: 'Тест\r\nстрока\rещё' }).text).toBe('Тест\nстрока\nещё');
    expect(() => parseSupplierSendCommand(1, { ...body, contactId: null, text: 'Тест' })).toThrow();
    expect(() => parseSupplierSendCommand(1, { ...body, contactToken: undefined, text: 'Тест' })).toThrow();
  });

  it('a request or a recipient that is not what the window showed is refused for good, with the audit, and stays refused', async () => {
    const requestId = await makeRequest();
    // The number of the chosen contact was edited after the menu was built.
    const stale = await command(requestId);
    await q(`UPDATE supplier_contacts SET value_normalized = '77015559999' WHERE contact_id = 101`);
    const changed = await failure(service.send(stale, admin, 'req-phone'));
    expect(changed).toMatchObject({ code: 'ORDER_SEND_PHONE_CHANGED', details: { final: true } });
    // The number is back: the same command stays refused (the browser has dropped its key).
    await q(`UPDATE supplier_contacts SET value_normalized = '${PHONE}' WHERE contact_id = 101`);
    expect(await failure(service.send(stale, admin, 'req-phone-2'))).toMatchObject({ code: 'ORDER_SEND_PHONE_CHANGED', details: { final: true } });
    expect((await q('SELECT error_code, supplier_request_id FROM whatsapp_order_send_refusals')).rows).toEqual([
      { error_code: 'ORDER_SEND_PHONE_CHANGED', supplier_request_id: String(requestId) }]);
    const audit = (await q(`SELECT metadata_json, entity_type, entity_id FROM audit_log WHERE event = 'whatsapp.supplier_send.refused'`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity_type: 'supplier_request', entity_id: String(requestId), metadata_json: { final: true, errorCode: 'ORDER_SEND_PHONE_CHANGED', supplierId: 1 } });
    expect(JSON.stringify(audit)).not.toContain(stale.contactToken);

    // The text was built from an older version of the request.
    const old = await command(requestId);
    await q('UPDATE supplier_requests SET version = version + 1 WHERE supplier_request_id = $1', [requestId]);
    expect(await failure(service.send(old, admin, 'req-version'))).toMatchObject({ code: 'SUPPLIER_REQUEST_VERSION_CONFLICT', details: { final: true, version: 1 } });
    // A contact of another supplier, a removed contact, an email.
    expect(await code(send(requestId, { contactId: 201 }))).toBe('SUPPLIER_CONTACT_MISSING');
    expect(await code(send(requestId, { contactId: 103 }))).toBe('SUPPLIER_CONTACT_MISSING');
    // A request without a supplier of the directory, a closed one, an inactive supplier.
    expect(await code(send(await makeRequest({ supplierKey: 'n:тест имя' })))).toBe('SUPPLIER_NOT_LINKED');
    expect(await code(send(await makeRequest({ status: 'cancelled' })))).toBe('SUPPLIER_REQUEST_NOT_SENDABLE');
    await q('UPDATE suppliers SET is_active = false WHERE supplier_id = 1');
    expect(await code(send(requestId))).toBe('SUPPLIER_INACTIVE');
    expect((await q('SELECT count(*)::int n FROM whatsapp_order_sends')).rows[0].n).toBe(0);
    expect((await q(`SELECT count(*)::int n FROM whatsapp_order_send_refusals`)).rows[0].n).toBe(7);
  });

  it('refusals that do not end the command: switched off, paused, a foreign request — audited, the key stays usable', async () => {
    const requestId = await makeRequest();
    const pending = await command(requestId);
    await configure({ supplierRequestsEnabled: false });
    const off = await failure(service.send(pending, admin, 'req-off'));
    expect(off).toMatchObject({ code: 'SUPPLIER_SEND_DISABLED' });
    expect(off?.details?.final).toBeUndefined();
    await configure({ supplierRequestsEnabled: true });
    await q('UPDATE whatsapp_broadcast_control SET paused = true');
    expect(await code(service.send(pending, admin, 'req-paused'))).toBe('ORDER_SEND_PAUSED');
    await q('UPDATE whatsapp_broadcast_control SET paused = false');
    expect((await service.send(pending, admin, 'req-on')).send.state).toBe('queued');
    expect((await q(`SELECT status_code FROM audit_log WHERE event = 'whatsapp.supplier_send.refused' ORDER BY created_at`)).rows.map((item) => item.status_code))
      .toEqual(['SUPPLIER_SEND_DISABLED', 'ORDER_SEND_PAUSED']);
    expect((await q('SELECT count(*)::int n FROM whatsapp_order_send_refusals')).rows[0].n).toBe(0);
    // A manager sends only a request whose orders are all his.
    const own = await makeRequest({ orderIds: [9001] });
    expect((await send(own, {}, manager)).state).toBe('queued');
    const mixed = await makeRequest({ orderIds: [9001, 9002] });
    const body = { ...(await command(mixed)), idempotencyKey: randomUUID() };
    expect(await code(service.send(body, manager, 'req-scope'))).toBe('SUPPLIER_REQUEST_SCOPE');
  });

  it('«Отметить отправленной» keeps a waiting send; a changed, cancelled or closed request cancels it', async () => {
    const marked = await send(await makeRequest());
    await q(`UPDATE supplier_requests SET status = 'sent', version = version + 1 WHERE supplier_request_id = $1`, [marked.supplierRequestId]);
    await worker.work();
    expect(await row(marked.sendId)).toMatchObject({ state: 'sent' });

    for (const change of [
      `UPDATE supplier_request_lines SET quantity = 6 WHERE supplier_request_id = $1`,
      `UPDATE supplier_requests SET comment = 'Тест другой комментарий' WHERE supplier_request_id = $1`,
      `UPDATE supplier_requests SET expected_date = '2026-11-01' WHERE supplier_request_id = $1`,
      `UPDATE supplier_requests SET status = 'cancelled' WHERE supplier_request_id = $1`,
      `UPDATE supplier_requests SET status = 'closed' WHERE supplier_request_id = $1`,
      `DELETE FROM supplier_requests WHERE supplier_request_id = $1`,
    ]) {
      await openGate();
      const view = await send(await makeRequest());
      await q(change, [view.supplierRequestId]);
      texts.length = 0;
      await worker.work();
      expect(await row(view.sendId), change).toMatchObject({ state: 'cancelled', cancel_reason: 'request_changed' });
      expect(texts, change).toEqual([]);
      expect(await events(view.sendId), change).toEqual(['requested', 'cancelled']);
    }
  });

  it('the worker never redirects: another supplier, another number, a removed contact, an inactive supplier cancel', async () => {
    const cases: Array<[string, string, string?]> = [
      [`UPDATE supplier_contacts SET value_normalized = '77015558888' WHERE contact_id = 201`, 'recipient_changed'],
      [`DELETE FROM supplier_contacts WHERE contact_id = 201`, 'recipient_removed'],
      [`UPDATE supplier_contacts SET kind = 'telegram', value_normalized = 'test_supplier' WHERE contact_id = 201`, 'recipient_changed'],
      [`UPDATE suppliers SET is_active = false WHERE supplier_id = 2`, 'recipient_removed'],
      // The counterparty of the request is linked to another supplier now, or to nobody.
      [`UPDATE suppliers SET ref_key_1c = NULL WHERE supplier_id = 2; UPDATE suppliers SET ref_key_1c = '${COUNTERPARTY}' WHERE supplier_id = 1`, 'recipient_changed'],
      [`UPDATE suppliers SET ref_key_1c = NULL WHERE supplier_id = 2`, 'recipient_removed'],
    ];
    for (const [change, reason] of cases) {
      await q(`DELETE FROM supplier_contacts WHERE contact_id = 201;
        INSERT INTO supplier_contacts(contact_id, supplier_id, kind, value, value_normalized, is_primary) VALUES (201, 2, 'phone', '+7 701 555 03 03', '77015550303', true);
        UPDATE suppliers SET is_active = true; UPDATE suppliers SET ref_key_1c = NULL WHERE supplier_id = 1;
        UPDATE suppliers SET ref_key_1c = '${COUNTERPARTY}' WHERE supplier_id = 2`);
      await openGate();
      const view = await send(await makeRequest({ supplierKey: `c:${COUNTERPARTY}` }));
      expect((await row(view.sendId)).supplier_id).toBe('2');
      await q(change);
      texts.length = 0;
      await worker.work();
      expect(await row(view.sendId), change).toMatchObject({ state: 'cancelled', cancel_reason: reason });
      expect(texts, change).toEqual([]);
    }
  });

  it('the author must still have the rights and the whole scope of the request when the text leaves', async () => {
    // The manager of the order changed while the send waited.
    const scoped = await send(await makeRequest({ orderIds: [9001] }), {}, manager);
    await q('UPDATE orders SET manager_id = 11 WHERE order_id = 9001');
    await worker.work();
    expect(await row(scoped.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'permission_revoked' });
    await q('UPDATE orders SET manager_id = 12 WHERE order_id = 9001');
    // A deleted order of the request still counts (deletion gives no rights and takes none).
    await openGate();
    const deleted = await send(await makeRequest({ orderIds: [9001] }), {}, manager);
    await q('UPDATE orders SET delete_flag = true, deleted_at = now() WHERE order_id = 9001');
    await worker.work();
    expect(await row(deleted.sendId)).toMatchObject({ state: 'sent' });
    await q('UPDATE orders SET delete_flag = false, deleted_at = NULL WHERE order_id = 9001');
    // The right was taken from the role.
    await openGate();
    const revoked = await send(await makeRequest({ orderIds: [9001] }), {}, manager);
    await q(`DELETE FROM role_permissions WHERE role_id = 10 AND permission_name = 'procurement.manage'`);
    await worker.work();
    expect(await row(revoked.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'permission_revoked' });
    // The author was deactivated.
    await q(`INSERT INTO role_permissions(role_id, permission_name) VALUES (10, 'procurement.manage')`);
    await openGate();
    const inactive = await send(await makeRequest({ orderIds: [9001] }), {}, manager);
    await q('UPDATE users SET is_active = false WHERE user_id = 12');
    await worker.work();
    expect(await row(inactive.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'permission_revoked' });
  });

  it('switching supplier requests off cancels the waiting ones (and only them); the author or a manager cancels by hand', async () => {
    const view = await send(await makeRequest());
    const manual = await send(await makeRequest());
    expect((await orderService.cancel(manual.sendId, admin, 'req-cancel')).send).toMatchObject({ state: 'cancelled', cancelReason: 'manual' });
    expect(await events(manual.sendId)).toEqual(['requested', 'cancelled']);
    // The manager's send is cancelled by the admin who switches the feature off: the admin is the actor of the
    // cancellation in the audit and in the event, the manager stays linked as the author of the send.
    const foreign = await send(await makeRequest({ orderIds: [9001] }), {}, manager);
    await configure({ supplierRequestsEnabled: false });
    expect(await row(view.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'disabled' });
    expect(await events(view.sendId)).toEqual(['requested', 'cancelled']);
    expect((await q(`SELECT user_id, username, related_user_id, related_order_id FROM audit_log
      WHERE entity_id = $1 AND event = 'whatsapp.supplier_send.cancelled'`, [foreign.sendId])).rows[0])
      .toMatchObject({ user_id: '11', username: 'supplier-send-admin', related_user_id: '12', related_order_id: '9001' });
    expect((await q(`SELECT payload_json FROM outbox_events WHERE aggregate_id = $1 AND event_type LIKE '%cancelled'`, [foreign.sendId])).rows[0].payload_json)
      .toMatchObject({ actorUserId: 11, sendActorUserId: 12, cancelReason: 'disabled' });
    // A request of several orders is found in the audit by each of them.
    const several = await makeRequest({ orderIds: [9001, 9002] });
    await configure({ supplierRequestsEnabled: true });
    const wide = await send(several);
    expect((await q(`SELECT a.related_order_id, (SELECT array_agg(r.entity_id ORDER BY r.entity_id) FROM audit_log_related_entity r
        WHERE r.audit_id = a.audit_id AND r.entity_type = 'order') orders FROM audit_log a WHERE a.entity_id = $1`, [wide.sendId])).rows[0])
      .toEqual({ related_order_id: null, orders: ['9001', '9002'] });
    await configure({ supplierRequestsEnabled: false });
    // A settings client of the previous release sends no flag: the switch stays.
    const current = (await orderService.settings()).settings;
    await orderService.updateSettings({ version: current.version, enabled: true, minIntervalMinutes: 1, sendWindowMinutes: 0, clientForms: [],
      clientCaption: 'Заказ {order_name}', chats: [], employees: [] }, admin, 'req-old-client');
    expect((await orderService.settings()).settings.supplierRequestsEnabled).toBe(false);
  });

  it('a command of the request and an order command racing with the last check: the committed change wins, no deadlock', async () => {
    // A procurement command (actor FOR SHARE → request FOR UPDATE) is in flight when the worker reaches the request.
    const view = await send(await makeRequest());
    const other = await pool.connect();
    try {
      await other.query(`SET search_path="${schema}",public`);
      await other.query('BEGIN');
      await other.query('SELECT 1 FROM users WHERE user_id = 11 FOR SHARE');
      await other.query('SELECT 1 FROM supplier_requests WHERE supplier_request_id = $1 FOR UPDATE', [view.supplierRequestId]);
      const delivery = worker.work();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await row(view.sendId)).state).toBe('queued');
      await other.query('UPDATE supplier_request_lines SET quantity = 9 WHERE supplier_request_id = $1', [view.supplierRequestId]);
      await other.query('UPDATE supplier_requests SET version = version + 1 WHERE supplier_request_id = $1', [view.supplierRequestId]);
      await other.query('COMMIT');
      await delivery;
      expect(await row(view.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'request_changed' });

      // An order command holds the order of the request (FOR UPDATE) and changes its manager.
      await openGate();
      const scoped = await send(await makeRequest({ orderIds: [9001] }), {}, manager);
      await other.query('BEGIN');
      await other.query('SELECT 1 FROM orders WHERE order_id = 9001 FOR UPDATE');
      const second = worker.work();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await row(scoped.sendId)).state).toBe('queued');
      await other.query('UPDATE orders SET manager_id = 11 WHERE order_id = 9001');
      await other.query('COMMIT');
      await second;
      expect(await row(scoped.sendId)).toMatchObject({ state: 'cancelled', cancel_reason: 'permission_revoked' });
      expect(texts).toEqual([]);

      // The contacts command (supplier FOR NO KEY UPDATE → contacts) against the command of the window.
      const requestId = await makeRequest();
      const pending = await command(requestId);
      await other.query('BEGIN');
      await other.query('SELECT 1 FROM suppliers WHERE supplier_id = 1 FOR NO KEY UPDATE');
      const sending = failure(service.send(pending, admin, 'req-race'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await other.query(`UPDATE supplier_contacts SET value_normalized = '77015557777' WHERE contact_id = 101`);
      await other.query('COMMIT');
      expect(await sending).toMatchObject({ code: 'ORDER_SEND_PHONE_CHANGED', details: { final: true } });
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      other.release();
    }
  });

  it('the compatible release makes no new sends — a final refusal — but replays, re-checks, delivers, expires and purges the existing ones', async () => {
    const requestId = await makeRequest();
    const accepted = await command(requestId);
    const view = (await service.send(accepted, admin, 'req-full')).send;
    const long = await send(await makeRequest(), { text: Array.from({ length: 400 }, (_, index) => `Тест строка ${index} ${'х'.repeat(20)}`).join('\n') });
    const waiting = await send(await makeRequest());
    repository.makesSends = false;
    expect(await service.menu(requestId, admin)).toMatchObject({ enabled: false, unavailableReason: 'release' });
    // An accepted command is replayed; a new one is refused for good and stays refused after the full release is back.
    expect((await service.send(accepted, admin, 'req-replay')).send.sendId).toBe(view.sendId);
    const fresh = await command(await makeRequest());
    expect(await failure(service.send(fresh, admin, 'req-new'))).toMatchObject({ code: 'SUPPLIER_SEND_UNAVAILABLE', details: { final: true } });
    repository.makesSends = true;
    expect(await failure(service.send(fresh, admin, 'req-new-2'))).toMatchObject({ code: 'SUPPLIER_SEND_UNAVAILABLE', details: { final: true } });
    repository.makesSends = false;
    // Waiting rows are delivered in order, with the full re-check.
    await worker.work();
    expect(await row(view.sendId)).toMatchObject({ state: 'sent' });
    await openGate();
    await worker.work();
    expect(await row(long.sendId)).toMatchObject({ state: 'sent' });
    expect(texts.length).toBe(1 + long.partsTotal);
    // A waiting send past its life expires once, with one event.
    await q(`UPDATE whatsapp_order_sends SET queue_expires_at = now() - interval '1 minute' WHERE send_id = $1`, [waiting.sendId]);
    await worker.cleanup();
    await worker.cleanup();
    expect(await row(waiting.sendId)).toMatchObject({ state: 'expired' });
    expect(await events(waiting.sendId)).toEqual(['requested', 'expired']);
    // An interrupted delivery becomes unknown with its event.
    await openGate();
    const interrupted = await (async () => { repository.makesSends = true; const made = await send(await makeRequest()); repository.makesSends = false; return made; })();
    await q(`UPDATE whatsapp_order_sends SET state = 'sending', attempt_count = 1, lock_token = gen_random_uuid(), send_started_at = now() - interval '1 hour'
      WHERE send_id = $1`, [interrupted.sendId]);
    expect(await sends.markStaleIntentsUnknown(10 * 60_000)).toBe(1);
    expect(await events(interrupted.sendId)).toEqual(['requested', 'unknown']);
    // Retention: the text of the send and of every part goes together with the phone and the provider ids.
    await worker.cleanup(new Date(Date.now() + 8 * 24 * 60 * 60_000));
    expect(await row(long.sendId)).toMatchObject({ text_body: null, phone_normalized: null, provider_message_id: null, destination_chat_id: null });
    expect((await row(long.sendId)).purged_at).not.toBeNull();
    expect((await row(long.sendId)).text_sha256).toMatch(/^[0-9a-f]{64}$/);
    const parts = (await q('SELECT text_body, provider_message_id, purged_at FROM whatsapp_order_send_parts WHERE send_id = $1', [long.sendId])).rows;
    expect(parts.length).toBe(long.partsTotal - 1);
    expect(parts.every((part) => part.text_body === null && part.provider_message_id === null && part.purged_at !== null)).toBe(true);
    await worker.cleanup(new Date(Date.now() + 8 * 24 * 60 * 60_000));
    // The journal still reads the purged rows.
    const journal = await orderService.queue({ history: true, page: 1 });
    expect(journal.items.find((item) => item.sendId === long.sendId)).toMatchObject({ targetKind: 'supplier', orderId: null, partsTotal: long.partsTotal });
  });

  it('a part left with its text by an interrupted purge is cleared by the next run', async () => {
    const view = await send(await makeRequest(), { text: Array.from({ length: 400 }, (_, index) => `Тест строка ${index} ${'х'.repeat(20)}`).join('\n') });
    await worker.work();
    await q(`UPDATE whatsapp_order_sends SET text_body = NULL, phone_normalized = NULL, destination_chat_id = NULL, provider_message_id = NULL,
      purged_at = now() WHERE send_id = $1`, [view.sendId]);
    await worker.cleanup();
    const parts = (await q('SELECT text_body, purged_at FROM whatsapp_order_send_parts WHERE send_id = $1', [view.sendId])).rows;
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every((part) => part.text_body === null && part.purged_at !== null)).toBe(true);
  });

  it('a send is purged with all its parts even while a backlog of older parts exceeds the backlog pass', async () => {
    const long = Array.from({ length: 400 }, (_, index) => `Тест строка ${index} ${'х'.repeat(20)}`).join('\n');
    const old = await send(await makeRequest(), { text: long });
    await worker.work();
    await openGate();
    const fresh = await send(await makeRequest(), { text: `${long}\nТест` });
    await worker.work();
    // The backlog: a parent marked purged by an earlier release, its parts still holding text.
    await q(`UPDATE whatsapp_order_sends SET text_body = NULL, phone_normalized = NULL, destination_chat_id = NULL, provider_message_id = NULL,
      purged_at = now() WHERE send_id = $1`, [old.sendId]);
    sends.purgeBacklogLimit = 1;
    try {
      await worker.cleanup(new Date(Date.now() + 8 * 24 * 60 * 60_000));
    } finally {
      sends.purgeBacklogLimit = 2000;
    }
    expect((await row(fresh.sendId)).purged_at).not.toBeNull();
    const left = async (sendId: string) => (await q(`SELECT count(*)::int n FROM whatsapp_order_send_parts WHERE send_id = $1 AND text_body IS NOT NULL`, [sendId])).rows[0].n;
    expect(await left(fresh.sendId)).toBe(0);
    expect(await left(old.sendId)).toBe(old.partsTotal - 2);
  });

  it('the schema refuses a supplier row without its request or with an order, and a purged row that keeps its text', async () => {
    const view = await send(await makeRequest());
    await expect(q(`UPDATE whatsapp_order_sends SET order_id = 9001 WHERE send_id = $1`, [view.sendId])).rejects.toThrow(/chk_whatsapp_order_sends_target/);
    await expect(q(`UPDATE whatsapp_order_sends SET supplier_request_id = NULL WHERE send_id = $1`, [view.sendId])).rejects.toThrow(/chk_whatsapp_order_sends_target/);
    await expect(q(`UPDATE whatsapp_order_sends SET text_body = NULL WHERE send_id = $1`, [view.sendId])).rejects.toThrow(/chk_whatsapp_order_sends_payload/);
    await expect(q(`UPDATE whatsapp_order_sends SET state = 'failed', phone_normalized = NULL, purged_at = now() WHERE send_id = $1`, [view.sendId]))
      .rejects.toThrow(/chk_whatsapp_order_sends_purged/);
    const unvalidated = (await q(`SELECT count(*)::int n FROM pg_constraint WHERE NOT convalidated
      AND conrelid IN ('"${schema}".whatsapp_order_sends'::regclass, '"${schema}".whatsapp_order_send_parts'::regclass)`)).rows[0].n;
    expect(unvalidated).toBe(0);
  });
});
