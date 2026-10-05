import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { addDays, todayInAlmaty } from '../domain/procurement-worklist';
import { almatyYear } from '../domain/supplier-requests';
import { PgProcurementWorkspaceRepository } from './pg-procurement-workspace-repository';
import { PgSupplierRequestsRepository } from './pg-supplier-requests-repository';

// Committed fixtures in an OWNED disposable database only (spec_erp/reviews/supplier-requests-3a/run-races.cjs).
const url = process.env.ERP_PROCUREMENT_RACE_DATABASE_URL;
const targetEnv = process.env.ERP_PROCUREMENT_RACE_TARGET_ENV;

class CommittedDatabase extends DatabaseService {
  readonly tx: TransactionClient;
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 15000 }), {} as never);
    this.tx = { raw: client, query: this.query.bind(this) };
  }
  override async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
    return this.client.query<T>(sql, [...params]);
  }
  override async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    await this.client.query("SET LOCAL lock_timeout='10s'");
    try {
      const result = await handler(this.tx);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }
}

describe.skipIf(!url)('Supplier requests (phase 3a) — real PostgreSQL', { timeout: 60000 }, () => {
  let pool: Pool;
  let connA: PoolClient;
  let connB: PoolClient;
  let requestsA: PgSupplierRequestsRepository;
  let requestsB: PgSupplierRequestsRepository;
  let workspace: PgProcurementWorkspaceRepository;
  const tag = 'E2E-Тест-ЗП-' + randomUUID().slice(0, 8);
  const today = todayInAlmaty();
  let admin: CurrentUser;
  let other: CurrentUser;
  let manager: CurrentUser;
  let orderIds: number[] = [];
  let material: number;
  let materialArea: number;
  let supplierId: number;
  let millingTypeId: number;
  let edgeTypeId: number;
  const key = () => `sheet_material:${material}`;
  const worklistOptions = { procurementEnabled: true, supplyWorkspaceEnabled: true, supplierRequestsEnabled: true };

  async function makeOrder(index: number, areaMm: number, planned: string) {
    await connA.query('BEGIN');
    const clientId = Number((await connA.query('SELECT client_id FROM clients WHERE client_name = $1', [tag])).rows[0].client_id);
    const projectId = Number((await connA.query('SELECT project_id FROM projects WHERE name = $1', [tag])).rows[0].project_id);
    const orderId = Number((await connA.query(
      `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by, planned_completion_date)
       VALUES ($1, $2, $3, 1, 1, $4, $5::date) RETURNING order_id`,
      [`${tag}-${index}`, clientId, projectId, Number(admin.id), planned])).rows[0].order_id);
    await connA.query(
      `INSERT INTO order_details (order_id, detail_number, height, width, quantity, area, sheet_material_type_id, milling_type_id, edge_type_id, created_by)
       VALUES ($1, 1, 1000, $2, 1, 1, $3, $4, $5, $6)`,
      [orderId, areaMm, material, millingTypeId, edgeTypeId, Number(admin.id)]);
    await connA.query('COMMIT');
    return orderId;
  }

  const count = async (sql: string, params: unknown[] = []) => Number((await connA.query<{ c: number }>(sql, params)).rows[0].c);
  const worklistLine = async (orderId: number) => {
    const list = await workspace.listWorklist(admin, { preset: 'all', groupBy: 'none', sort: 'due', search: tag }, worklistOptions);
    return list.lines.find((line) => line.orderId === orderId && line.resourceKey === key())!;
  };

  beforeAll(async () => {
    expect(targetEnv).toBe('backend-test');
    expect(decodeURIComponent(new URL(url!).pathname.slice(1)).startsWith('procurement_race_')).toBe(true);
    pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 20000 });
    connA = await pool.connect();
    connB = await pool.connect();
    requestsA = new PgSupplierRequestsRepository(new CommittedDatabase(connA));
    requestsB = new PgSupplierRequestsRepository(new CommittedDatabase(connB));
    workspace = new PgProcurementWorkspaceRepository(new CommittedDatabase(connA));
    const user = async (suffix: string, roleId: number) => Number((await connA.query(
      `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'E2E-NO-LOGIN', $3) RETURNING user_id`,
      [`${tag}-${suffix}`, `${tag}-${suffix}@example.invalid`, roleId])).rows[0].user_id);
    const adminId = await user('admin', 1);
    const otherId = await user('other', 1);
    const managerId = await user('manager', 10);
    for (const conn of [connA, connB]) {
      await conn.query('SELECT set_config($1, $2, false)', ['app.user_id', String(adminId)]);
      await conn.query('SELECT set_config($1, $2, false)', ['hasura.user',
        JSON.stringify({ 'x-hasura-user-id': String(adminId), 'x-hasura-role': 'admin' })]);
    }
    const perms = ['orders.view', 'procurement.view', 'procurement.manage'];
    admin = { id: String(adminId), username: `${tag}-admin`, role: 'admin', roleId: 1, permissions: perms };
    other = { id: String(otherId), username: `${tag}-other`, role: 'admin', roleId: 1, permissions: perms };
    manager = { id: String(managerId), username: `${tag}-manager`, role: 'manager', roleId: 10, permissions: perms };
    // Свой материал прогона (другие интеграционные тесты берут первые/третий).
    material = Number((await connA.query(
      `SELECT sheet_material_type_id FROM sheet_material_types WHERE width_mm > 0 AND height_mm > 0
        ORDER BY sheet_material_type_id OFFSET 4 LIMIT 1`)).rows[0].sheet_material_type_id);
    const dims = (await connA.query('SELECT width_mm, height_mm FROM sheet_material_types WHERE sheet_material_type_id = $1', [material])).rows[0];
    materialArea = (Number(dims.width_mm) * Number(dims.height_mm)) / 1_000_000;
    // Без поставщика в справочнике материала и без записей реестра — заявка «Поставщик не указан».
    await connA.query('UPDATE sheet_material_types SET supplier_id = NULL WHERE sheet_material_type_id = $1', [material]);
    await connA.query('DELETE FROM resource_suppliers WHERE sheet_material_type_id = $1', [material]);
    supplierId = Number((await connA.query('SELECT supplier_id FROM suppliers ORDER BY supplier_id LIMIT 1')).rows[0].supplier_id);
    millingTypeId = Number((await connA.query('SELECT milling_type_id FROM milling_types ORDER BY 1 LIMIT 1')).rows[0].milling_type_id);
    edgeTypeId = Number((await connA.query('SELECT edge_type_id FROM edge_types ORDER BY 1 LIMIT 1')).rows[0].edge_type_id);
    const clientId = Number((await connA.query('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [tag])).rows[0].client_id);
    await connA.query('INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, $2, $3, $4)',
      [('E2E-' + randomUUID().slice(0, 8)).toUpperCase(), tag, clientId, adminId]);
    // Потребность по площади деталей: 4 и 3 м² → с запасом 5 % — 4,2 и 3,15 м².
    orderIds = [await makeOrder(0, 4000, addDays(today, 2)), await makeOrder(1, 3000, addDays(today, 5)), await makeOrder(2, 2000, addDays(today, 6))];
  }, 60000);

  afterAll(async () => {
    try { connA?.release(); } catch { /* released */ }
    try { connB?.release(); } catch { /* released */ }
    await pool?.end().catch(() => undefined);
  });

  let draftId: number;

  it('drafts from the selection: one request per supplier, sheets per order rounded up, whole sheets per line, anchors, audit and outbox', async () => {
    const requestId = randomUUID();
    const items = [{ orderId: orderIds[1], resourceKey: key() }, { orderId: orderIds[0], resourceKey: key() }];
    const result = await requestsA.createDrafts({ currentUser: admin, requestId, items });
    expect(result.skipped).toEqual([]);
    expect(result.requests).toHaveLength(1);
    const [created] = result.requests;
    expect(created.requestNumber).toMatch(new RegExp(`^${String(almatyYear() % 100).padStart(2, '0')}-\\d{4,}$`));
    expect(created).toMatchObject({ supplierName: 'Поставщик не указан', linesCount: 1, ordersCount: 2 });
    draftId = created.requestId;

    const card = await requestsA.getCard(admin, draftId, true);
    expect(card).toMatchObject({ status: 'draft', supplierKey: 'none', supplierId: null, version: 0 });
    const [line] = card.lineItems;
    expect(line.unit).toBe('sheet');
    const expected = [4.2, 3.15].map((m2) => Math.ceil((m2 / materialArea) * 1000 - 1e-6) / 1000);
    expect(line.orders.map((order) => order.quantity)).toEqual(expected);
    expect(Number.isInteger(line.quantity)).toBe(true);
    expect(line.quantity).toBe(Math.ceil(expected[0] + expected[1]));
    expect(line.stockQuantity).toBeCloseTo(line.quantity - expected[0] - expected[1], 3);
    // Якоря закупа без отметки.
    const anchors = (await connA.query(
      'SELECT purchased, version FROM order_resource_procurement WHERE order_id = ANY($1::bigint[]) AND sheet_material_type_id = $2',
      [orderIds.slice(0, 2), material])).rows;
    expect(anchors).toEqual([{ purchased: false, version: 1 }, { purchased: false, version: 1 }]);
    expect(await count(`SELECT count(*)::int AS c FROM audit_log WHERE event = 'procurement.supplier_request_created' AND entity_id = $1`, [String(draftId)])).toBe(1);
    expect(await count(`SELECT count(*)::int AS c FROM outbox_events WHERE idempotency_key = $1`, [`supplier_request:${draftId}:0`])).toBe(1);

    // Повтор той же команды — тот же результат, без новых заявок, аудита и событий.
    const repeat = await requestsA.createDrafts({ currentUser: admin, requestId, items: [...items].reverse() });
    expect(repeat).toEqual(result);
    expect(await count(`SELECT count(*)::int AS c FROM audit_log WHERE event = 'procurement.supplier_request_created' AND entity_id = $1`, [String(draftId)])).toBe(1);
    // Тот же ключ с другим телом или другим пользователем — 409.
    await expect(requestsA.createDrafts({ currentUser: admin, requestId, items: items.slice(0, 1) }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(requestsA.createDrafts({ currentUser: other, requestId, items }))
      .rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    // Позиции уже в черновике — не дублируются.
    await expect(requestsA.createDrafts({ currentUser: admin, requestId: randomUUID(), items }))
      .rejects.toMatchObject({ statusCode: 422, code: 'SUPPLIER_REQUEST_NOTHING_TO_ORDER' });
  });

  it('worklist: a draft is shown but does not reduce the deficit; a sent request does («заказано»)', async () => {
    const before = await worklistLine(orderIds[0]);
    expect(before.requests).toEqual([expect.objectContaining({ requestId: draftId, status: 'draft' })]);
    expect(before.orderedOpen).toBe(0);
    expect(before.deficit).toBe(before.need);

    // Отправка без поставщика — 422; назначаем поставщика из справочника правкой черновика.
    await expect(requestsA.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: draftId, expectedVersion: 0, transition: 'send' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'SUPPLIER_REQUEST_SUPPLIER_REQUIRED' });
    const patched = await requestsA.update({ currentUser: admin, requestId: randomUUID(), supplierRequestId: draftId, expectedVersion: 0, supplierId });
    expect(patched.changed).toBe(true);
    expect(patched.request).toMatchObject({ supplierKey: `s:${supplierId}`, supplierId, version: 1 });
    const sent = await requestsA.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: draftId, expectedVersion: 1, transition: 'send' });
    expect(sent.request).toMatchObject({ status: 'sent', version: 2 });
    expect(sent.request.sentAt).not.toBeNull();

    const after = await worklistLine(orderIds[0]);
    const ordered = sent.request.lineItems[0].orders.find((order) => order.orderId === orderIds[0])!.quantity;
    expect(after.orderedOpen).toBeCloseTo(Math.round(ordered * materialArea * 1000) / 1000, 3);
    expect(after.deficit).toBe(0);
    expect(after.coverage).toBe('ordered');
    expect(after.needsAction).toBe(false);
    // Повтор отправки — no-op без событий; правка после отправки — 409.
    const events = await count(`SELECT count(*)::int AS c FROM outbox_events WHERE aggregate_type = 'supplier_request' AND aggregate_id = $1`, [String(draftId)]);
    const again = await requestsA.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: draftId, expectedVersion: 1, transition: 'send' });
    expect(again.changed).toBe(false);
    expect(await count(`SELECT count(*)::int AS c FROM outbox_events WHERE aggregate_type = 'supplier_request' AND aggregate_id = $1`, [String(draftId)])).toBe(events);
    await expect(requestsA.update({ currentUser: admin, requestId: randomUUID(), supplierRequestId: draftId, expectedVersion: 2, comment: 'x' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SUPPLIER_REQUEST_NOT_EDITABLE' });
  });

  it('close and cancel: invalid transitions are 409, a closed request no longer counts as ordered', async () => {
    const closed = await requestsA.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: draftId, expectedVersion: 2, transition: 'close' });
    expect(closed.request.status).toBe('closed');
    await expect(requestsA.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: draftId, expectedVersion: 3, transition: 'cancel' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SUPPLIER_REQUEST_INVALID_TRANSITION' });
    const line = await worklistLine(orderIds[0]);
    expect(line.requests).toEqual([]);
    expect(line.orderedOpen).toBe(0);
    expect(await count(`SELECT count(*)::int AS c FROM audit_log WHERE entity_type = 'supplier_request' AND entity_id = $1`, [String(draftId)])).toBe(4);
  });

  it('edit a draft: stale version 409, stock recalculated, unchanged body is a no-op, numbers are sequential', async () => {
    const first = await requestsA.createDrafts({ currentUser: admin, requestId: randomUUID(), items: orderIds.map((orderId) => ({ orderId, resourceKey: key() })) });
    const [request] = first.requests;
    const previous = Number((await connA.query('SELECT request_number FROM supplier_requests WHERE supplier_request_id = $1', [draftId])).rows[0].request_number.split('-')[1]);
    expect(Number(request.requestNumber.split('-')[1])).toBe(previous + 1);
    const card = await requestsA.getCard(admin, request.requestId, true);
    const [line] = card.lineItems;
    await expect(requestsA.update({ currentUser: admin, requestId: randomUUID(), supplierRequestId: request.requestId, expectedVersion: 5, comment: 'x' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SUPPLIER_REQUEST_VERSION_CONFLICT' });
    const kept = line.orders.slice(0, 2);
    const updated = await requestsA.update({
      currentUser: admin, requestId: randomUUID(), supplierRequestId: request.requestId, expectedVersion: 0, comment: 'срочно',
      lines: [{ lineId: line.lineId, quantity: line.quantity + 1, orders: kept.map((order) => ({ lineOrderId: order.lineOrderId, quantity: order.quantity })) }],
    });
    const [next] = updated.request.lineItems;
    expect(next.orders).toHaveLength(2);
    expect(next.quantity).toBe(line.quantity + 1);
    expect(next.stockQuantity).toBeCloseTo(next.quantity - kept[0].quantity - kept[1].quantity, 3);
    expect(updated.request).toMatchObject({ comment: 'срочно', version: 1 });
    const audits = await count(`SELECT count(*)::int AS c FROM audit_log WHERE entity_type = 'supplier_request' AND entity_id = $1`, [String(request.requestId)]);
    const noop = await requestsA.update({
      currentUser: admin, requestId: randomUUID(), supplierRequestId: request.requestId, expectedVersion: 1, comment: 'срочно',
      lines: [{ lineId: next.lineId, quantity: next.quantity, orders: next.orders.map((order) => ({ lineOrderId: order.lineOrderId, quantity: order.quantity })) }],
    });
    expect(noop).toMatchObject({ changed: false, request: { version: 1 } });
    expect(await count(`SELECT count(*)::int AS c FROM audit_log WHERE entity_type = 'supplier_request' AND entity_id = $1`, [String(request.requestId)])).toBe(audits);
    // Листы — только целые.
    await expect(requestsA.update({
      currentUser: admin, requestId: randomUUID(), supplierRequestId: request.requestId, expectedVersion: 1,
      lines: [{ lineId: next.lineId, quantity: next.quantity + 0.5, orders: [] }],
    })).rejects.toMatchObject({ statusCode: 422, code: 'SUPPLIER_REQUEST_WHOLE_SHEETS' });
    const cancelled = await requestsA.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: request.requestId, expectedVersion: 1, transition: 'cancel' });
    expect(cancelled.request).toMatchObject({ status: 'cancelled', sentAt: null });
  });

  it('scope (CR1-1): commands need every order of the request in scope — foreign and mixed requests', async () => {
    const foreign = await requestsA.createDrafts({ currentUser: admin, requestId: randomUUID(), items: [{ orderId: orderIds[2], resourceKey: key() }] });
    const card = await requestsA.getCard(manager, foreign.requests[0].requestId, true);
    expect(card.lineItems[0].orders).toEqual([]);
    expect(card).toMatchObject({ ordersCount: 0, hiddenOrdersCount: 1, actions: { edit: false, send: false, close: false, cancel: false } });
    for (const transition of ['send', 'cancel'] as const) {
      await expect(requestsA.transition({ currentUser: manager, requestId: randomUUID(), supplierRequestId: card.requestId, expectedVersion: 0, transition }))
        .rejects.toMatchObject({ statusCode: 403, code: 'SUPPLIER_REQUEST_SCOPE' });
    }
    await expect(requestsA.update({ currentUser: manager, requestId: randomUUID(), supplierRequestId: card.requestId, expectedVersion: 0, comment: 'x' }))
      .rejects.toMatchObject({ statusCode: 403, code: 'SUPPLIER_REQUEST_SCOPE' });
    await expect(requestsA.createDrafts({ currentUser: manager, requestId: randomUUID(), items: [{ orderId: orderIds[2], resourceKey: key() }] }))
      .rejects.toMatchObject({ statusCode: 404 });
    const list = await requestsA.list(manager, { search: foreign.requests[0].requestNumber });
    expect(list.data).toEqual([expect.objectContaining({ requestId: card.requestId, ordersCount: 0, hiddenOrdersCount: 1 })]);
    await requestsA.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: card.requestId, expectedVersion: 0, transition: 'cancel' });

    // Смешанная: заказ менеджера + чужой — видна частично, команды запрещены; у своей заявки — разрешены.
    const own = await makeOrder(4, 1200, addDays(today, 8));
    await connA.query('UPDATE orders SET manager_id = $2 WHERE order_id = $1', [own, Number(manager.id)]);
    const mixed = await requestsA.createDrafts({ currentUser: admin, requestId: randomUUID(), items: [own, orderIds[2]].map((orderId) => ({ orderId, resourceKey: key() })) });
    const mixedCard = await requestsA.getCard(manager, mixed.requests[0].requestId, true);
    expect(mixedCard).toMatchObject({ ordersCount: 1, hiddenOrdersCount: 1, actions: { edit: false, cancel: false } });
    await expect(requestsA.transition({ currentUser: manager, requestId: randomUUID(), supplierRequestId: mixedCard.requestId, expectedVersion: 0, transition: 'cancel' }))
      .rejects.toMatchObject({ statusCode: 403, code: 'SUPPLIER_REQUEST_SCOPE' });
    await requestsA.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: mixedCard.requestId, expectedVersion: 0, transition: 'cancel' });
    const mine = await requestsA.createDrafts({ currentUser: manager, requestId: randomUUID(), items: [{ orderId: own, resourceKey: key() }] });
    const mineCard = await requestsA.getCard(manager, mine.requests[0].requestId, true);
    expect(mineCard.actions).toEqual({ edit: true, send: true, close: false, cancel: true });
    const cancelled = await requestsA.transition({ currentUser: manager, requestId: randomUUID(), supplierRequestId: mineCard.requestId, expectedVersion: 0, transition: 'cancel' });
    expect(cancelled.request.status).toBe('cancelled');
  });

  it('audit/outbox (CR1-2): an order removed from the draft stays among the affected orders', async () => {
    const [first, second] = [orderIds[0], orderIds[1]];
    const result = await requestsA.createDrafts({ currentUser: admin, requestId: randomUUID(), items: [first, second].map((orderId) => ({ orderId, resourceKey: key() })) });
    const card = await requestsA.getCard(admin, result.requests[0].requestId, true);
    const [line] = card.lineItems;
    const keep = line.orders.find((order) => order.orderId === first)!;
    await requestsA.update({
      currentUser: admin, requestId: randomUUID(), supplierRequestId: card.requestId, expectedVersion: 0,
      lines: [{ lineId: line.lineId, quantity: line.quantity, orders: [{ lineOrderId: keep.lineOrderId, quantity: keep.quantity }] }],
    });
    const audit = (await connA.query(
      `SELECT audit_id, metadata_json FROM audit_log WHERE event = 'procurement.supplier_request_updated' AND entity_id = $1`, [String(card.requestId)])).rows[0];
    expect(audit.metadata_json).toMatchObject({ orderIds: [first, second], removedOrderIds: [second], addedOrderIds: [] });
    const related = (await connA.query(
      `SELECT entity_id FROM audit_log_related_entity WHERE audit_id = $1 AND entity_type = 'order' ORDER BY entity_id::bigint`, [audit.audit_id])).rows.map((row) => Number(row.entity_id));
    expect(related).toEqual([first, second]);
    const event = (await connA.query(
      `SELECT payload_json FROM outbox_events WHERE idempotency_key = $1`, [`supplier_request:${card.requestId}:1`])).rows[0];
    expect(event.payload_json).toMatchObject({ orderIds: [first, second], removedOrderIds: [second] });
    await requestsA.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: card.requestId, expectedVersion: 1, transition: 'cancel' });
  });

  it('CR2-2: an order moved to the trash does not block closing the request and is dropped from a draft on save', async () => {
    const a = await makeOrder(5, 1100, addDays(today, 9));
    const b = await makeOrder(6, 1300, addDays(today, 9));
    const created = await requestsA.createDrafts({ currentUser: admin, requestId: randomUUID(), items: [a, b].map((orderId) => ({ orderId, resourceKey: key() })) });
    const id = created.requests[0].requestId;
    await requestsA.update({ currentUser: admin, requestId: randomUUID(), supplierRequestId: id, expectedVersion: 0, supplierId });
    await connA.query('UPDATE orders SET delete_flag = true WHERE order_id = $1', [a]);
    // Черновик: заказ в корзине не показывается, считается отдельно и убирается при сохранении.
    const draft = await requestsA.getCard(admin, id, true);
    expect(draft).toMatchObject({ ordersCount: 1, hiddenOrdersCount: 0, deletedOrdersCount: 1, actions: { edit: true, send: true } });
    const [line] = draft.lineItems;
    expect(line.deletedOrdersCount).toBe(1);
    const saved = await requestsA.update({
      currentUser: admin, requestId: randomUUID(), supplierRequestId: id, expectedVersion: 1,
      lines: [{ lineId: line.lineId, quantity: line.quantity, orders: line.orders.map((order) => ({ lineOrderId: order.lineOrderId, quantity: order.quantity })) }],
    });
    expect(saved.request).toMatchObject({ deletedOrdersCount: 0, ordersCount: 1 });
    // Отправленная заявка с заказом в корзине закрывается и отменяется.
    await connA.query('UPDATE orders SET delete_flag = false WHERE order_id = $1', [a]);
    const second = await requestsA.createDrafts({ currentUser: admin, requestId: randomUUID(), items: [a].map((orderId) => ({ orderId, resourceKey: key() })) });
    const sid = second.requests[0].requestId;
    await requestsA.update({ currentUser: admin, requestId: randomUUID(), supplierRequestId: sid, expectedVersion: 0, supplierId });
    await requestsA.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: sid, expectedVersion: 1, transition: 'send' });
    await connA.query('UPDATE orders SET delete_flag = true WHERE order_id = $1', [a]);
    const closed = await requestsA.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: sid, expectedVersion: 2, transition: 'close' });
    expect(closed.request.status).toBe('closed');
    await requestsA.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: id, expectedVersion: 2, transition: 'cancel' });
  });

  it('CR3-1: the trash does not hand a foreign request over — manager commands stay forbidden before and after restore', async () => {
    const foreignOrder = await makeOrder(7, 1400, addDays(today, 10));
    const created = await requestsA.createDrafts({ currentUser: admin, requestId: randomUUID(), items: [{ orderId: foreignOrder, resourceKey: key() }] });
    const id = created.requests[0].requestId;
    await connA.query('UPDATE orders SET delete_flag = true WHERE order_id = $1', [foreignOrder]);
    const card = await requestsA.getCard(manager, id, true);
    expect(card).toMatchObject({ ordersCount: 0, hiddenOrdersCount: 0, deletedOrdersCount: 1, actions: { edit: false, send: false, cancel: false } });
    for (const transition of ['send', 'cancel'] as const) {
      await expect(requestsA.transition({ currentUser: manager, requestId: randomUUID(), supplierRequestId: id, expectedVersion: 0, transition }))
        .rejects.toMatchObject({ statusCode: 403, code: 'SUPPLIER_REQUEST_SCOPE' });
    }
    await expect(requestsA.update({ currentUser: manager, requestId: randomUUID(), supplierRequestId: id, expectedVersion: 0, supplierId }))
      .rejects.toMatchObject({ statusCode: 403, code: 'SUPPLIER_REQUEST_SCOPE' });
    await connA.query('UPDATE orders SET delete_flag = false WHERE order_id = $1', [foreignOrder]);
    const restored = await requestsA.getCard(admin, id, true);
    expect(restored).toMatchObject({ version: 0, supplierKey: 'none', ordersCount: 1, deletedOrdersCount: 0 });
    await requestsA.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: id, expectedVersion: 0, transition: 'cancel' });
  });

  it('two concurrent creates with the same key: one writes, the other returns the same result', async () => {
    const order = await makeOrder(3, 1500, addDays(today, 7));
    const requestId = randomUUID();
    const items = [{ orderId: order, resourceKey: key() }];
    const [a, b] = await Promise.all([
      requestsA.createDrafts({ currentUser: admin, requestId, items }),
      requestsB.createDrafts({ currentUser: admin, requestId, items }),
    ]);
    expect(a).toEqual(b);
    expect(await count(`SELECT count(*)::int AS c FROM supplier_requests WHERE supplier_request_id = $1`, [a.requests[0].requestId])).toBe(1);
    expect(await count(
      `SELECT count(*)::int AS c FROM supplier_request_line_orders lo JOIN order_resource_procurement orp USING (order_resource_procurement_id) WHERE orp.order_id = $1`,
      [order])).toBe(1);
  });

  it('the deferred trigger rejects a line whose quantity differs from orders + stock', async () => {
    const lineId = Number((await connA.query(
      `SELECT l.supplier_request_line_id FROM supplier_request_lines l JOIN supplier_requests r USING (supplier_request_id)
        WHERE r.status = 'draft' ORDER BY 1 DESC LIMIT 1`)).rows[0].supplier_request_line_id);
    await connA.query('BEGIN');
    await connA.query('UPDATE supplier_request_lines SET stock_quantity = 0, quantity = quantity + 5 WHERE supplier_request_line_id = $1', [lineId]);
    await expect(connA.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    await connA.query('ROLLBACK').catch(() => undefined);
  });
});
