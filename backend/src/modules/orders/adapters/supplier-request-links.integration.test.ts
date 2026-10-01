import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { BatchOnecAllocationItem } from '../application/onec-documents.types';
import { addDays, todayInAlmaty } from '../domain/procurement-worklist';
import { PgOnecDocumentsRepository } from './pg-onec-documents-repository';
import { PgProcurementHistoryRepository } from './pg-procurement-history-repository';
import { PgProcurementWorkspaceRepository } from './pg-procurement-workspace-repository';
import { PgRequestLinksRepository } from './pg-request-links-repository';
import { PgSupplierRequestsRepository } from './pg-supplier-requests-repository';

// Committed fixtures in an OWNED disposable database only (spec_erp/reviews/supplier-requests-3b/run-races.cjs).
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

describe.skipIf(!url)('Supplier request links (phase 3b) — real PostgreSQL', { timeout: 60000 }, () => {
  let pool: Pool;
  let conn: PoolClient;
  let conn2: PoolClient;
  let links2: PgRequestLinksRepository;
  let requests: PgSupplierRequestsRepository;
  let docs: PgOnecDocumentsRepository;
  let workspace: PgProcurementWorkspaceRepository;
  let links: PgRequestLinksRepository;
  let history: PgProcurementHistoryRepository;
  const tag = 'E2E-Тест-СЗ-' + randomUUID().slice(0, 8);
  const today = todayInAlmaty();
  let admin: CurrentUser;
  let finance: CurrentUser;
  let orderIds: number[] = [];
  let material: number;
  let materialArea: number;
  let supplierId: number;
  let otherSupplierId: number;
  let sourceId: number;
  let millingTypeId: number;
  let edgeTypeId: number;
  const key = () => `sheet_material:${material}`;
  const options = { procurementEnabled: true, supplyWorkspaceEnabled: true, supplierRequestsEnabled: true };

  async function makeOrder(index: number, areaMm: number) {
    await conn.query('BEGIN');
    const clientId = Number((await conn.query('SELECT client_id FROM clients WHERE client_name = $1', [tag])).rows[0].client_id);
    const projectId = Number((await conn.query('SELECT project_id FROM projects WHERE name = $1', [tag])).rows[0].project_id);
    const orderId = Number((await conn.query(
      `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by, planned_completion_date)
       VALUES ($1, $2, $3, 1, 1, $4, $5::date) RETURNING order_id`,
      [`${tag}-${index}`, clientId, projectId, Number(admin.id), addDays(today, 3 + index)])).rows[0].order_id);
    await conn.query(
      `INSERT INTO order_details (order_id, detail_number, height, width, quantity, area, sheet_material_type_id, milling_type_id, edge_type_id, created_by)
       VALUES ($1, 1, 1000, $2, 1, 1, $3, $4, $5, $6)`,
      [orderId, areaMm, material, millingTypeId, edgeTypeId, Number(admin.id)]);
    await conn.query('COMMIT');
    return orderId;
  }

  async function receipt(sheets: number, docSupplierId: number, unit: 'sheet' | 'm2' = 'sheet') {
    const documentId = Number((await conn.query(
      `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, counterparty_name, supplier_id, amount)
       VALUES ($1, 'purchase_receipt', $2, $3, $4, true, $5, $6, 1000) RETURNING onec_document_id`,
      [sourceId, randomUUID(), `${tag.slice(-8)}-${randomUUID().slice(0, 6)}`, today, `${tag} Поставщик`, docSupplierId])).rows[0].onec_document_id);
    const lineId = Number((await conn.query(
      `INSERT INTO onec_document_lines (onec_document_id, line_no, nomenclature_name, quantity, unit_code, sheet_material_type_id)
       VALUES ($1, 1, 'лист', $2, $4, $3) RETURNING onec_document_line_id`,
      [documentId, sheets, material, unit])).rows[0].onec_document_line_id);
    return { documentId, lineId };
  }

  async function sentRequest(orders: number[]) {
    const created = await requests.createDrafts({ currentUser: admin, requestId: randomUUID(), items: orders.map((orderId) => ({ orderId, resourceKey: key() })) });
    const id = created.requests[0].requestId;
    // Поставщик мог уже подставиться из реестра (приходы прошлых сценариев) — тогда правка — no-op.
    const patched = await requests.update({ currentUser: admin, requestId: randomUUID(), supplierRequestId: id, expectedVersion: 0, supplierId });
    await requests.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: id, expectedVersion: patched.request.version, transition: 'send' });
    return requests.getCard(admin, id, true);
  }

  /** Распределение всей строки прихода на заказ без связей — одиночной командой (без условия дефицита). */
  async function allocate(doc: { documentId: number; lineId: number }, orderId: number) {
    const line = (await workspace.listWorklist(admin, { preset: 'all', groupBy: 'none', sort: 'due', search: tag }, options))
      .lines.find((entry) => entry.orderId === orderId && entry.resourceKey === key())!;
    const quantity = Number((await conn.query('SELECT quantity FROM onec_document_lines WHERE onec_document_line_id = $1', [doc.lineId])).rows[0].quantity);
    await docs.addAllocation({ currentUser: admin, requestId: randomUUID(), documentId: doc.documentId, lineId: doc.lineId, orderId,
      resourceKey: key(), quantity, expectedVersion: line.procurementVersion, expectedDemandFingerprint: line.demandFingerprint });
    return (await conn.query(
      `SELECT a.allocation_id, a.onec_document_line_id AS line_id, a.quantity, orp.version FROM order_resource_onec_allocations a
         JOIN order_resource_procurement orp USING (order_resource_procurement_id)
        WHERE a.onec_document_line_id = $1 AND orp.order_id = $2 AND a.removed_at IS NULL`, [doc.lineId, orderId])).rows[0];
  }

  const worklistLine = async (orderId: number) => (await workspace.listWorklist(admin, { preset: 'all', groupBy: 'none', sort: 'due', search: tag }, options))
    .lines.find((line) => line.orderId === orderId && line.resourceKey === key())!;

  function items(response: Awaited<ReturnType<PgProcurementWorkspaceRepository['allocationSuggestions']>>): BatchOnecAllocationItem[] {
    return response.lines.flatMap((line) => line.candidates.filter((candidate) => candidate.proposedInDocUnit > 0).map((candidate) => ({
      lineId: line.lineId, orderId: candidate.orderId, resourceKey: line.material!.resourceKey, quantity: candidate.proposedInDocUnit,
      expectedVersion: candidate.procurementVersion, expectedDemandFingerprint: candidate.demandFingerprint,
      expectedDocUnit: line.docUnit, expectedSheetAreaM2: line.sheetAreaM2,
      requestLinks: candidate.requestLinks.map((link) => ({ lineOrderId: link.lineOrderId, quantity: link.quantity })),
    })));
  }

  beforeAll(async () => {
    expect(targetEnv).toBe('backend-test');
    expect(decodeURIComponent(new URL(url!).pathname.slice(1)).startsWith('procurement_race_')).toBe(true);
    pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 20000 });
    conn = await pool.connect();
    conn2 = await pool.connect();
    links2 = new PgRequestLinksRepository(new CommittedDatabase(conn2));
    const db = new CommittedDatabase(conn);
    requests = new PgSupplierRequestsRepository(db);
    docs = new PgOnecDocumentsRepository(db);
    workspace = new PgProcurementWorkspaceRepository(db);
    links = new PgRequestLinksRepository(db);
    history = new PgProcurementHistoryRepository(db);
    const adminId = Number((await conn.query(
      `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'E2E-NO-LOGIN', 1) RETURNING user_id`,
      [`${tag}-admin`, `${tag}-admin@example.invalid`])).rows[0].user_id);
    for (const c of [conn, conn2]) {
      await c.query('SELECT set_config($1, $2, false)', ['app.user_id', String(adminId)]);
      await c.query('SELECT set_config($1, $2, false)', ['hasura.user', JSON.stringify({ 'x-hasura-user-id': String(adminId), 'x-hasura-role': 'admin' })]);
    }
    admin = { id: String(adminId), username: `${tag}-admin`, role: 'admin', roleId: 1, permissions: ['orders.view', 'procurement.view', 'procurement.manage'] };
    // Тот же пользователь с правом на суммы — для оплат (ф.3б-2).
    finance = { ...admin, permissions: [...admin.permissions, 'finance.view'] };
    material = Number((await conn.query(
      `SELECT sheet_material_type_id FROM sheet_material_types WHERE width_mm > 0 AND height_mm > 0 ORDER BY sheet_material_type_id OFFSET 5 LIMIT 1`)).rows[0].sheet_material_type_id);
    const dims = (await conn.query('SELECT width_mm, height_mm FROM sheet_material_types WHERE sheet_material_type_id = $1', [material])).rows[0];
    materialArea = (Number(dims.width_mm) * Number(dims.height_mm)) / 1_000_000;
    await conn.query('UPDATE sheet_material_types SET supplier_id = NULL WHERE sheet_material_type_id = $1', [material]);
    const suppliers = (await conn.query('SELECT supplier_id FROM suppliers ORDER BY supplier_id LIMIT 2')).rows.map((row) => Number(row.supplier_id));
    [supplierId, otherSupplierId] = suppliers;
    millingTypeId = Number((await conn.query('SELECT milling_type_id FROM milling_types ORDER BY 1 LIMIT 1')).rows[0].milling_type_id);
    edgeTypeId = Number((await conn.query('SELECT edge_type_id FROM edge_types ORDER BY 1 LIMIT 1')).rows[0].edge_type_id);
    const clientId = Number((await conn.query('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [tag])).rows[0].client_id);
    await conn.query('INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, $2, $3, $4)',
      [('E2E-' + randomUUID().slice(0, 8)).toUpperCase(), tag, clientId, adminId]);
    sourceId = Number((await conn.query(`INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id`,
      [('e2e-' + randomUUID().slice(0, 8)), tag])).rows[0].source_id);
    // Потребности ~1 и ~2 листа (площадь деталей, запас 5 %).
    orderIds = [await makeOrder(0, Math.round(materialArea * 1000)), await makeOrder(1, Math.round(materialArea * 2000))];
  }, 60000);

  afterAll(async () => {
    try { conn?.release(); } catch { /* released */ }
    try { conn2?.release(); } catch { /* released */ }
    await pool?.end().catch(() => undefined);
  });

  it('suggestions split a receipt over the open request; the unchanged batch links it; the request and the worklist show the fulfilment', async () => {
    const card = await sentRequest([orderIds[0]]);
    const lineOrder = card.lineItems[0].orders[0];
    const before = await worklistLine(orderIds[0]);
    expect(before.orderedOpen).toBeGreaterThan(0);
    const doc = await receipt(5, supplierId);
    const suggestions = await workspace.allocationSuggestions(admin, doc.documentId, { supplierRequestsEnabled: true });
    const candidate = suggestions.lines[0].candidates.find((entry) => entry.orderId === orderIds[0])!;
    expect(candidate.reasons[0]).toMatchObject({ code: 'request' });
    expect(candidate.requestLinks).toEqual([expect.objectContaining({ lineOrderId: lineOrder.lineOrderId, supplierRequestId: card.requestId })]);
    const body = items(suggestions).filter((item) => item.orderId === orderIds[0]);
    const result = await docs.addAllocationsBatch({ currentUser: admin, documentId: doc.documentId, requestId: randomUUID(), origin: 'suggested', items: body });
    expect(result.changed).toBe(true);
    const linked = (await conn.query('SELECT count(*)::int AS c FROM order_resource_allocation_request_links WHERE supplier_request_line_order_id = $1 AND removed_at IS NULL', [lineOrder.lineOrderId])).rows[0].c;
    expect(linked).toBe(1);
    const after = await requests.getCard(admin, card.requestId, true);
    const fulfilledOrder = after.lineItems[0].orders[0];
    expect(fulfilledOrder.fulfilled).toBe(candidate.requestLinks[0].quantity);
    expect(fulfilledOrder.receipts).toEqual([expect.objectContaining({ documentId: doc.documentId })]);
    // Заявка округляла заказ вверх до 0,001, подбор — связь вниз: хвост в пределах допуска — «получено».
    expect(fulfilledOrder.quantity - fulfilledOrder.fulfilled).toBeLessThanOrEqual(0.001 + 1e-9);
    expect(fulfilledOrder.fulfillment).toBe('received');
    expect(after.receiptState).toBe('done');
    const line = await worklistLine(orderIds[0]);
    expect(line.orderedOpen).toBe(0);
    // Аудит распределения несёт связь, событие — одно на распределение.
    const audit = (await conn.query(
      `SELECT metadata_json FROM audit_log WHERE event = 'order_resource.onec_allocation_added' AND metadata_json->>'onecDocumentId' = $1`,
      [String(doc.documentId)])).rows;
    expect(audit.some((row) => Array.isArray(row.metadata_json.requestLinks) && row.metadata_json.requestLinks.length === 1)).toBe(true);
    // Повтор batch — no-op, связь не дублируется.
    const repeat = await docs.addAllocationsBatch({ currentUser: admin, documentId: doc.documentId, requestId: randomUUID(), origin: 'suggested', items: body });
    expect(repeat.changed).toBe(false);
    expect((await conn.query('SELECT count(*)::int AS c FROM order_resource_allocation_request_links WHERE supplier_request_line_order_id = $1', [lineOrder.lineOrderId])).rows[0].c).toBe(1);

    // Снятие распределения снимает связь: исполнение и «заказано» возвращаются.
    const allocation = (await conn.query(
      `SELECT a.allocation_id, orp.version FROM order_resource_onec_allocations a
         JOIN order_resource_procurement orp USING (order_resource_procurement_id)
        WHERE a.onec_document_line_id = $1 AND orp.order_id = $2 AND a.removed_at IS NULL`, [doc.lineId, orderIds[0]])).rows[0];
    await docs.removeAllocation({ currentUser: admin, requestId: randomUUID(), documentId: doc.documentId, lineId: doc.lineId,
      allocationId: Number(allocation.allocation_id), expectedVersion: Number(allocation.version) });
    const reverted = await requests.getCard(admin, card.requestId, true);
    expect(reverted.lineItems[0].orders[0]).toMatchObject({ fulfilled: 0, fulfillment: 'waiting' });
    expect((await worklistLine(orderIds[0])).orderedOpen).toBeCloseTo(before.orderedOpen, 3);
    const removedAudit = (await conn.query(
      `SELECT metadata_json FROM audit_log WHERE event = 'order_resource.onec_allocation_removed' AND entity_id = $1`, [String(allocation.allocation_id)])).rows[0];
    expect(removedAudit.metadata_json.removedRequestLinks).toEqual([expect.objectContaining({ supplierRequestId: card.requestId, lineOrderId: lineOrder.lineOrderId })]);
    const removedEvent = (await conn.query(
      `SELECT payload_json FROM outbox_events WHERE payload_json->>'changeType' = 'allocation_removed' AND payload_json->>'allocationId' = $1`, [String(allocation.allocation_id)])).rows[0];
    expect(removedEvent.payload_json.supplierRequestIds).toEqual([card.requestId]);
    const bridge = (await conn.query(
      `SELECT count(*)::int AS c FROM audit_log a JOIN audit_log_related_entity r ON r.audit_id = a.audit_id
        WHERE a.event = 'order_resource.onec_allocation_removed' AND a.entity_id = $1 AND r.entity_type = 'supplier_request' AND r.entity_id = $2`,
      [String(allocation.allocation_id), String(card.requestId)])).rows[0].c;
    expect(bridge).toBe(1);
  });

  it('manual link from a possible match: checks, no-op repeat, unlink', async () => {
    const card = await sentRequest([orderIds[1]]);
    const lineOrder = card.lineItems[0].orders[0];
    // Приход без ссылки (ручной batch без requestLinks) — только «возможное совпадение».
    const doc = await receipt(10, supplierId);
    const suggestions = await workspace.allocationSuggestions(admin, doc.documentId, { supplierRequestsEnabled: true });
    const plain = items(suggestions).filter((item) => item.orderId === orderIds[1]).map((item) => ({ ...item, requestLinks: [] }));
    await docs.addAllocationsBatch({ currentUser: admin, documentId: doc.documentId, requestId: randomUUID(), origin: 'manual', items: plain });
    const withMatch = await requests.getCard(admin, card.requestId, true);
    const [match] = withMatch.lineItems[0].orders[0].possibleMatches;
    expect(match).toMatchObject({ documentId: doc.documentId, supplierCheck: 'match' });
    expect(match.suggestedQuantity).toBeGreaterThan(0);
    const base = { currentUser: admin, documentId: doc.documentId, lineId: match.lineId, allocationId: match.allocationId };

    await expect(links.link({ ...base, requestId: randomUUID(), lineOrderId: lineOrder.lineOrderId, quantity: lineOrder.quantity + 1, expectedVersion: match.procurementVersion }))
      .rejects.toMatchObject({ statusCode: 422, code: 'SUPPLIER_REQUEST_LINK_EXCEEDS_REQUEST' });
    await expect(links.link({ ...base, requestId: randomUUID(), lineOrderId: lineOrder.lineOrderId, quantity: match.suggestedQuantity, expectedVersion: match.procurementVersion + 5 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PROCUREMENT_VERSION_CONFLICT' });
    const linked = await links.link({ ...base, requestId: randomUUID(), lineOrderId: lineOrder.lineOrderId, quantity: match.suggestedQuantity, expectedVersion: match.procurementVersion });
    expect(linked).toMatchObject({ changed: true, supplierCheck: 'match', procurementVersion: match.procurementVersion + 1 });
    const repeat = await links.link({ ...base, requestId: randomUUID(), lineOrderId: lineOrder.lineOrderId, quantity: match.suggestedQuantity, expectedVersion: linked.procurementVersion });
    expect(repeat).toMatchObject({ changed: false, linkId: linked.linkId });
    await expect(links.link({ ...base, requestId: randomUUID(), lineOrderId: lineOrder.lineOrderId, quantity: 0.001, expectedVersion: linked.procurementVersion }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SUPPLIER_REQUEST_LINK_EXISTS' });
    const afterLink = await requests.getCard(admin, card.requestId, true);
    expect(afterLink.lineItems[0].orders[0]).toMatchObject({ fulfilled: match.suggestedQuantity, possibleMatches: [] });
    const outbox = (await conn.query(`SELECT payload_json FROM outbox_events WHERE payload_json->>'changeType' = 'allocation_linked' AND payload_json->>'linkId' = $1`, [String(linked.linkId)])).rows;
    expect(outbox).toHaveLength(1);

    const unlinked = await links.unlink({ ...base, requestId: randomUUID(), linkId: linked.linkId, expectedVersion: linked.procurementVersion });
    expect(unlinked.changed).toBe(true);
    const again = await links.unlink({ ...base, requestId: randomUUID(), linkId: linked.linkId, expectedVersion: unlinked.procurementVersion });
    expect(again.changed).toBe(false);
    expect((await requests.getCard(admin, card.requestId, true)).lineItems[0].orders[0].fulfilled).toBe(0);
    // Закрытая заявка: новые связи запрещены.
    await requests.transition({ currentUser: admin, requestId: randomUUID(), supplierRequestId: card.requestId, expectedVersion: afterLink.version, transition: 'close' });
    await expect(links.link({ ...base, requestId: randomUUID(), lineOrderId: lineOrder.lineOrderId, quantity: 0.5, expectedVersion: unlinked.procurementVersion }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SUPPLIER_REQUEST_NOT_SENT' });
  });

  it('a receipt of another supplier is not a match and can not be linked', async () => {
    const order = await makeOrder(2, Math.round(materialArea * 1000));
    const card = await sentRequest([order]);
    const lineOrder = card.lineItems[0].orders[0];
    const doc = await receipt(3, otherSupplierId);
    const suggestions = await workspace.allocationSuggestions(admin, doc.documentId, { supplierRequestsEnabled: true });
    const candidate = suggestions.lines[0].candidates.find((entry) => entry.orderId === order)!;
    expect(candidate.requestLinks).toEqual([]);
    const body = items(suggestions).filter((item) => item.orderId === order);
    // Batch с чужой ссылкой — отказ позиции, ничего не записано.
    const forged = body.map((item) => ({ ...item, requestLinks: [{ lineOrderId: lineOrder.lineOrderId, quantity: 0.5 }] }));
    await expect(docs.addAllocationsBatch({ currentUser: admin, documentId: doc.documentId, requestId: randomUUID(), origin: 'manual', items: forged }))
      .rejects.toMatchObject({ statusCode: 409, details: { failures: [expect.objectContaining({ code: 'SUPPLIER_REQUEST_SUPPLIER_MISMATCH' })] } });
    expect((await conn.query('SELECT count(*)::int AS c FROM order_resource_onec_allocations WHERE onec_document_line_id = $1', [doc.lineId])).rows[0].c).toBe(0);
    await docs.addAllocationsBatch({ currentUser: admin, documentId: doc.documentId, requestId: randomUUID(), origin: 'manual', items: body });
    expect((await requests.getCard(admin, card.requestId, true)).lineItems[0].orders[0].possibleMatches).toEqual([]);
    const allocation = (await conn.query(
      `SELECT a.allocation_id, orp.version FROM order_resource_onec_allocations a JOIN order_resource_procurement orp USING (order_resource_procurement_id)
        WHERE a.onec_document_line_id = $1 AND orp.order_id = $2 AND a.removed_at IS NULL`, [doc.lineId, order])).rows[0];
    await expect(links.link({ currentUser: admin, requestId: randomUUID(), documentId: doc.documentId, lineId: doc.lineId,
      allocationId: Number(allocation.allocation_id), lineOrderId: lineOrder.lineOrderId, quantity: 0.5, expectedVersion: Number(allocation.version) }))
      .rejects.toMatchObject({ statusCode: 422, code: 'SUPPLIER_REQUEST_SUPPLIER_MISMATCH' });
  });

  it('R1: an unposted document or a conflicting line can not be linked and is not a possible match (CR1-1)', async () => {
    const order = await makeOrder(3, Math.round(materialArea * 1000));
    const card = await sentRequest([order]);
    const lineOrder = card.lineItems[0].orders[0];
    const doc = await receipt(2, supplierId);
    const allocation = await allocate(doc, order);
    expect((await requests.getCard(admin, card.requestId, true)).lineItems[0].orders[0].possibleMatches).toHaveLength(1);
    const base = { currentUser: admin, documentId: doc.documentId, lineId: Number(allocation.line_id), allocationId: Number(allocation.allocation_id), lineOrderId: lineOrder.lineOrderId, quantity: 0.1 };
    await conn.query('UPDATE onec_document_lines SET load_conflict_code = $2 WHERE onec_document_line_id = $1', [allocation.line_id, 'QUANTITY_BELOW_ALLOCATED']);
    expect((await requests.getCard(admin, card.requestId, true)).lineItems[0].orders[0].possibleMatches).toEqual([]);
    await expect(links.link({ ...base, requestId: randomUUID(), expectedVersion: Number(allocation.version) })).rejects.toMatchObject({ statusCode: 422, code: 'ONEC_LINE_CONFLICT' });
    await conn.query('UPDATE onec_document_lines SET load_conflict_code = NULL WHERE onec_document_line_id = $1', [allocation.line_id]);
    await conn.query('UPDATE onec_documents SET posted = false WHERE onec_document_id = $1', [doc.documentId]);
    expect((await requests.getCard(admin, card.requestId, true)).lineItems[0].orders[0].possibleMatches).toEqual([]);
    await expect(links.link({ ...base, requestId: randomUUID(), expectedVersion: Number(allocation.version) })).rejects.toMatchObject({ statusCode: 409, code: 'ONEC_DOCUMENT_NOT_ALLOCATABLE' });
    await conn.query('UPDATE onec_documents SET posted = true WHERE onec_document_id = $1', [doc.documentId]);
  });

  it('R1: links of one allocation are summed exactly across units — two halves in m² can not exceed a 1-sheet receipt (CR1-2)', async () => {
    const order = await makeOrder(4, Math.round(materialArea * 1500));
    const card = await sentRequest([order]);
    const lineOrder = card.lineItems[0].orders[0];
    // Строка заявки в м² (одноразовая БД): количество = заказ + склад, как требует триггер строки.
    await conn.query('BEGIN');
    await conn.query('UPDATE supplier_request_line_orders SET quantity = 10 WHERE supplier_request_line_order_id = $1', [lineOrder.lineOrderId]);
    await conn.query(`UPDATE supplier_request_lines SET unit_code = 'm2', quantity = 10, stock_quantity = 0 WHERE supplier_request_line_id = $1`, [card.lineItems[0].lineId]);
    await conn.query('COMMIT');
    const doc = await receipt(1, supplierId);
    const allocation = await allocate(doc, order);
    expect(Number(allocation.quantity)).toBe(1);
    const base = { currentUser: admin, documentId: doc.documentId, lineId: Number(allocation.line_id), allocationId: Number(allocation.allocation_id), lineOrderId: lineOrder.lineOrderId };
    // 1 лист + 0,002 м²: округление связи до тысячной листа дало бы ровно 1,000 листа; точная сумма — больше прихода.
    const tooMuch = await links.link({ ...base, requestId: randomUUID(), quantity: Math.round((materialArea + 0.002) * 1000) / 1000, expectedVersion: Number(allocation.version) }).catch((error) => error);
    expect(tooMuch).toMatchObject({ statusCode: 422, code: 'SUPPLIER_REQUEST_LINK_EXCEEDS_ALLOCATION' });
    const exact = await links.link({ ...base, requestId: randomUUID(), quantity: Math.floor(materialArea * 1000) / 1000, expectedVersion: Number(allocation.version) });
    expect(exact.changed).toBe(true);
  });

  it('R1: the database refuses a link to another order and concurrent links can not exceed the request (CR1-5)', async () => {
    const order = await makeOrder(5, Math.round(materialArea * 1000));
    const other = await makeOrder(6, Math.round(materialArea * 1000));
    const card = await sentRequest([order]);
    const lineOrder = card.lineItems[0].orders[0];
    const docA = await receipt(1, supplierId);
    const docB = await receipt(1, supplierId);
    const a = await allocate(docA, order);
    const b = await allocate(docB, order);
    const foreign = await allocate(await receipt(1, supplierId), other);
    await conn.query('BEGIN');
    await conn.query('INSERT INTO order_resource_allocation_request_links (allocation_id, supplier_request_line_order_id, quantity, created_by) VALUES ($1, $2, 0.1, $3)',
      [foreign.allocation_id, lineOrder.lineOrderId, Number(admin.id)]);
    await expect(conn.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    await conn.query('ROLLBACK').catch(() => undefined);
    // Две параллельные привязки по разным приходам: каждая в пределах заявки, вместе — больше. Одна должна отказать.
    const quantity = Math.round((lineOrder.quantity * 0.6) * 1000) / 1000;
    const results = await Promise.allSettled([
      links.link({ currentUser: admin, requestId: randomUUID(), documentId: docA.documentId, lineId: Number(a.line_id), allocationId: Number(a.allocation_id), lineOrderId: lineOrder.lineOrderId, quantity, expectedVersion: Number(a.version) }),
      links2.link({ currentUser: admin, requestId: randomUUID(), documentId: docB.documentId, lineId: Number(b.line_id), allocationId: Number(b.allocation_id), lineOrderId: lineOrder.lineOrderId, quantity, expectedVersion: Number(b.version) }),
    ]);
    // Обе на один закуп: вторая либо упрётся в лимит заявки, либо в версию закупа — но не пройдёт сверх заказанного.
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const fulfilled = Number((await conn.query('SELECT COALESCE(sum(quantity), 0) AS q FROM order_resource_allocation_request_links WHERE supplier_request_line_order_id = $1 AND removed_at IS NULL', [lineOrder.lineOrderId])).rows[0].q);
    expect(fulfilled).toBeLessThanOrEqual(lineOrder.quantity);
  });

  it('R2: concurrent direct INSERTs over the ordered quantity — the database trigger serializes and refuses one (CR2-1)', async () => {
    const order = await makeOrder(8, Math.round(materialArea * 1000));
    const card = await sentRequest([order]);
    const lineOrder = card.lineItems[0].orders[0];
    const a = await allocate(await receipt(1, supplierId), order);
    const b = await allocate(await receipt(1, supplierId), order);
    const quantity = Math.round(lineOrder.quantity * 0.6 * 1000) / 1000;
    for (const [c, allocation] of [[conn, a], [conn2, b]] as const) {
      await c.query('BEGIN');
      await c.query('INSERT INTO order_resource_allocation_request_links (allocation_id, supplier_request_line_order_id, quantity, created_by) VALUES ($1, $2, $3, $4)',
        [allocation.allocation_id, lineOrder.lineOrderId, quantity, Number(admin.id)]);
    }
    const commits = await Promise.allSettled([conn.query('COMMIT'), conn2.query('COMMIT')]);
    await conn.query('ROLLBACK').catch(() => undefined);
    await conn2.query('ROLLBACK').catch(() => undefined);
    expect(commits.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(commits.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: '23514' } });
  });

  it('R1: with supplier requests switched off the suggestions ignore open requests (CR1-3)', async () => {
    const order = await makeOrder(7, Math.round(materialArea * 1000));
    await sentRequest([order]);
    const doc = await receipt(2, supplierId);
    const off = await workspace.allocationSuggestions(admin, doc.documentId);
    const candidate = off.lines[0].candidates.find((entry) => entry.orderId === order)!;
    expect(candidate.requestLinks).toEqual([]);
    expect(candidate.reasons.map((reason) => reason.code)).not.toContain('request');
  });

  async function payment(amount: number, docSupplierId: number, currency = 'KZT') {
    const documentId = Number((await conn.query(
      `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, counterparty_name, supplier_id, amount, currency)
       VALUES ($1, 'bank_outflow', $2, $3, $4, true, $5, $6, $7, $8) RETURNING onec_document_id`,
      [sourceId, randomUUID(), `${tag.slice(-8)}-pay-${randomUUID().slice(0, 4)}`, today, `${tag} Поставщик`, docSupplierId, amount, currency])).rows[0].onec_document_id);
    const lineId = Number((await conn.query(
      `INSERT INTO onec_document_lines (onec_document_id, line_no, quantity, amount, is_document_total)
       VALUES ($1, 1, 0, $2, true) RETURNING onec_document_line_id`, [documentId, amount])).rows[0].onec_document_line_id);
    return { documentId, lineId };
  }

  async function payOrder(doc: { documentId: number; lineId: number }, orderId: number, amount: number) {
    const line = (await workspace.listWorklist(admin, { preset: 'all', groupBy: 'none', sort: 'due', search: tag }, options))
      .lines.find((entry) => entry.orderId === orderId && entry.resourceKey === key())!;
    await docs.addAllocation({ currentUser: finance, requestId: randomUUID(), documentId: doc.documentId, lineId: doc.lineId, orderId,
      resourceKey: key(), amount, expectedVersion: line.procurementVersion, expectedDemandFingerprint: line.demandFingerprint });
    return (await conn.query(
      `SELECT a.allocation_id, orp.version FROM order_resource_onec_allocations a JOIN order_resource_procurement orp USING (order_resource_procurement_id)
        WHERE a.onec_document_line_id = $1 AND orp.order_id = $2 AND a.removed_at IS NULL`, [doc.lineId, orderId])).rows[0];
  }

  it('3b-2: a payment is linked by amount in the document currency, only with finance.view; the card shows «paid» per currency', async () => {
    const order = await makeOrder(9, Math.round(materialArea * 1000));
    const card = await sentRequest([order]);
    const lineOrder = card.lineItems[0].orders[0];
    const doc = await payment(50000, supplierId);
    const allocation = await payOrder(doc, order, 30000);
    const before = await requests.getCard(finance, card.requestId, true);
    expect(before.lineItems[0].orders[0].possiblePayments).toEqual([expect.objectContaining({ allocationId: Number(allocation.allocation_id), unlinkedAmount: 30000, currency: 'KZT', supplierCheck: 'match' })]);
    expect(before).toMatchObject({ paymentState: 'none', paid: {} });
    const base = { documentId: doc.documentId, lineId: doc.lineId, allocationId: Number(allocation.allocation_id), lineOrderId: lineOrder.lineOrderId };
    // Без finance.view — 403 (сервис пишет denied-аудит после отката), ничего не записано.
    await expect(links.link({ ...base, currentUser: admin, requestId: randomUUID(), amount: 1000, expectedVersion: Number(allocation.version) }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(links.link({ ...base, currentUser: finance, requestId: randomUUID(), quantity: 1, expectedVersion: Number(allocation.version) }))
      .rejects.toMatchObject({ statusCode: 422, code: 'SUPPLIER_REQUEST_LINK_MEASURE' });
    await expect(links.link({ ...base, currentUser: finance, requestId: randomUUID(), amount: 30000.01, expectedVersion: Number(allocation.version) }))
      .rejects.toMatchObject({ statusCode: 422, code: 'SUPPLIER_REQUEST_LINK_EXCEEDS_ALLOCATION' });
    const linked = await links.link({ ...base, currentUser: finance, requestId: randomUUID(), amount: 20000, expectedVersion: Number(allocation.version) });
    expect(linked).toMatchObject({ changed: true, supplierCheck: 'match' });
    expect((await links.link({ ...base, currentUser: finance, requestId: randomUUID(), amount: 20000, expectedVersion: linked.procurementVersion })).changed).toBe(false);
    await expect(links.link({ ...base, currentUser: finance, requestId: randomUUID(), amount: 100, expectedVersion: linked.procurementVersion }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SUPPLIER_REQUEST_LINK_EXISTS' });
    const row = (await conn.query('SELECT amount, currency, quantity FROM order_resource_allocation_request_links WHERE link_id = $1', [linked.linkId])).rows[0];
    expect(row).toMatchObject({ currency: 'KZT', quantity: null });
    expect(Number(row.amount)).toBe(20000);
    const after = await requests.getCard(finance, card.requestId, true);
    expect(after).toMatchObject({ paymentState: 'paid', paid: { KZT: 20000 } });
    expect(after.lineItems[0].orders[0]).toMatchObject({ paid: { KZT: 20000 }, fulfilled: 0, fulfillment: 'waiting' });
    expect(after.lineItems[0].orders[0].payments).toEqual([expect.objectContaining({ linkId: linked.linkId, amount: 20000, currency: 'KZT' })]);
    // Без finance.view суммы не видны вовсе.
    const hidden = await requests.getCard(admin, card.requestId, true);
    expect(hidden).toMatchObject({ paymentState: 'hidden', paid: {} });
    expect(hidden.lineItems[0].orders[0]).toMatchObject({ payments: [], paid: {}, possiblePayments: [] });
    // Отвязка без finance.view — 403; с правом — проходит.
    await expect(links.unlink({ ...base, currentUser: admin, requestId: randomUUID(), linkId: linked.linkId, expectedVersion: linked.procurementVersion }))
      .rejects.toMatchObject({ statusCode: 403 });
    const unlinked = await links.unlink({ ...base, currentUser: finance, requestId: randomUUID(), linkId: linked.linkId, expectedVersion: linked.procurementVersion });
    expect(unlinked.changed).toBe(true);
    expect((await requests.getCard(finance, card.requestId, true)).paid).toEqual({});
  });

  it('3b-2 R1: no payment amounts in audit/outbox; a currency changed in 1C blocks new links and hides the match', async () => {
    const order = await makeOrder(12, Math.round(materialArea * 1000));
    const card = await sentRequest([order]);
    const lineOrder = card.lineItems[0].orders[0];
    const doc = await payment(8000, supplierId);
    const allocation = await payOrder(doc, order, 8000);
    const base = { currentUser: finance, documentId: doc.documentId, lineId: doc.lineId, allocationId: Number(allocation.allocation_id), lineOrderId: lineOrder.lineOrderId };
    const linked = await links.link({ ...base, requestId: randomUUID(), amount: 3000, expectedVersion: Number(allocation.version) });
    const audit = (await conn.query(
      `SELECT before_json, after_json, diff_json, metadata_json FROM audit_log WHERE event = 'order_resource.onec_allocation_linked_to_request' AND metadata_json->>'linkId' = $1`,
      [String(linked.linkId)])).rows[0];
    expect(JSON.stringify(audit)).not.toMatch(/"amount"|3000|"currency"/);
    expect(audit.metadata_json).toMatchObject({ role: 'payment', supplierRequestId: card.requestId });
    const event = (await conn.query(`SELECT payload_json FROM outbox_events WHERE payload_json->>'linkId' = $1`, [String(linked.linkId)])).rows[0];
    expect(JSON.stringify(event.payload_json)).not.toMatch(/"amount"|3000/);
    // Загрузчик 1С сменил валюту документа после привязки.
    await conn.query(`UPDATE onec_documents SET currency = 'USD' WHERE onec_document_id = $1`, [doc.documentId]);
    const other = await sentRequest([await makeOrder(13, Math.round(materialArea * 1000))]);
    expect((await requests.getCard(finance, card.requestId, true)).lineItems[0].orders[0].possiblePayments).toEqual([]);
    await links.unlink({ ...base, requestId: randomUUID(), linkId: linked.linkId, expectedVersion: linked.procurementVersion });
    await conn.query(`UPDATE onec_documents SET currency = 'KZT' WHERE onec_document_id = $1`, [doc.documentId]);
    const again = await links.link({ ...base, requestId: randomUUID(), amount: 3000, expectedVersion: linked.procurementVersion + 1 });
    await conn.query(`UPDATE onec_documents SET currency = 'USD' WHERE onec_document_id = $1`, [doc.documentId]);
    // Вторая строка заявки того же закупа — чтобы проверить новую связь при сменённой валюте.
    await conn.query('BEGIN');
    await conn.query('UPDATE supplier_request_lines SET stock_quantity = stock_quantity - 0.001 WHERE supplier_request_line_id = $1', [other.lineItems[0].lineId]);
    const secondLineOrder = Number((await conn.query(
      `INSERT INTO supplier_request_line_orders (supplier_request_line_id, order_resource_procurement_id, quantity)
       VALUES ($1, $2, 0.001) RETURNING supplier_request_line_order_id`, [other.lineItems[0].lineId, lineOrder.procurementId])).rows[0].supplier_request_line_order_id);
    await conn.query('COMMIT');
    await expect(links.link({ ...base, lineOrderId: secondLineOrder, requestId: randomUUID(), amount: 1000, expectedVersion: again.procurementVersion }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SUPPLIER_REQUEST_LINK_CURRENCY_CHANGED' });
    await conn.query(`UPDATE onec_documents SET currency = 'KZT' WHERE onec_document_id = $1`, [doc.documentId]);
    // Снятие распределения: связь оплаты в журнале — quantity null, без суммы.
    await docs.removeAllocation({ currentUser: finance, requestId: randomUUID(), documentId: doc.documentId, lineId: doc.lineId,
      allocationId: Number(allocation.allocation_id), expectedVersion: again.procurementVersion });
    const removed = (await conn.query(
      `SELECT metadata_json FROM audit_log WHERE event = 'order_resource.onec_allocation_removed' AND entity_id = $1`, [String(allocation.allocation_id)])).rows[0];
    expect(removed.metadata_json.removedRequestLinks).toEqual([expect.objectContaining({ linkId: again.linkId, quantity: null })]);
  });

  it('3b-2 R2: a currency changed in 1C blocks links of every allocation of the document, not only the linked one', async () => {
    const first = await makeOrder(14, Math.round(materialArea * 1000));
    const second = await makeOrder(15, Math.round(materialArea * 1000));
    const card = await sentRequest([first, second]);
    const orderOf = (orderId: number) => card.lineItems[0].orders.find((entry) => entry.orderId === orderId)!;
    const doc = await payment(10000, supplierId);
    const firstAllocation = await payOrder(doc, first, 6000);
    const secondAllocation = await payOrder(doc, second, 4000);
    await links.link({ currentUser: finance, requestId: randomUUID(), documentId: doc.documentId, lineId: doc.lineId,
      allocationId: Number(firstAllocation.allocation_id), lineOrderId: orderOf(first).lineOrderId, amount: 6000, expectedVersion: Number(firstAllocation.version) });
    await conn.query(`UPDATE onec_documents SET currency = 'USD' WHERE onec_document_id = $1`, [doc.documentId]);
    await expect(links.link({ currentUser: finance, requestId: randomUUID(), documentId: doc.documentId, lineId: doc.lineId,
      allocationId: Number(secondAllocation.allocation_id), lineOrderId: orderOf(second).lineOrderId, amount: 4000, expectedVersion: Number(secondAllocation.version) }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SUPPLIER_REQUEST_LINK_CURRENCY_CHANGED' });
    await conn.query(`UPDATE onec_documents SET currency = 'KZT' WHERE onec_document_id = $1`, [doc.documentId]);
  });

  it('3b-2: the database trigger refuses a payment link in another currency and concurrent links over the allocated amount', async () => {
    const order = await makeOrder(10, Math.round(materialArea * 1000));
    const card = await sentRequest([order]);
    const lineOrder = card.lineItems[0].orders[0];
    const doc = await payment(10000, supplierId);
    const allocation = await payOrder(doc, order, 10000);
    await conn.query('BEGIN');
    await conn.query('INSERT INTO order_resource_allocation_request_links (allocation_id, supplier_request_line_order_id, amount, currency, created_by) VALUES ($1, $2, 100, $3, $4)',
      [allocation.allocation_id, lineOrder.lineOrderId, 'USD', Number(admin.id)]);
    await expect(conn.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    await conn.query('ROLLBACK').catch(() => undefined);
    // Вторая строка заказа того же закупа в другой отправленной заявке (одноразовая БД): 0,001 листа со «склада» строки.
    const other = await sentRequest([await makeOrder(11, Math.round(materialArea * 1000))]);
    await conn.query('BEGIN');
    await conn.query('UPDATE supplier_request_lines SET stock_quantity = stock_quantity - 0.001 WHERE supplier_request_line_id = $1', [other.lineItems[0].lineId]);
    const secondLineOrder = Number((await conn.query(
      `INSERT INTO supplier_request_line_orders (supplier_request_line_id, order_resource_procurement_id, quantity)
       VALUES ($1, $2, 0.001) RETURNING supplier_request_line_order_id`, [other.lineItems[0].lineId, lineOrder.procurementId])).rows[0].supplier_request_line_order_id);
    await conn.query('COMMIT');
    // Две параллельные связи одной оплаты 10 000: 6 000 + 6 000 — одна должна отказать на COMMIT.
    for (const [client, target] of [[conn, lineOrder.lineOrderId], [conn2, secondLineOrder]] as const) {
      await client.query('BEGIN');
      await client.query('INSERT INTO order_resource_allocation_request_links (allocation_id, supplier_request_line_order_id, amount, currency, created_by) VALUES ($1, $2, 6000, $3, $4)',
        [allocation.allocation_id, target, 'KZT', Number(admin.id)]);
    }
    const commits = await Promise.allSettled([conn.query('COMMIT'), conn2.query('COMMIT')]);
    await conn.query('ROLLBACK').catch(() => undefined);
    await conn2.query('ROLLBACK').catch(() => undefined);
    expect(commits.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(commits.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: '23514' } });
  });

  it('a document of a foreign kind (warehouse shipment) does not exist for procurement: card, suggestions, allocation, link — 404', async () => {
    // Одноразовая БД: снимаем CHECK вида, как это сделает миграция загрузчика расходных документов.
    await conn.query('ALTER TABLE onec_documents DROP CONSTRAINT IF EXISTS chk_onec_documents_kind');
    const documentId = Number((await conn.query(
      `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, counterparty_name, amount)
       VALUES ($1, 'sales_shipment', $2, $3, $4, true, $5, 1000) RETURNING onec_document_id`,
      [sourceId, randomUUID(), `${tag.slice(-8)}-ship`, today, `${tag} Покупатель`])).rows[0].onec_document_id);
    const lineId = Number((await conn.query(
      `INSERT INTO onec_document_lines (onec_document_id, line_no, nomenclature_name, quantity, unit_code, sheet_material_type_id)
       VALUES ($1, 1, 'лист', 2, 'sheet', $2) RETURNING onec_document_line_id`, [documentId, material])).rows[0].onec_document_line_id);
    await expect(docs.getCard(admin, documentId, { procurementEnabled: true, canSeeAmounts: true })).rejects.toMatchObject({ statusCode: 404 });
    await expect(workspace.allocationSuggestions(admin, documentId)).rejects.toMatchObject({ statusCode: 404 });
    const list = await docs.list(admin, { tab: 'payments', page: 1, pageSize: 100 }, { procurementEnabled: true, canSeeAmounts: true });
    expect(list.data.some((item) => item.documentId === documentId)).toBe(false);
    const demand = (await workspace.listWorklist(admin, { preset: 'all', groupBy: 'none', sort: 'due', search: tag }, options))
      .lines.find((line) => line.orderId === orderIds[0])!;
    await expect(docs.addAllocation({ currentUser: admin, requestId: randomUUID(), documentId, lineId, orderId: orderIds[0], resourceKey: key(),
      quantity: 1, expectedVersion: demand.procurementVersion, expectedDemandFingerprint: demand.demandFingerprint }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('4a: the history of an order material lists marks, allocations, links and requests; amounts only with finance.view; scope and paging', async () => {
    const order = await makeOrder(16, Math.round(materialArea * 1000));
    const other = await makeOrder(17, Math.round(materialArea * 1000));
    const card = await sentRequest([order, other]);
    const lineOrder = card.lineItems[0].orders.find((entry) => entry.orderId === order)!;
    const doc = await receipt(1, supplierId);
    const allocation = await allocate(doc, order);
    const linked = await links.link({ currentUser: admin, requestId: randomUUID(), documentId: doc.documentId, lineId: doc.lineId,
      allocationId: Number(allocation.allocation_id), lineOrderId: lineOrder.lineOrderId, quantity: 0.5, expectedVersion: Number(allocation.version) });
    const pay = await payment(5000, supplierId);
    await payOrder(pay, order, 1200);
    const query = { orderId: order, resourceKey: key(), limit: 50, before: null };
    const plain = await history.getHistory({ ...query, currentUser: admin }, { canSeeAmounts: false });
    expect(plain.current).toMatchObject({ purchased: true, origin: 'onec' });
    // Правка поставщика в sentRequest может дать request_updated — порядок остальных фиксирован.
    const events = plain.events.filter((event) => event.kind !== 'request_updated');
    expect(events.map((event) => event.kind)).toEqual(['allocation_added', 'allocation_linked', 'allocation_added', 'request_sent', 'request_created']);
    const [paymentEvent, linkEvent, receiptEvent, sent, created] = events;
    expect(paymentEvent).toMatchObject({ role: 'payment', amount: null, currency: null, document: { documentId: pay.documentId } });
    expect(linkEvent).toMatchObject({ role: 'receipt', quantity: 0.5, unit: 'sheet', request: { supplierRequestId: card.requestId } });
    expect(linked.linkId).toBeGreaterThan(0);
    expect(receiptEvent).toMatchObject({ role: 'receipt', quantity: 1, unit: 'sheet', markedPurchased: true, document: { documentId: doc.documentId } });
    expect(sent).toMatchObject({ request: { supplierRequestId: card.requestId, number: card.requestNumber }, quantity: lineOrder.quantity });
    expect(created.quantity).toBe(lineOrder.quantity);
    // Ни одного другого заказа заявки в ответе.
    expect(JSON.stringify(plain)).not.toContain(`"orderId":${other}`);
    const withAmounts = await history.getHistory({ ...query, currentUser: finance }, { canSeeAmounts: true });
    expect(withAmounts.events[0]).toMatchObject({ amount: 1200, currency: 'KZT' });
    // Страницы: курсор продолжает строго после последнего события, без повторов.
    const first = await history.getHistory({ ...query, limit: 2, currentUser: admin }, { canSeeAmounts: false });
    expect(first.events).toHaveLength(2);
    const { decodeHistoryCursor } = await import('../domain/procurement-history');
    const second = await history.getHistory({ ...query, limit: 50, before: decodeHistoryCursor(first.nextCursor!), currentUser: admin }, { canSeeAmounts: false });
    expect([...first.events, ...second.events].map((event) => event.id)).toEqual(plain.events.map((event) => event.id));
    expect(second.nextCursor).toBeNull();
    // Другой материал того же заказа — пусто; заказ вне scope менеджера — 404.
    expect((await history.getHistory({ ...query, resourceKey: 'film:1', currentUser: admin }, { canSeeAmounts: false })).events).toEqual([]);
    const manager: CurrentUser = { ...admin, id: '999999998', username: `${tag}-manager`, role: 'manager', roleId: 10 };
    await expect(history.getHistory({ ...query, currentUser: manager }, { canSeeAmounts: false })).rejects.toMatchObject({ statusCode: 404 });
    await expect(history.getHistory({ ...query, resourceKey: 'bad', currentUser: admin }, { canSeeAmounts: false })).rejects.toMatchObject({ statusCode: 422 });
  });

  it('4a R1: batch links and links removed with an allocation are in the history; a payment keeps the currency of its time', async () => {
    const order = await makeOrder(18, Math.round(materialArea * 1000));
    const card = await sentRequest([order]);
    const doc = await receipt(5, supplierId);
    // Элемент batch собран вручную: подбор мог отдать приход заказам прежних сценариев (общий материал прогона).
    const suggestions = await workspace.allocationSuggestions(admin, doc.documentId, { supplierRequestsEnabled: true });
    const docLine = suggestions.lines[0];
    const worklist = await worklistLine(order);
    const ordered = card.lineItems[0].orders[0].quantity;
    const body: BatchOnecAllocationItem[] = [{
      lineId: doc.lineId, orderId: order, resourceKey: key(), quantity: ordered,
      expectedVersion: worklist.procurementVersion, expectedDemandFingerprint: worklist.demandFingerprint,
      expectedDocUnit: docLine.docUnit, expectedSheetAreaM2: docLine.sheetAreaM2,
      requestLinks: [{ lineOrderId: card.lineItems[0].orders[0].lineOrderId, quantity: ordered }],
    }];
    await docs.addAllocationsBatch({ currentUser: admin, documentId: doc.documentId, requestId: randomUUID(), origin: 'suggested', items: body });
    const allocation = (await conn.query(
      `SELECT a.allocation_id, orp.version FROM order_resource_onec_allocations a JOIN order_resource_procurement orp USING (order_resource_procurement_id)
        WHERE a.onec_document_line_id = $1 AND orp.order_id = $2 AND a.removed_at IS NULL`, [doc.lineId, order])).rows[0];
    await docs.removeAllocation({ currentUser: admin, requestId: randomUUID(), documentId: doc.documentId, lineId: doc.lineId,
      allocationId: Number(allocation.allocation_id), expectedVersion: Number(allocation.version) });
    // Оплата 1200 KZT: распределили, сняли, загрузчик сменил валюту на USD — история остаётся в KZT.
    const pay = await payment(5000, supplierId);
    const paid = await payOrder(pay, order, 1200);
    await docs.removeAllocation({ currentUser: finance, requestId: randomUUID(), documentId: pay.documentId, lineId: pay.lineId,
      allocationId: Number(paid.allocation_id), expectedVersion: Number(paid.version) });
    await conn.query(`UPDATE onec_documents SET currency = 'USD' WHERE onec_document_id = $1`, [pay.documentId]);
    const result = await history.getHistory({ orderId: order, resourceKey: key(), limit: 50, before: null, currentUser: finance }, { canSeeAmounts: true });
    const [payRemoved, payAdded, removed, added] = result.events.filter((event) => event.kind === 'allocation_added' || event.kind === 'allocation_removed');
    expect(payRemoved).toMatchObject({ kind: 'allocation_removed', role: 'payment', amount: 1200, currency: 'KZT' });
    expect(payAdded).toMatchObject({ kind: 'allocation_added', role: 'payment', amount: 1200, currency: 'KZT' });
    const link = { supplierRequestId: card.requestId, number: card.requestNumber, quantity: ordered, unit: 'sheet' };
    expect(added).toMatchObject({ kind: 'allocation_added', role: 'receipt', requestLinks: [{ action: 'linked', ...link }] });
    expect(removed).toMatchObject({ kind: 'allocation_removed', role: 'receipt', requestLinks: [{ action: 'unlinked', ...link }] });
    await conn.query(`UPDATE onec_documents SET currency = 'KZT' WHERE onec_document_id = $1`, [pay.documentId]);
  });
});
