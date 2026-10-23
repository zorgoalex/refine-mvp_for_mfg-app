import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { ROLE_POLICIES } from '../../permissions/policies/role-policies';
import { scopeSetsFromPolicy, type ScopeGrant } from '../../permissions/policies/scope-sets';
import type { PermissionName } from '../../permissions/permissions';
import { ClientCounterpartyRepository } from './client-counterparty.repository';
import { ClientOnecDocumentsService, summarize } from './client-onec-documents.service';

// «Документы 1С» of the client card. Owned disposable database film_catalog_it_* (schema-only copy of erp_test);
// 1C documents, orders and clients are inserted directly (session_replication_role=replica — no reference chains).
const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;
const FULL: PermissionName[] = ['clients.view', 'clients.onec_documents.view', 'orders.view', 'orders.view_financials'];

describe.skipIf(!url)('1C documents of a client — read model, real PostgreSQL', { timeout: 120000 }, () => {
  let database: DatabaseService;
  let db: Client;
  let source = 0;
  let otherSource = 0;
  const tag = `E2E-Тест-дк-${randomUUID().slice(0, 6)}`;
  const SERIES = `Т${randomUUID().replace(/\D/g, '').slice(0, 4).padEnd(4, '7')}`;
  const base = 700_000_000 + Math.floor(Math.random() * 90_000_000);
  let nextId = base;
  const id = () => (nextId += 1);
  const ADMIN = id();
  const MANAGER = id();
  const OTHER = id();
  const CLIENT = id();
  const UNLINKED = id();
  const K = () => randomUUID();
  const COUNTERPARTY = K();
  const STRANGER = K();

  const user = (userId: number, role: 'admin' | 'manager', permissions: PermissionName[] = FULL): CurrentUser =>
    ({ id: String(userId), username: `${tag}-${userId}`, role, roleId: role === 'admin' ? 1 : 10, permissions, policyScopes: ROLE_POLICIES[role] });
  // A reader whose order visibility comes from access groups (effective scope sets of the token), whatever his role.
  const grouped = (userId: number, role: 'admin' | 'manager', view: ScopeGrant[]): CurrentUser => {
    const sets = scopeSetsFromPolicy(ROLE_POLICIES[role]);
    return { ...user(userId, role), policyScopeSets: { ...sets, orders: { ...sets.orders, view } } };
  };
  const service = (series: string | null = SERIES) => new ClientOnecDocumentsService(
    database, new ClientCounterpartyRepository(database),
    new ConfigService<BackendEnv, true>({ BACKEND_ONEC_ORDER_NUMBER_SERIES: series ?? '' } as Partial<BackendEnv>));
  const list = (reader: CurrentUser, query: { group?: 'orders' | 'shipments' | 'receipts' | 'refunds'; page?: number; pageSize?: number } = {}, clientId = CLIENT, series: string | null = SERIES) =>
    service(series).list(reader, clientId, { page: 1, pageSize: 100, ...query }, `req-${randomUUID().slice(0, 8)}`);
  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof ApiError ? error.code : String(error)));

  const replica = async (sql: string, params: unknown[] = []) => {
    await db.query('SET session_replication_role = replica');
    try {
      return await db.query(sql, params);
    } finally {
      await db.query('SET session_replication_role = origin');
    }
  };
  const erpOrder = async (name: string, options: { date?: string; createdBy?: number; managerId?: number | null; deleted?: boolean } = {}) => {
    const orderId = id();
    await replica(
      `INSERT INTO orders (order_id, order_name, client_id, order_status_id, payment_status_id, created_by, manager_id, project_id, order_date,
                           order_kind, delete_flag, final_amount, total_amount, legacy_duplicate_name_exempt, source_system)
       OVERRIDING SYSTEM VALUE VALUES ($1, $2, 1, 1, 1, $3, $4, 1, $5::date, 'production_order', $6, 1000, 1000, false, 'erp')`,
      [orderId, name, options.createdBy ?? ADMIN, options.managerId ?? null, options.date ?? '2026-09-01', options.deleted ?? false]);
    return orderId;
  };
  const onecDoc = async (kind: string, number: string, date: string, amount: number | null, options: {
    posted?: boolean; deleted?: boolean; missing?: boolean; counterparty?: string | null; orderRef?: string | null; ref?: string; sourceId?: number; currency?: string; responsible?: string;
  } = {}) => {
    const ref = options.ref ?? K();
    const { rows } = await db.query(
      `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, deleted_in_onec, currency, counterparty_ref_key,
                                   counterparty_name, applied_revision, missing_in_source_at, amount, onec_order_ref_key, responsible_name)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, 1, CASE WHEN $11 THEN now() END, $12, $13, $14) RETURNING onec_document_id::text AS id`,
      [options.sourceId ?? source, kind, ref, number, date, options.posted ?? true, options.deleted ?? false, options.currency ?? 'KZT',
        options.counterparty === undefined ? COUNTERPARTY : options.counterparty, `${tag} покупатель`, options.missing ?? false, amount,
        options.orderRef ?? null, options.responsible ?? null]);
    return { id: rows[0].id as string, ref };
  };
  const line = (docId: string, lineNo: number, amount: number, orderRef: string | null, options: { removed?: boolean; section?: string } = {}) => db.query(
    `INSERT INTO onec_document_lines (onec_document_id, line_no, quantity, amount, line_section, onec_order_ref_key, removed_in_onec_at)
     VALUES ($1, $2, 0, $3, $4, $5, CASE WHEN $6 THEN now() END)`, [docId, lineNo, amount, options.section ?? 'payment', orderRef, options.removed ?? false]);
  const manualLink = (orderRef: string, orderId: number | null) => replica(
    `INSERT INTO order_onec_order_links (source_id, onec_order_ref_key, order_id, created_by) VALUES ($1, $2, $3, $4)`, [source, orderRef, orderId, ADMIN]);
  const ids = (response: { data: Array<{ id: string }> }) => response.data.map((row) => row.id);

  // The documents of the counterparty, filled once (reads only afterwards).
  const doc: Record<string, { id: string; ref: string }> = {};
  const erp: Record<string, number> = {};

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    db = new Client({ connectionString: url });
    await db.connect();
    const config = new ConfigService<BackendEnv, true>({
      DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 3, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 15000,
    } as Partial<BackendEnv>);
    database = new DatabaseService(config, { measure: (_text: string, run: () => Promise<unknown>) => run() } as never);
    const newSource = async () => Number((await db.query('INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id',
      [`it-${randomUUID().slice(0, 8)}`, `${tag} база`])).rows[0].source_id);
    source = await newSource();
    otherSource = await newSource();
    for (const [userId, name] of [[ADMIN, 'admin'], [MANAGER, 'manager'], [OTHER, 'other']] as const) {
      await replica(`INSERT INTO users (user_id, username, password_hash, email, role_id) OVERRIDING SYSTEM VALUE VALUES ($1, $2, 'x', $3, 1)`,
        [userId, `${tag}-${name}`, `${name}-${userId}@example.test`]);
    }
    await replica(`INSERT INTO clients (client_id, client_name, ref_key_1c) OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3), ($4, $5, NULL)`,
      [CLIENT, `${tag} клиент`, COUNTERPARTY, UNLINKED, `${tag} без контрагента`]);

    // ERP orders: the manager's own (as creator and as manager), another manager's, a deleted own one.
    erp.mine = await erpOrder('7101', { createdBy: MANAGER });
    erp.managed = await erpOrder('7102', { createdBy: OTHER, managerId: MANAGER });
    erp.foreign = await erpOrder('7103', { createdBy: OTHER });
    erp.deleted = await erpOrder('7104', { createdBy: MANAGER, deleted: true });
    erp.manual = await erpOrder('7105', { createdBy: MANAGER });
    erp.banned = await erpOrder('7106', { createdBy: MANAGER });

    // 1C customer orders: by the series rule, by a manual link, banned by a manual link, of no ERP order.
    doc.orderMine = await onecDoc('customer_order', `${SERIES}-7101`, '2026-09-02', 1000, { responsible: 'Иванов' });
    doc.orderManaged = await onecDoc('customer_order', `${SERIES}-7102`, '2026-09-03', 2000);
    doc.orderForeign = await onecDoc('customer_order', `${SERIES}-7103`, '2026-09-04', 4000);
    doc.orderDeleted = await onecDoc('customer_order', `${SERIES}-7104`, '2026-09-05', 8000);
    doc.orderManual = await onecDoc('customer_order', 'ДР-1', '2026-09-06', 16000);
    doc.orderBanned = await onecDoc('customer_order', `${SERIES}-7106`, '2026-09-07', 32000);
    doc.orderLoose = await onecDoc('customer_order', 'ДР-2', '2026-09-08', 64000, { posted: false });
    await manualLink(doc.orderManual.ref, erp.manual);
    await manualLink(doc.orderBanned.ref, null);
    await db.query(`INSERT INTO onec_customer_orders (onec_document_id, state_name) VALUES ($1, 'В работе')`, [doc.orderMine.id]);

    // Shipments: of the manager's order (header), of another manager's order, with a line of another manager's order.
    doc.shipMine = await onecDoc('sales_shipment', `${tag}-s1`, '2026-09-10', 900, { orderRef: doc.orderMine.ref });
    doc.shipForeign = await onecDoc('sales_shipment', `${tag}-s2`, '2026-09-11', 3900, { orderRef: doc.orderForeign.ref });
    doc.shipMixed = await onecDoc('sales_shipment', `${tag}-s3`, '2026-09-12', 500, { orderRef: doc.orderMine.ref });
    await line(doc.shipMixed.id, 1, 500, doc.orderForeign.ref, { section: 'goods' });
    // A line without an order follows the order of the shipment header.
    doc.shipInherit = await onecDoc('sales_shipment', `${tag}-s5`, '2026-09-09', 40, { orderRef: doc.orderMine.ref });
    await line(doc.shipInherit.id, 1, 40, null, { section: 'goods' });
    doc.shipDeleted = await onecDoc('sales_shipment', `${tag}-s4`, '2026-09-13', 100, { orderRef: doc.orderMine.ref, deleted: true });

    // Receipts: of the manager's orders only; mixed with another manager's; with a removed foreign line; without an order.
    doc.payMine = await onecDoc('bank_receipt', `${tag}-p1`, '2026-09-15', 700);
    await line(doc.payMine.id, 1, 400, doc.orderMine.ref);
    await line(doc.payMine.id, 2, 300, doc.orderManaged.ref);
    doc.payMixed = await onecDoc('cash_receipt', `${tag}-p2`, '2026-09-16', 250);
    await line(doc.payMixed.id, 1, 100, doc.orderMine.ref);
    await line(doc.payMixed.id, 2, 150, doc.orderForeign.ref);
    doc.payCleaned = await onecDoc('cash_receipt', `${tag}-p3`, '2026-09-17', 60);
    await line(doc.payCleaned.id, 1, 60, doc.orderManual.ref);
    await line(doc.payCleaned.id, 2, 40, doc.orderForeign.ref, { removed: true });
    // 100 of the manager's order and 900 of nobody knows what (a line without an order).
    doc.payPartly = await onecDoc('cash_receipt', `${tag}-p6`, '2026-09-14', 1000);
    await line(doc.payPartly.id, 1, 100, doc.orderMine.ref);
    await line(doc.payPartly.id, 2, 900, null);
    doc.payLoose = await onecDoc('bank_receipt', `${tag}-p4`, '2026-09-18', 11);
    await line(doc.payLoose.id, 1, 11, null);
    doc.payMissing = await onecDoc('bank_receipt', `${tag}-p5`, '2026-09-19', 5, { missing: true });
    await line(doc.payMissing.id, 1, 5, doc.orderMine.ref);

    // Refunds refer to a receipt, not to an order.
    doc.refund = await onecDoc('bank_refund', `${tag}-r1`, '2026-09-20', 50);
    await line(doc.refund.id, 1, 50, null);

    // Not of this client: another counterparty, no counterparty, a purchase document of the same counterparty, the same key
    // of an order in another 1C base (its ERP order must not be resolved through this base's link).
    doc.stranger = await onecDoc('customer_order', `${SERIES}-7101`, '2026-09-02', 999, { counterparty: STRANGER });
    doc.nobody = await onecDoc('bank_receipt', `${tag}-x1`, '2026-09-02', 999, { counterparty: null });
    doc.purchase = await onecDoc('purchase_receipt', `${tag}-x2`, '2026-09-02', 999);
    doc.otherBase = await onecDoc('sales_shipment', `${tag}-x3`, '2026-09-21', 77, { sourceId: otherSource, orderRef: doc.orderManual.ref });
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
    await db?.end();
  });

  it('a reader of all orders sees every customer document of the counterparty, newest first, and nothing else', async () => {
    const response = await list(user(ADMIN, 'admin'));
    expect(response).toMatchObject({ linked: true, scope: 'all', counterparty: { refKey1c: COUNTERPARTY } });
    expect(ids(response)).toEqual([
      doc.otherBase, doc.refund, doc.payMissing, doc.payLoose, doc.payCleaned, doc.payMixed, doc.payMine, doc.payPartly,
      doc.shipDeleted, doc.shipMixed, doc.shipForeign, doc.shipMine, doc.shipInherit,
      doc.orderLoose, doc.orderBanned, doc.orderManual, doc.orderDeleted, doc.orderForeign, doc.orderManaged, doc.orderMine,
    ].map((item) => item.id));
    expect(response.groups).toEqual({ orders: 7, shipments: 6, receipts: 6, refunds: 1 });
    expect(response.pagination).toEqual({ page: 1, pageSize: 100, total: 20, totalPages: 1 });
    const byId = new Map(response.data.map((row) => [row.id, row]));
    expect(byId.get(doc.orderMine.id)).toEqual({
      id: doc.orderMine.id, group: 'orders', kind: 'customer_order', number: `${SERIES}-7101`, date: '2026-09-02', state: 'posted',
      orderStateName: 'В работе', responsibleName: 'Иванов', erpOrders: [{ orderId: erp.mine, orderName: '7101' }], amount: '1000.00', currency: 'KZT',
    });
    expect(byId.get(doc.orderLoose.id)).toMatchObject({ state: 'not_posted', erpOrders: [] });
    expect(byId.get(doc.shipDeleted.id)).toMatchObject({ state: 'deleted', group: 'shipments' });
    expect(byId.get(doc.payMissing.id)).toMatchObject({ state: 'missing', group: 'receipts' });
    expect(byId.get(doc.refund.id)).toMatchObject({ group: 'refunds', kind: 'bank_refund', erpOrders: [] });
  });

  it('resolves ERP orders as the receipts read model does: manual link first (also a ban), then the series rule, per 1C base', async () => {
    const byId = new Map((await list(user(ADMIN, 'admin'))).data.map((row) => [row.id, row.erpOrders]));
    expect(byId.get(doc.orderManual.id)).toEqual([{ orderId: erp.manual, orderName: '7105' }]);
    expect(byId.get(doc.orderBanned.id)).toEqual([]);
    // A deleted ERP order is not offered as a link target.
    expect(byId.get(doc.orderDeleted.id)).toEqual([]);
    expect(byId.get(doc.payMine.id)).toEqual([{ orderId: erp.mine, orderName: '7101' }, { orderId: erp.managed, orderName: '7102' }]);
    expect(byId.get(doc.shipMixed.id)).toEqual([{ orderId: erp.mine, orderName: '7101' }, { orderId: erp.foreign, orderName: '7103' }]);
    // The manual link belongs to the first base: the same order key in another base resolves to nothing.
    expect(byId.get(doc.otherBase.id)).toEqual([]);
    // Without the series only manual links work.
    const noSeries = new Map((await list(user(ADMIN, 'admin'), {}, CLIENT, null)).data.map((row) => [row.id, row.erpOrders]));
    expect(noSeries.get(doc.orderMine.id)).toEqual([]);
    expect(noSeries.get(doc.orderManual.id)).toEqual([{ orderId: erp.manual, orderName: '7105' }]);
  });

  it('totals count posted documents only, per group; a group filter narrows the rows, not the totals', async () => {
    const response = await list(user(ADMIN, 'admin'), { group: 'receipts', pageSize: 2 });
    expect(ids(response)).toEqual([doc.payMissing.id, doc.payLoose.id]);
    expect(response.pagination).toEqual({ page: 1, pageSize: 2, total: 6, totalPages: 3 });
    expect(ids(await list(user(ADMIN, 'admin'), { group: 'receipts', pageSize: 2, page: 3 }))).toEqual([doc.payMine.id, doc.payPartly.id]);
    expect(response.groups).toEqual({ orders: 7, shipments: 6, receipts: 6, refunds: 1 });
    // ordered: every posted order (the not posted 64000 is out); shipped: without the deleted 100; received: without the missing 5.
    expect(response.summary).toEqual([{ currency: 'KZT', ordered: '63000.00', shipped: '5417.00', received: '2021.00', refunded: '50.00', balance: '3446.00' }]);
  });

  it('a manager limited to his own orders sees only documents every order of which is his own', async () => {
    const response = await list(user(MANAGER, 'manager'));
    expect(response.scope).toBe('own');
    expect(ids(response)).toEqual([doc.payMissing, doc.payCleaned, doc.payMine, doc.shipDeleted, doc.shipMine, doc.shipInherit, doc.orderManual, doc.orderManaged, doc.orderMine].map((item) => item.id));
    // Not shown: another manager's order and shipment; documents mixing in another manager's order (line or header);
    // documents without an order (loose receipt, refund); the receipt with a line of unknown belonging (100 own + 900
    // without an order: neither the row, nor its count, nor its 1000 in the totals); the 1C order banned from ERP; the order of a deleted ERP order;
    // the same order key in another 1C base.
    // A document that is not posted any more stays in the list (marked), outside the totals.
    expect(response.groups).toEqual({ orders: 3, shipments: 3, receipts: 3, refunds: 0 });
    expect(response.pagination.total).toBe(9);
    expect(ids(response)).not.toContain(doc.payPartly.id);
    expect(response.summary).toEqual([{ currency: 'KZT', ordered: '19000.00', shipped: '940.00', received: '760.00', refunded: '0.00', balance: '180.00' }]);
    for (const row of response.data) {
      for (const order of row.erpOrders) expect([erp.mine, erp.managed, erp.manual]).toContain(order.orderId);
      expect(row.erpOrders.length).toBeGreaterThan(0);
    }
    // The other manager sees his own side and none of the first manager's money.
    const other = await list(user(OTHER, 'manager'));
    expect(ids(other)).toEqual([doc.shipForeign, doc.orderForeign, doc.orderManaged].map((item) => item.id));
    expect(other.summary).toEqual([{ currency: 'KZT', ordered: '6000.00', shipped: '3900.00', received: '0.00', refunded: '0.00', balance: '3900.00' }]);
    // A group that is hidden in full is an empty page, not an error.
    expect(await list(user(MANAGER, 'manager'), { group: 'refunds' })).toMatchObject({ data: [], pagination: { total: 0, totalPages: 1 } });
    // Without the series the rule gives nothing: only the manually linked order and its receipt stay.
    expect(ids(await list(user(MANAGER, 'manager'), {}, CLIENT, null))).toEqual([doc.payCleaned.id, doc.orderManual.id]);
  });

  it('follows the shared order read visibility from the effective scope sets, not the role', async () => {
    const all = ids(await list(user(ADMIN, 'admin')));
    const own = ids(await list(user(MANAGER, 'manager')));
    // An admin limited by his access groups to his own orders sees what a manager limited to his own orders sees.
    const limitedAdmin = await list(grouped(MANAGER, 'admin', ['own']));
    expect(limitedAdmin.scope).toBe('own');
    expect(ids(limitedAdmin)).toEqual(own);
    // «assigned» does not restrict order reads (the orders list and the card show all orders), and neither does
    // own ∪ assigned: such a reader sees every document, as for «all».
    for (const view of [['assigned'], ['own', 'assigned']] as ScopeGrant[][]) {
      const response = await list(grouped(MANAGER, 'manager', view));
      expect(response.scope, view.join('+')).toBe('all');
      expect(ids(response), view.join('+')).toEqual(all);
    }
  });

  it('money is absent, not zero, without the right to see order financials', async () => {
    const response = await list(user(ADMIN, 'admin', ['clients.view', 'clients.onec_documents.view', 'orders.view']));
    expect(response.summary).toBeUndefined();
    expect(response.data.length).toBe(20);
    for (const row of response.data) {
      expect(row).not.toHaveProperty('amount');
      expect(row).not.toHaveProperty('currency');
    }
  });

  it('a client without a counterparty has no documents; an unknown client is 404', async () => {
    expect(await list(user(ADMIN, 'admin'), {}, UNLINKED)).toEqual({
      linked: false, counterparty: null, data: [], pagination: { page: 1, pageSize: 100, total: 0, totalPages: 1 }, scope: 'all',
      groups: { orders: 0, shipments: 0, receipts: 0, refunds: 0 }, summary: [],
    });
    expect(await code(list(user(ADMIN, 'admin'), {}, 999_999_999))).toBe('CLIENT_NOT_FOUND');
  });

  it('refuses and audits a reader without a right or without any order visibility', async () => {
    const audit = new ClientOnecDocumentsService(database, new ClientCounterpartyRepository(database), new ConfigService<BackendEnv, true>({} as Partial<BackendEnv>));
    for (const missing of FULL.slice(0, 3)) {
      const reader = user(MANAGER, 'manager', FULL.filter((permission) => permission !== missing));
      expect(await code(audit.list(reader, CLIENT, { page: 1, pageSize: 20 }, `req-${tag}-${missing}`))).toBe('PERMISSION_DENIED');
    }
    expect(await code(audit.list(grouped(MANAGER, 'manager', []), CLIENT, { page: 1, pageSize: 20 }, `req-${tag}-none`))).toBe('PERMISSION_DENIED');
    const rows = (await db.query(
      `SELECT request_id, related_client_id::text AS related_client_id, status_code, metadata_json->'missingPermissions' AS missing, metadata_json->>'orderScope' AS order_scope, metadata_json->'orderScopeSet' AS order_scope_set
         FROM audit_log WHERE event = 'clients.onec_documents_denied' AND request_id LIKE $1 ORDER BY request_id`, [`req-${tag}-%`])).rows;
    expect(rows).toEqual([
      { request_id: `req-${tag}-clients.onec_documents.view`, related_client_id: String(CLIENT), status_code: 'missing_permission', missing: ['clients.onec_documents.view'], order_scope: 'own', order_scope_set: ['own'] },
      { request_id: `req-${tag}-clients.view`, related_client_id: String(CLIENT), status_code: 'missing_permission', missing: ['clients.view'], order_scope: 'own', order_scope_set: ['own'] },
      { request_id: `req-${tag}-none`, related_client_id: String(CLIENT), status_code: 'scope_not_allowed', missing: [], order_scope: 'none', order_scope_set: [] },
      { request_id: `req-${tag}-orders.view`, related_client_id: String(CLIENT), status_code: 'missing_permission', missing: ['orders.view'], order_scope: 'own', order_scope_set: ['own'] },
    ]);
  });
});

describe('totals of 1C documents', () => {
  it('adds amounts exactly and never across currencies', () => {
    expect(summarize([
      { grp: 'shipments', currency: 'KZT', live_amount: '0.10' }, { grp: 'shipments', currency: 'KZT', live_amount: '0.20' },
      { grp: 'receipts', currency: 'KZT', live_amount: '1.00' }, { grp: 'refunds', currency: 'KZT', live_amount: '0.05' },
      { grp: 'orders', currency: 'USD', live_amount: '12345678901234.56' }, { grp: 'receipts', currency: null, live_amount: '3' },
    ])).toEqual([
      { currency: null, ordered: '0.00', shipped: '0.00', received: '3.00', refunded: '0.00', balance: '-3.00' },
      { currency: 'KZT', ordered: '0.00', shipped: '0.30', received: '1.00', refunded: '0.05', balance: '-0.65' },
      { currency: 'USD', ordered: '12345678901234.56', shipped: '0.00', received: '0.00', refunded: '0.00', balance: '0.00' },
    ]);
  });
});
