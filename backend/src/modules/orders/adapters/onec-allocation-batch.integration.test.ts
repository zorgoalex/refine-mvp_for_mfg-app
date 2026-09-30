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
import { PgOrderResourceDemandRepository } from './pg-order-resource-demand-repository';
import { PgProcurementWorkspaceRepository } from './pg-procurement-workspace-repository';

// Committed fixtures in an OWNED disposable database only (run-races.cjs).
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

describe.skipIf(!url)('1C receipt suggestions + batch allocation — real PostgreSQL', { timeout: 60000 }, () => {
  let pool: Pool;
  let connA: PoolClient;
  let connB: PoolClient;
  let docsA: PgOnecDocumentsRepository;
  let docsB: PgOnecDocumentsRepository;
  let reads: PgOrderResourceDemandRepository;
  let workspace: PgProcurementWorkspaceRepository;
  const tag = 'E2E-Тест-ПП-' + randomUUID().slice(0, 8);
  const today = todayInAlmaty();
  let admin: CurrentUser;
  let manager: CurrentUser;
  let orderIds: number[] = [];
  let material: number;
  let sourceId: number;
  let millingTypeId: number;
  let edgeTypeId: number;
  let materialArea: number;
  const key = () => `sheet_material:${material}`;

  async function receipt(lines: Array<{ lineNo: number; quantity: number; unit?: string }>) {
    const documentId = Number((await connA.query(
      `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, counterparty_name, amount)
       VALUES ($1, 'purchase_receipt', $2, $3, $4, true, $5, 1000) RETURNING onec_document_id`,
      [sourceId, randomUUID(), `${tag.slice(-8)}-${randomUUID().slice(0, 6)}`, today, `${tag} Поставщик`])).rows[0].onec_document_id);
    const lineIds: number[] = [];
    for (const line of lines) {
      lineIds.push(Number((await connA.query(
        `INSERT INTO onec_document_lines (onec_document_id, line_no, nomenclature_name, quantity, unit_code, sheet_material_type_id)
         VALUES ($1, $2, 'лист', $3, $4, $5) RETURNING onec_document_line_id`,
        [documentId, line.lineNo, line.quantity, line.unit ?? 'm2', material])).rows[0].onec_document_line_id));
    }
    return { documentId, lineIds };
  }

  async function events(orderId: number) {
    return Number((await connA.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox_events WHERE event_type = 'order.resource_procurement_changed' AND aggregate_id = $1`,
      [String(orderId)])).rows[0].c);
  }

  async function demand(orderId: number) {
    const card = await reads.getCard({ currentUser: admin, orderId }, { procurementEnabled: true, canSeeAmounts: true });
    return card.data.lines.find((line) => line.resourceKey === key())!;
  }

  function itemsFromSuggestions(response: Awaited<ReturnType<PgProcurementWorkspaceRepository['allocationSuggestions']>>): BatchOnecAllocationItem[] {
    return response.lines.flatMap((line) => line.candidates
      .filter((candidate) => candidate.proposedInDocUnit > 0)
      .map((candidate) => ({
        lineId: line.lineId, orderId: candidate.orderId, resourceKey: line.material!.resourceKey,
        quantity: candidate.proposedInDocUnit, expectedVersion: candidate.procurementVersion,
        expectedDemandFingerprint: candidate.demandFingerprint,
        expectedDocUnit: line.docUnit, expectedSheetAreaM2: line.sheetAreaM2,
      })));
  }

  type ItemInput = Omit<BatchOnecAllocationItem, 'expectedDocUnit' | 'expectedSheetAreaM2'>
    & Partial<Pick<BatchOnecAllocationItem, 'expectedDocUnit' | 'expectedSheetAreaM2'>>;
  // По умолчанию — контекст фикстур: строки в м², текущая площадь листа материала прогона.
  const batch = (repo: PgOnecDocumentsRepository, documentId: number, items: ItemInput[], user: CurrentUser = admin) =>
    repo.addAllocationsBatch({ currentUser: user, documentId, requestId: randomUUID(), origin: 'suggested',
      items: items.map((item) => ({ expectedDocUnit: 'm2' as const, expectedSheetAreaM2: materialArea, ...item })) });

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

  beforeAll(async () => {
    expect(targetEnv).toBe('backend-test');
    expect(decodeURIComponent(new URL(url!).pathname.slice(1)).startsWith('procurement_race_')).toBe(true);
    pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 20000 });
    connA = await pool.connect();
    connB = await pool.connect();
    docsA = new PgOnecDocumentsRepository(new CommittedDatabase(connA));
    docsB = new PgOnecDocumentsRepository(new CommittedDatabase(connB));
    reads = new PgOrderResourceDemandRepository(new CommittedDatabase(connA));
    workspace = new PgProcurementWorkspaceRepository(new CommittedDatabase(connA));
    const adminId = Number((await connA.query(
      `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'E2E-NO-LOGIN', 1) RETURNING user_id`,
      [tag + '-admin', tag + '-admin@example.invalid'])).rows[0].user_id);
    const managerId = Number((await connA.query(
      `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'E2E-NO-LOGIN', 10) RETURNING user_id`,
      [tag + '-manager', tag + '-manager@example.invalid'])).rows[0].user_id);
    for (const conn of [connA, connB]) {
      await conn.query('SELECT set_config($1, $2, false)', ['app.user_id', String(adminId)]);
      await conn.query('SELECT set_config($1, $2, false)', ['hasura.user',
        JSON.stringify({ 'x-hasura-user-id': String(adminId), 'x-hasura-role': 'admin' })]);
    }
    const perms = ['orders.view', 'procurement.view', 'procurement.manage'];
    admin = { id: String(adminId), username: tag + '-admin', role: 'admin', roleId: 1, permissions: perms };
    manager = { id: String(managerId), username: tag + '-manager', role: 'manager', roleId: 10, permissions: perms };
    // Отдельный материал прогона: остальные интеграционные тесты берут первые/последние.
    material = Number((await connA.query(
      `SELECT sheet_material_type_id FROM sheet_material_types WHERE width_mm > 0 AND height_mm > 0
        ORDER BY sheet_material_type_id OFFSET 2 LIMIT 1`)).rows[0].sheet_material_type_id);
    const dims = (await connA.query('SELECT width_mm, height_mm FROM sheet_material_types WHERE sheet_material_type_id = $1', [material])).rows[0];
    materialArea = (Number(dims.width_mm) * Number(dims.height_mm)) / 1_000_000;
    millingTypeId = Number((await connA.query('SELECT milling_type_id FROM milling_types ORDER BY 1 LIMIT 1')).rows[0].milling_type_id);
    edgeTypeId = Number((await connA.query('SELECT edge_type_id FROM edge_types ORDER BY 1 LIMIT 1')).rows[0].edge_type_id);
    const clientId = Number((await connA.query('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [tag])).rows[0].client_id);
    await connA.query('INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, $2, $3, $4)',
      [('E2E-' + randomUUID().slice(0, 8)).toUpperCase(), tag, clientId, adminId]);
    // Потребности 4 и 3 м² (площадь деталей → источник 'area', запас 5 %).
    orderIds = [await makeOrder(0, 4000, addDays(today, 2)), await makeOrder(1, 3000, addDays(today, 5))];
    sourceId = Number((await connA.query(
      `INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id`,
      [('e2e-' + randomUUID().slice(0, 8)), tag])).rows[0].source_id);
  }, 60000);

  afterAll(async () => {
    try { connA?.release(); } catch { /* released */ }
    try { connB?.release(); } catch { /* released */ }
    await pool?.end().catch(() => undefined);
  });

  it('suggestions → unchanged batch passes; origin «suggested», sequential versions, one audit + event per allocation', async () => {
    const doc = await receipt([{ lineNo: 1, quantity: 3 }, { lineNo: 2, quantity: 10 }]);
    const suggestions = await workspace.allocationSuggestions(admin, doc.documentId);
    const items = itemsFromSuggestions(suggestions);
    // Заказ 0 (раньше срок) получает 3 из строки 1 и остаток из строки 2 — две записи на один закуп.
    expect(items.filter((item) => item.orderId === orderIds[0]).map((item) => item.lineId)).toEqual(doc.lineIds);
    const before = [await events(orderIds[0]), await events(orderIds[1])];
    const result = await batch(docsA, doc.documentId, items);
    expect(result.changed).toBe(true);
    expect(result.results.every((entry) => !entry.noop)).toBe(true);
    expect([await events(orderIds[0]) - before[0], await events(orderIds[1]) - before[1]]).toEqual([2, 1]);
    const rows = (await connA.query(
      `SELECT a.origin, orp.version, orp.origin AS mark_origin, orp.purchased FROM order_resource_onec_allocations a
         JOIN order_resource_procurement orp ON orp.order_resource_procurement_id = a.order_resource_procurement_id
        WHERE orp.order_id = $1 AND a.removed_at IS NULL`, [orderIds[0]])).rows;
    expect(rows.every((row) => row.origin === 'suggested' && row.mark_origin === 'onec' && row.purchased)).toBe(true);
    expect(Number(rows[0].version)).toBe(2);
    const audit = (await connA.query(
      `SELECT count(*)::int AS c FROM audit_log WHERE event = 'order_resource.onec_allocation_added'
         AND metadata_json->>'onecDocumentId' = $1 AND metadata_json->>'allocationOrigin' = 'suggested'`,
      [String(doc.documentId)])).rows[0].c;
    expect(audit).toBe(3);
    // Повтор того же запроса после потерянного ответа — no-op, без событий.
    const afterEvents = await events(orderIds[0]);
    const repeat = await batch(docsA, doc.documentId, items.map((item) => ({ ...item })));
    expect(repeat.changed).toBe(false);
    expect(repeat.results.every((entry) => entry.noop)).toBe(true);
    expect(await events(orderIds[0])).toBe(afterEvents);
    // Подбор больше не предлагает распределённые пары.
    const again = await workspace.allocationSuggestions(admin, doc.documentId);
    expect(again.lines.flatMap((line) => line.candidates).filter((candidate) => candidate.proposedInDocUnit > 0)).toEqual([]);
    expect(again.lines[0].alreadyAllocated.map((entry) => entry.orderId)).toContain(orderIds[0]);
  });

  it('capacity: active 2 + repeat of it + new 3 on a 5-unit line passes; a different quantity for an allocated pair → 409, nothing written', async () => {
    const orderId = await makeOrder(2, 9000, addDays(today, 3));
    const other = await makeOrder(3, 9000, addDays(today, 4));
    const doc = await receipt([{ lineNo: 1, quantity: 5 }]);
    const d0 = await demand(orderId);
    const first = await batch(docsA, doc.documentId, [{ lineId: doc.lineIds[0], orderId, resourceKey: key(), quantity: 2,
      expectedVersion: d0.procurement.version, expectedDemandFingerprint: d0.demandFingerprint }]);
    expect(first.changed).toBe(true);
    const d1 = await demand(other);
    const mixed = await batch(docsA, doc.documentId, [
      { lineId: doc.lineIds[0], orderId, resourceKey: key(), quantity: 2, expectedVersion: d0.procurement.version, expectedDemandFingerprint: d0.demandFingerprint },
      { lineId: doc.lineIds[0], orderId: other, resourceKey: key(), quantity: 3, expectedVersion: d1.procurement.version, expectedDemandFingerprint: d1.demandFingerprint },
    ]);
    expect(mixed.results.map((entry) => entry.noop)).toEqual([true, false]);
    const eventsBefore = await events(orderId);
    await expect(batch(docsA, doc.documentId, [{ lineId: doc.lineIds[0], orderId, resourceKey: key(), quantity: 1.5,
      expectedVersion: (await demand(orderId)).procurement.version, expectedDemandFingerprint: d0.demandFingerprint }]))
      .rejects.toMatchObject({ statusCode: 409, code: 'ONEC_ALLOCATION_BATCH_CONFLICT', details: { failures: [expect.objectContaining({ code: 'ONEC_ALLOCATION_EXISTS' })] } });
    expect(await events(orderId)).toBe(eventsBefore);
  });

  it('1C loader: a line in conflict / removed in 1C refuses new allocations (409, per-item code, nothing written); a repeat stays a no-op', async () => {
    const orderId = await makeOrder(40, 9000, addDays(today, 3));
    const other = await makeOrder(41, 9000, addDays(today, 4));
    const doc = await receipt([{ lineNo: 1, quantity: 5 }]);
    const d0 = await demand(orderId);
    await batch(docsA, doc.documentId, [{ lineId: doc.lineIds[0], orderId, resourceKey: key(), quantity: 2,
      expectedVersion: d0.procurement.version, expectedDemandFingerprint: d0.demandFingerprint }]);
    const repeat = { lineId: doc.lineIds[0], orderId, resourceKey: key(), quantity: 2,
      expectedVersion: (await demand(orderId)).procurement.version, expectedDemandFingerprint: d0.demandFingerprint };
    const d1 = await demand(other);
    const fresh = { lineId: doc.lineIds[0], orderId: other, resourceKey: key(), quantity: 1,
      expectedVersion: d1.procurement.version, expectedDemandFingerprint: d1.demandFingerprint };
    for (const [column, value, code] of [
      ['load_conflict_code', 'QUANTITY_BELOW_ALLOCATED', 'ONEC_LINE_CONFLICT'],
      ['removed_in_onec_at', new Date().toISOString(), 'ONEC_LINE_REMOVED_IN_ONEC'],
    ] as const) {
      await pool.query(`UPDATE onec_document_lines SET ${column} = $2 WHERE onec_document_line_id = $1`, [doc.lineIds[0], value]);
      try {
        // Повтор существующего распределения классифицируется до проверки строки — no-op.
        expect((await batch(docsA, doc.documentId, [repeat])).results.map((entry) => entry.noop)).toEqual([true]);
        const before = await events(other);
        await expect(batch(docsA, doc.documentId, [fresh])).rejects.toMatchObject({
          statusCode: 409, code: 'ONEC_ALLOCATION_BATCH_CONFLICT', details: { failures: [expect.objectContaining({ index: 0, code })] },
        });
        expect(await events(other)).toBe(before);
      } finally {
        await pool.query(`UPDATE onec_document_lines SET ${column} = NULL WHERE onec_document_line_id = $1`, [doc.lineIds[0]]);
      }
    }
  });

  it('all-or-nothing: one stale item rejects the whole batch; over-capacity and changed demand are reported per item', async () => {
    const a = await makeOrder(4, 5000, addDays(today, 3));
    const b = await makeOrder(5, 5000, addDays(today, 3));
    const doc = await receipt([{ lineNo: 1, quantity: 6 }]);
    const da = await demand(a);
    const db = await demand(b);
    const countAllocations = async () => Number((await connA.query(
      `SELECT count(*)::int AS c FROM order_resource_onec_allocations WHERE onec_document_line_id = $1`, [doc.lineIds[0]])).rows[0].c);
    await expect(batch(docsA, doc.documentId, [
      { lineId: doc.lineIds[0], orderId: a, resourceKey: key(), quantity: 2, expectedVersion: da.procurement.version, expectedDemandFingerprint: da.demandFingerprint },
      { lineId: doc.lineIds[0], orderId: b, resourceKey: key(), quantity: 2, expectedVersion: db.procurement.version + 5, expectedDemandFingerprint: db.demandFingerprint },
    ])).rejects.toMatchObject({ code: 'ONEC_ALLOCATION_BATCH_CONFLICT', details: { failures: [{ index: 1, code: 'PROCUREMENT_VERSION_CONFLICT', message: expect.any(String) }] } });
    expect(await countAllocations()).toBe(0);
    await expect(batch(docsA, doc.documentId, [
      { lineId: doc.lineIds[0], orderId: a, resourceKey: key(), quantity: 4, expectedVersion: da.procurement.version, expectedDemandFingerprint: da.demandFingerprint },
      { lineId: doc.lineIds[0], orderId: b, resourceKey: key(), quantity: 4, expectedVersion: db.procurement.version, expectedDemandFingerprint: db.demandFingerprint },
    ])).rejects.toMatchObject({ details: { failures: [
      expect.objectContaining({ index: 0, code: 'ONEC_ALLOCATION_EXCEEDS_LINE' }), expect.objectContaining({ index: 1, code: 'ONEC_ALLOCATION_EXCEEDS_LINE' }),
    ] } });
    await connA.query('BEGIN');
    await connA.query('UPDATE order_details SET width = 5100 WHERE order_id = $1', [a]);
    await connA.query('COMMIT');
    await expect(batch(docsA, doc.documentId, [
      { lineId: doc.lineIds[0], orderId: a, resourceKey: key(), quantity: 1, expectedVersion: da.procurement.version, expectedDemandFingerprint: da.demandFingerprint },
    ])).rejects.toMatchObject({ details: { failures: [expect.objectContaining({ code: 'PROCUREMENT_DEMAND_CHANGED' })] } });
    expect(await countAllocations()).toBe(0);
  });

  it('structure: duplicates and inconsistent versions → 422; an order out of scope → 404 for the whole batch', async () => {
    const doc = await receipt([{ lineNo: 1, quantity: 5 }, { lineNo: 2, quantity: 5 }]);
    const orderId = await makeOrder(6, 2000, addDays(today, 3));
    const d = await demand(orderId);
    const item = { lineId: doc.lineIds[0], orderId, resourceKey: key(), quantity: 1, expectedVersion: d.procurement.version, expectedDemandFingerprint: d.demandFingerprint };
    await expect(batch(docsA, doc.documentId, [item, { ...item }])).rejects.toMatchObject({ statusCode: 422, code: 'ONEC_ALLOCATION_BATCH_DUPLICATE_ITEM' });
    await expect(batch(docsA, doc.documentId, [item, { ...item, lineId: doc.lineIds[1], expectedVersion: 9 }]))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_ALLOCATION_BATCH_INCONSISTENT' });
    await expect(batch(docsA, doc.documentId, [item], manager)).rejects.toMatchObject({ statusCode: 404 });
    const managerSuggestions = await workspace.allocationSuggestions(manager, doc.documentId);
    expect(managerSuggestions.lines.flatMap((line) => line.candidates)).toEqual([]);
  });

  it('CR1-5: an allocation on an issued (but visible) order stays in «уже распределено»; the order is not a candidate', async () => {
    const orderId = await makeOrder(9, 3000, addDays(today, 3));
    const doc = await receipt([{ lineNo: 1, quantity: 5 }]);
    const d = await demand(orderId);
    await batch(docsA, doc.documentId, [{ lineId: doc.lineIds[0], orderId, resourceKey: key(), quantity: 1,
      expectedVersion: d.procurement.version, expectedDemandFingerprint: d.demandFingerprint }]);
    await connA.query('BEGIN');
    await connA.query('UPDATE orders SET issue_date = order_date WHERE order_id = $1', [orderId]);
    await connA.query('COMMIT');
    const suggestions = await workspace.allocationSuggestions(admin, doc.documentId);
    expect(suggestions.lines[0].alreadyAllocated.map((entry) => entry.orderId)).toContain(orderId);
    expect(suggestions.lines[0].candidates.map((candidate) => candidate.orderId)).not.toContain(orderId);
    expect(suggestions.lines[0].remainingInDocUnit).toBe(4);
    // Для пользователя вне scope — не называется.
    const managerView = await workspace.allocationSuggestions(manager, doc.documentId);
    expect(managerView.lines[0].alreadyAllocated).toEqual([]);
  });

  it('CR3-1: the sheet size changed while the panel was open → the old proposal is rejected; an unchanged repeat stays a no-op', async () => {
    const orderId = await makeOrder(10, 2000, addDays(today, 3));
    const doc = await receipt([{ lineNo: 1, quantity: 5, unit: 'sheet' }]);
    const suggestions = await workspace.allocationSuggestions(admin, doc.documentId);
    const items = itemsFromSuggestions(suggestions).filter((item) => item.orderId === orderId);
    expect(items).toHaveLength(1);
    expect(items[0].expectedDocUnit).toBe('sheet');
    const dims = (await connA.query('SELECT width_mm FROM sheet_material_types WHERE sheet_material_type_id = $1', [material])).rows[0];
    await connA.query('UPDATE sheet_material_types SET width_mm = $2 WHERE sheet_material_type_id = $1', [material, Number(dims.width_mm) * 2]);
    try {
      await expect(batch(docsA, doc.documentId, items)).rejects.toMatchObject({
        code: 'ONEC_ALLOCATION_BATCH_CONFLICT', details: { failures: [expect.objectContaining({ code: 'ONEC_ALLOCATION_UNIT_CHANGED' })] },
      });
      expect(Number((await connA.query(
        'SELECT count(*)::int AS c FROM order_resource_onec_allocations WHERE onec_document_line_id = $1', [doc.lineIds[0]])).rows[0].c)).toBe(0);
    } finally {
      await connA.query('UPDATE sheet_material_types SET width_mm = $2 WHERE sheet_material_type_id = $1', [material, Number(dims.width_mm)]);
    }
    const ok = await batch(docsA, doc.documentId, items);
    expect(ok.changed).toBe(true);
    // Повтор той же команды после изменения размеров — no-op (контекст проверяется только для новых распределений).
    await connA.query('UPDATE sheet_material_types SET width_mm = $2 WHERE sheet_material_type_id = $1', [material, Number(dims.width_mm) * 2]);
    try {
      expect((await batch(docsA, doc.documentId, items)).changed).toBe(false);
    } finally {
      await connA.query('UPDATE sheet_material_types SET width_mm = $2 WHERE sheet_material_type_id = $1', [material, Number(dims.width_mm)]);
    }
  });

  it('two concurrent batches on one line never exceed it: exactly one wins', async () => {
    const a = await makeOrder(7, 5000, addDays(today, 3));
    const b = await makeOrder(8, 5000, addDays(today, 3));
    const doc = await receipt([{ lineNo: 1, quantity: 5 }]);
    const da = await demand(a);
    const db = await demand(b);
    const results = await Promise.allSettled([
      batch(docsA, doc.documentId, [{ lineId: doc.lineIds[0], orderId: a, resourceKey: key(), quantity: 4, expectedVersion: da.procurement.version, expectedDemandFingerprint: da.demandFingerprint }]),
      batch(docsB, doc.documentId, [{ lineId: doc.lineIds[0], orderId: b, resourceKey: key(), quantity: 4, expectedVersion: db.procurement.version, expectedDemandFingerprint: db.demandFingerprint }]),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const sum = Number((await connA.query(
      `SELECT COALESCE(sum(quantity), 0)::text AS s FROM order_resource_onec_allocations WHERE onec_document_line_id = $1 AND removed_at IS NULL`,
      [doc.lineIds[0]])).rows[0].s);
    expect(sum).toBeLessThanOrEqual(5);
  });
});
