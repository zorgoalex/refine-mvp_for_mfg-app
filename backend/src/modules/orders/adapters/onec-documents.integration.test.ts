import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { OrderResourceDemandLineDto } from '../application/order-resource-demand.types';
import { PgOnecDocumentsRepository } from './pg-onec-documents-repository';
import { PgOrderResourceDemandRepository } from './pg-order-resource-demand-repository';
import { PgOrderResourceProcurementRepository } from './pg-order-resource-procurement-repository';

// Committed fixtures in an OWNED disposable database only (see run-races.cjs):
// the URL must opt in via ERP_PROCUREMENT_RACE_DATABASE_URL and name a "procurement_race_*" database.
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

describe.skipIf(!url)('1C documents allocations — real PostgreSQL, committed fixtures', { timeout: 30000 }, () => {
  let pool: Pool;
  let connA: PoolClient;
  let connB: PoolClient;
  let docsA: PgOnecDocumentsRepository;
  let docsB: PgOnecDocumentsRepository;
  let commandsA: PgOrderResourceProcurementRepository;
  let readsA: PgOrderResourceDemandRepository;
  const tag = 'E2E-Тест-1С-' + randomUUID().slice(0, 8);
  let admin: CurrentUser;
  let adminNoFinance: CurrentUser;
  let manager: CurrentUser;
  let orderIds: number[] = [];
  let sheetMaterialTypeId: number;
  let otherSheetMaterialTypeId: number;
  let receiptId: number;
  let receiptLineId: number;
  let unmappedLineId: number;
  let otherMaterialLineId: number;
  let unpostedId: number;
  let unpostedLineId: number;
  let paymentId: number;
  let paymentLineId: number;
  let paymentExtraLineId: number;

  const sheetKey = () => `sheet_material:${sheetMaterialTypeId}`;
  const options = { procurementEnabled: true, canSeeAmounts: true };

  async function line(orderId: number, user: CurrentUser = admin): Promise<OrderResourceDemandLineDto> {
    const card = await readsA.getCard({ currentUser: user, orderId }, options);
    const found = card.data.lines.find((candidate) => candidate.resourceKey === sheetKey());
    if (!found) throw new Error(`sheet line not found in order ${orderId}`);
    return found;
  }

  async function events(orderId: number) {
    return Number((await connA.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox_events WHERE event_type = 'order.resource_procurement_changed' AND aggregate_id = $1`,
      [String(orderId)])).rows[0].c);
  }

  const add = (repo: PgOnecDocumentsRepository, input: {
    orderId: number; lineId?: number; documentId?: number; quantity?: number; amount?: number;
    expectedVersion: number; expectedDemandFingerprint: string; user?: CurrentUser; suffix: string;
  }) => repo.addAllocation({
    currentUser: input.user ?? admin,
    documentId: input.documentId ?? receiptId,
    lineId: input.lineId ?? receiptLineId,
    orderId: input.orderId,
    resourceKey: sheetKey(),
    ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    expectedVersion: input.expectedVersion,
    expectedDemandFingerprint: input.expectedDemandFingerprint,
    requestId: `${tag}-${input.suffix}`,
  });

  beforeAll(async () => {
    expect(targetEnv).toBe('backend-test');
    expect(decodeURIComponent(new URL(url!).pathname.slice(1)).startsWith('procurement_race_')).toBe(true);
    pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
    connA = await pool.connect();
    connB = await pool.connect();
    docsA = new PgOnecDocumentsRepository(new CommittedDatabase(connA));
    docsB = new PgOnecDocumentsRepository(new CommittedDatabase(connB));
    commandsA = new PgOrderResourceProcurementRepository(new CommittedDatabase(connA));
    readsA = new PgOrderResourceDemandRepository(new CommittedDatabase(connA));

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
    const perms = ['orders.view', 'procurement.view', 'procurement.manage'] as const;
    admin = { id: String(adminId), username: tag + '-admin', role: 'admin', roleId: 1, permissions: [...perms, 'finance.view'] };
    adminNoFinance = { ...admin, permissions: [...perms] };
    manager = { id: String(managerId), username: tag + '-manager', role: 'manager', roleId: 10, permissions: [...perms, 'finance.view'] };

    const smts = (await connA.query('SELECT sheet_material_type_id FROM sheet_material_types ORDER BY sheet_material_type_id LIMIT 2')).rows;
    sheetMaterialTypeId = Number(smts[0].sheet_material_type_id);
    otherSheetMaterialTypeId = Number(smts[1].sheet_material_type_id);
    const millingTypeId = Number((await connA.query('SELECT milling_type_id FROM milling_types ORDER BY 1 LIMIT 1')).rows[0].milling_type_id);
    const edgeTypeId = Number((await connA.query('SELECT edge_type_id FROM edge_types ORDER BY 1 LIMIT 1')).rows[0].edge_type_id);
    const clientId = Number((await connA.query('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [tag])).rows[0].client_id);
    const projectId = Number((await connA.query(
      'INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, $2, $3, $4) RETURNING project_id',
      [('E2E-' + randomUUID().slice(0, 8)).toUpperCase(), tag, clientId, adminId])).rows[0].project_id);
    orderIds = [];
    for (let index = 0; index < 3; index += 1) {
      await connA.query('BEGIN');
      const orderId = Number((await connA.query(
        `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by)
         VALUES ($1, $2, $3, 1, 1, $4) RETURNING order_id`, [`${tag}-${index}`, clientId, projectId, adminId])).rows[0].order_id);
      await connA.query(
        `INSERT INTO order_details (order_id, detail_number, height, width, quantity, area,
            sheet_material_type_id, milling_type_id, edge_type_id, created_by)
         VALUES ($1, 1, 1000, 1000, 2, 2, $2, $3, $4, $5)`,
        [orderId, sheetMaterialTypeId, millingTypeId, edgeTypeId, adminId]);
      await connA.query('COMMIT');
      orderIds.push(orderId);
    }

    const sourceId = Number((await connA.query(
      `INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id`,
      [('e2e-' + randomUUID().slice(0, 8)), tag])).rows[0].source_id);
    const doc = async (kind: string, posted: boolean, amount: number | null) => Number((await connA.query(
      `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, counterparty_name, amount)
       VALUES ($1, $2, $3, $4, '2026-09-27', $5, $6, $7) RETURNING onec_document_id`,
      [sourceId, kind, randomUUID(), `${tag.slice(-8)}-${kind.slice(0, 3)}-${posted}`, posted, `${tag} поставщик`, amount])).rows[0].onec_document_id);
    const docLine = async (documentId: number, lineNo: number, quantity: number, smt: number | null, amount: number | null = null, total = false) => Number((await connA.query(
      `INSERT INTO onec_document_lines (onec_document_id, line_no, nomenclature_name, quantity, unit_code, amount, is_document_total, sheet_material_type_id)
       VALUES ($1, $2, $3, $4, 'm2', $5, $6, $7) RETURNING onec_document_line_id`,
      [documentId, lineNo, `${tag} номенклатура ${lineNo}`, quantity, amount, total, smt])).rows[0].onec_document_line_id);
    receiptId = await doc('purchase_receipt', true, 50000);
    receiptLineId = await docLine(receiptId, 1, 5, sheetMaterialTypeId);
    unmappedLineId = await docLine(receiptId, 2, 3, null);
    otherMaterialLineId = await docLine(receiptId, 3, 3, otherSheetMaterialTypeId);
    unpostedId = await doc('purchase_receipt', false, 1000);
    unpostedLineId = await docLine(unpostedId, 1, 5, sheetMaterialTypeId);
    paymentId = await doc('cash_outflow', true, 10000);
    paymentLineId = await docLine(paymentId, 1, 0, null, 10000, true);
    paymentExtraLineId = await docLine(paymentId, 2, 0, null, 10000, false);
  }, 30000);

  afterAll(async () => {
    try { connA?.release(); } catch { /* released */ }
    try { connB?.release(); } catch { /* released */ }
    await pool?.end().catch(() => undefined);
  });

  it('a receipt allocation marks the material purchased once, with audit, event and a lock on unmarking', async () => {
    const orderId = orderIds[0];
    const seen = await line(orderId);
    const beforeEvents = await events(orderId);
    const result = await add(docsA, { orderId, quantity: 2, expectedVersion: 0, expectedDemandFingerprint: seen.demandFingerprint, suffix: 'add' });
    expect(result.changed).toBe(true);
    expect(result.line.procurement).toMatchObject({ purchased: true, version: 1, origin: 'onec' }); // R9-1: авто-отметка приходом — origin 'onec'
    expect(result.line.lockedByOnec).toBe(true);
    expect(result.line.onec.receipts).toEqual([expect.objectContaining({ documentId: receiptId, quantity: 2, linkOrigin: 'manual' })]);
    expect(await events(orderId)).toBe(beforeEvents + 1);
    const audit = (await connA.query(`SELECT event FROM audit_log WHERE request_id = $1`, [`${tag}-add`])).rows;
    expect(audit).toEqual([{ event: 'order_resource.onec_allocation_added' }]);

    await expect(commandsA.set({
      currentUser: admin, orderId, resourceKey: sheetKey(), purchased: false,
      expectedVersion: 1, expectedDemandFingerprint: seen.demandFingerprint, requestId: `${tag}-unmark-locked`,
    })).rejects.toMatchObject({ statusCode: 409, code: 'PROCUREMENT_LOCKED_BY_ONEC' });
    await expect(commandsA.bulk({
      currentUser: admin, resourceKey: sheetKey(), purchased: false, requestId: `${tag}-bulk-locked`,
      items: [{ orderId, expectedVersion: 1, expectedDemandFingerprint: seen.demandFingerprint }],
    })).rejects.toMatchObject({ statusCode: 409, code: 'PROCUREMENT_BULK_CONFLICT' });
  });

  it('repeats the same allocation as a no-op and refuses a different quantity for the same pair', async () => {
    const orderId = orderIds[0];
    const current = await line(orderId);
    const repeat = await add(docsA, { orderId, quantity: 2, expectedVersion: 0, expectedDemandFingerprint: current.demandFingerprint, suffix: 'repeat' });
    expect(repeat.changed).toBe(false);
    await expect(add(docsA, { orderId, quantity: 1, expectedVersion: current.procurement.version, expectedDemandFingerprint: current.demandFingerprint, suffix: 'other-qty' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ONEC_ALLOCATION_EXISTS' });
  });

  it('rejects unposted documents, unmapped lines, other materials, wrong measures and payments without finance', async () => {
    const orderId = orderIds[1];
    const seen = await line(orderId);
    const base = { orderId, expectedVersion: seen.procurement.version, expectedDemandFingerprint: seen.demandFingerprint };
    await expect(add(docsA, { ...base, documentId: unpostedId, lineId: unpostedLineId, quantity: 1, suffix: 'unposted' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ONEC_DOCUMENT_NOT_ALLOCATABLE' });
    await expect(add(docsA, { ...base, lineId: unmappedLineId, quantity: 1, suffix: 'unmapped' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_LINE_NOT_MAPPED' });
    await expect(add(docsA, { ...base, lineId: otherMaterialLineId, quantity: 1, suffix: 'mismatch' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_LINE_RESOURCE_MISMATCH' });
    await expect(add(docsA, { ...base, amount: 100, suffix: 'measure' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_ALLOCATION_MEASURE_INVALID' });
    await expect(add(docsA, { ...base, documentId: paymentId, lineId: paymentLineId, amount: 100, user: adminNoFinance, suffix: 'no-finance' }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect((await line(orderId)).procurement.version).toBe(seen.procurement.version);
  });

  it('two orders racing for the last quantity of one line: one wins, the other gets EXCEEDS_LINE', async () => {
    // Line 1 has 5; order 0 holds 2; orders 1 and 2 both ask for 3 → only one fits.
    const [first, second] = [orderIds[1], orderIds[2]];
    const [a, b] = await Promise.all([line(first), line(second)]);
    const pids = await Promise.all([connA, connB].map(async (conn) =>
      Number((await conn.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid)));
    const holder = await pool.connect();
    let outcomes: PromiseSettledResult<unknown>[];
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM onec_document_lines WHERE onec_document_line_id = $1 FOR UPDATE', [receiptLineId]);
      const left = add(docsA, { orderId: first, quantity: 3, expectedVersion: a.procurement.version, expectedDemandFingerprint: a.demandFingerprint, suffix: 'race-a' });
      const right = add(docsB, { orderId: second, quantity: 3, expectedVersion: b.procurement.version, expectedDemandFingerprint: b.demandFingerprint, suffix: 'race-b' });
      const settled = Promise.allSettled([left, right]);
      const deadline = Date.now() + 8000;
      for (;;) {
        const waiting = (await pool.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock'`,
          [pids])).rows[0].c;
        if (waiting === 2) break;
        if (Date.now() > deadline) throw new Error('allocations did not queue behind the held line lock');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await holder.query('COMMIT');
      outcomes = await settled;
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ statusCode: 409, code: 'ONEC_ALLOCATION_EXCEEDS_LINE' });
    const used = Number((await connA.query<{ s: string }>(
      `SELECT COALESCE(sum(quantity), 0)::text AS s FROM order_resource_onec_allocations WHERE onec_document_line_id = $1 AND removed_at IS NULL`,
      [receiptLineId])).rows[0].s);
    expect(used).toBe(5);
  });

  it('removal bumps the version, unlocks unmarking, repeats as a no-op and a stale re-add is refused', async () => {
    const orderId = orderIds[0];
    const current = await line(orderId);
    const allocationId = current.onec.receipts[0].allocationId;
    const removed = await docsA.removeAllocation({ currentUser: admin, documentId: receiptId, lineId: receiptLineId, allocationId,
      expectedVersion: current.procurement.version, requestId: `${tag}-remove` });
    expect(removed.changed).toBe(true);
    expect(removed.line).toMatchObject({ lockedByOnec: false, procurement: { purchased: true, version: current.procurement.version + 1 } });
    const again = await docsA.removeAllocation({ currentUser: admin, documentId: receiptId, lineId: receiptLineId, allocationId,
      expectedVersion: current.procurement.version, requestId: `${tag}-remove-again` });
    expect(again.changed).toBe(false);
    await expect(add(docsA, { orderId, quantity: 2, expectedVersion: current.procurement.version, expectedDemandFingerprint: current.demandFingerprint, suffix: 'stale-readd' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PROCUREMENT_VERSION_CONFLICT' });
    const unmark = await commandsA.set({ currentUser: admin, orderId, resourceKey: sheetKey(), purchased: false,
      expectedVersion: removed.line.procurement.version, expectedDemandFingerprint: current.demandFingerprint, requestId: `${tag}-unmark-free` });
    expect(unmark.changed).toBe(true);
  });

  it('allocates payments by amount within the document total', async () => {
    const orderId = orderIds[2];
    const current = await line(orderId);
    const paid = await add(docsA, { orderId, documentId: paymentId, lineId: paymentLineId, amount: 4000,
      expectedVersion: current.procurement.version, expectedDemandFingerprint: current.demandFingerprint, suffix: 'pay' });
    expect(paid.line.onec.payments).toEqual([expect.objectContaining({ documentId: paymentId, amount: 4000 })]);
    const next = await line(orderId);
    await expect(add(docsA, { orderId: orderIds[1], documentId: paymentId, lineId: paymentLineId, amount: 7000,
      expectedVersion: (await line(orderIds[1])).procurement.version, expectedDemandFingerprint: (await line(orderIds[1])).demandFingerprint, suffix: 'pay-over' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'ONEC_ALLOCATION_EXCEEDS_LINE' });
    expect(next.lockedByOnec).toBe((next.onec.receipts ?? []).length > 0);
  });

  it('lists and shows documents with only in-scope orders and hides sums without finance', async () => {
    const list = await docsA.list(admin, { tab: 'receipts', page: 1, pageSize: 50, search: tag.slice(-8) }, options);
    const receipt = list.data.find((row) => row.documentId === receiptId);
    // Строка 1 распределена полностью, строки 2–3 (несопоставленная и чужой материал) — нет.
    expect(receipt).toMatchObject({ allocationState: 'partial', amount: 50000 });
    expect(receipt?.orders.length).toBeGreaterThan(0);
    const managerView = await docsA.list(manager, { tab: 'receipts', page: 1, pageSize: 50 }, options);
    const hidden = managerView.data.find((row) => row.documentId === receiptId);
    expect(hidden?.orders).toEqual([]);
    expect(hidden?.hiddenOrdersCount).toBeGreaterThan(0);
    const noFinance = await docsA.getCard(adminNoFinance, paymentId, { procurementEnabled: true, canSeeAmounts: false });
    expect(noFinance.data.amount).toBeNull();
    expect(noFinance.data.lines[0]).toMatchObject({ amount: null, allocated: null, remaining: null });
    const unlinked = await docsA.list(admin, { tab: 'receipts', page: 1, pageSize: 50, unlinkedOnly: true }, options);
    expect(unlinked.data.some((row) => row.documentId === receiptId)).toBe(false);
    expect(unlinked.data.some((row) => row.documentId === unpostedId)).toBe(true);
  });

  it('filters receipts by allocation completeness exactly as allocationState and returns the line summary', async () => {
    const all = await docsA.list(admin, { tab: 'receipts', page: 1, pageSize: 100 }, options);
    const open = await docsA.list(admin, { tab: 'receipts', page: 1, pageSize: 100, allocation: 'open', withLines: true }, options);
    const full = await docsA.list(admin, { tab: 'receipts', page: 1, pageSize: 100, allocation: 'full' }, options);
    // Фильтр и поле состояния — одно правило: «open» = none|partial, «full» = full; вместе — весь список.
    expect(open.data.every((row) => row.allocationState !== 'full')).toBe(true);
    expect(full.data.every((row) => row.allocationState === 'full')).toBe(true);
    expect(open.pagination.total + full.pagination.total).toBe(all.pagination.total);
    expect(open.data.some((row) => row.documentId === receiptId)).toBe(true);
    expect(full.data.some((row) => row.documentId === receiptId)).toBe(false);
    const receipt = open.data.find((row) => row.documentId === receiptId)!;
    expect(receipt.lineSummary?.map((line) => [line.lineNo, line.quantity])).toEqual([[1, 5], [2, 3], [3, 3]]);
    expect(receipt.lineSummaryMore).toBe(0);
    expect(receipt.lineSummary?.every((line) => typeof line.name === 'string' && line.name.length > 0)).toBe(true);
    // Без withLines поля нет — старый контракт не меняется.
    expect(all.data.find((row) => row.documentId === receiptId)).not.toHaveProperty('lineSummary');
  });

  it('filters the demand list and by-material summary to orders linked to one document', async () => {
    const linked = (await connA.query<{ order_id: string }>(
      `SELECT DISTINCT p.order_id::text FROM order_resource_onec_allocations a
         JOIN order_resource_procurement p ON p.order_resource_procurement_id = a.order_resource_procurement_id
         JOIN onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
        WHERE a.removed_at IS NULL AND l.onec_document_id = $1`, [receiptId])).rows.map((row) => Number(row.order_id)).sort();
    expect(linked.length).toBeGreaterThan(0);
    const listed = await readsA.list({ currentUser: admin, query: { page: 1, pageSize: 100, onecDocumentId: receiptId } }, options);
    expect(listed.data.map((row) => row.orderId).sort()).toEqual(linked);
    const aggregate = await readsA.listByMaterial({ currentUser: admin, query: { page: 1, pageSize: 20, onecDocumentId: receiptId } }, options);
    expect(aggregate.ordersCount).toBe(linked.length);
    const scoped = await readsA.list({ currentUser: manager, query: { page: 1, pageSize: 100, onecDocumentId: receiptId } }, options);
    expect(scoped.data).toEqual([]);
    const flagOff = await readsA.list({ currentUser: admin, query: { page: 1, pageSize: 100, onecDocumentId: receiptId } },
      { procurementEnabled: false });
    expect(flagOff.data).toEqual([]);
  });

  it('offers as filter options exactly the documents allocated to the listed orders', async () => {
    const expected = (await connA.query<{ id: string }>(
      `SELECT DISTINCT l.onec_document_id::text AS id FROM order_resource_onec_allocations a
         JOIN order_resource_procurement p ON p.order_resource_procurement_id = a.order_resource_procurement_id
         JOIN onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
        WHERE a.removed_at IS NULL AND p.order_id = ANY($1::bigint[])`, [orderIds])).rows.map((row) => Number(row.id)).sort();
    const query = { page: 1, pageSize: 20, search: tag };
    const result = await readsA.listOnecDocumentOptions({ currentUser: admin, query }, options);
    expect(result.data.map((row) => row.documentId).sort()).toEqual(expected);
    expect(result.truncated).toBe(false);
    // The selected document must not narrow its own option list.
    const withSelection = await readsA.listOnecDocumentOptions({ currentUser: admin, query: { ...query, onecDocumentId: receiptId } }, options);
    expect(withSelection.data.map((row) => row.documentId).sort()).toEqual(expected);
    expect((await readsA.listOnecDocumentOptions({ currentUser: manager, query }, options)).data).toEqual([]);
    expect((await readsA.listOnecDocumentOptions({ currentUser: admin, query }, { procurementEnabled: false })).data).toEqual([]);
  });

  it('refuses allocations and removals on orders outside the user scope', async () => {
    const orderId = orderIds[1];
    const current = await line(orderId);
    await expect(add(docsA, { orderId, quantity: 1, user: manager, expectedVersion: current.procurement.version,
      expectedDemandFingerprint: current.demandFingerprint, suffix: 'scope' })).rejects.toMatchObject({ statusCode: 404 });
    const allocation = (await connA.query<{ allocation_id: string }>(
      `SELECT a.allocation_id::text FROM order_resource_onec_allocations a
         JOIN order_resource_procurement p ON p.order_resource_procurement_id = a.order_resource_procurement_id
        WHERE a.removed_at IS NULL AND p.order_id = ANY($1::bigint[]) LIMIT 1`, [orderIds])).rows[0];
    const [lineRow] = (await connA.query<{ onec_document_line_id: string; onec_document_id: string }>(
      `SELECT l.onec_document_line_id::text, l.onec_document_id::text FROM order_resource_onec_allocations a
         JOIN onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id WHERE a.allocation_id = $1`,
      [allocation.allocation_id])).rows;
    await expect(docsA.removeAllocation({ currentUser: manager, documentId: Number(lineRow.onec_document_id),
      lineId: Number(lineRow.onec_document_line_id), allocationId: Number(allocation.allocation_id), expectedVersion: 1,
      requestId: `${tag}-scope-remove` })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a document deleted in 1C no longer locks the purchase mark', async () => {
    const lockedOrder = (await Promise.all(orderIds.map(async (orderId) => ({ orderId, line: await line(orderId) }))))
      .find(({ line: candidate }) => candidate.lockedByOnec);
    expect(lockedOrder).toBeDefined();
    await connA.query('UPDATE onec_documents SET deleted_in_onec = true WHERE onec_document_id = $1', [receiptId]);
    const after = await line(lockedOrder!.orderId);
    expect(after.lockedByOnec).toBe(false);
    const unmark = await commandsA.set({ currentUser: admin, orderId: lockedOrder!.orderId, resourceKey: sheetKey(), purchased: false,
      expectedVersion: after.procurement.version, expectedDemandFingerprint: after.demandFingerprint, requestId: `${tag}-deleted-unlock` });
    expect(unmark.changed).toBe(true);
  });

  it('allows payments only on the single document-total line', async () => {
    const orderId = orderIds[1];
    const current = await line(orderId);
    await expect(add(docsA, { orderId, documentId: paymentId, lineId: paymentExtraLineId, amount: 100,
      expectedVersion: current.procurement.version, expectedDemandFingerprint: current.demandFingerprint, suffix: 'pay-not-total' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_PAYMENT_LINE_INVALID' });
    await expect(connA.query(
      `INSERT INTO onec_document_lines (onec_document_id, line_no, quantity, amount, is_document_total)
       VALUES ($1, 99, 0, 10000, true)`, [paymentId])).rejects.toMatchObject({ code: '23505' });
  });

  it('a payment on a material that left the order can still be removed with the version carried by the allocation', async () => {
    const orderId = orderIds[2];
    const card = await docsA.getCard(admin, paymentId, options);
    const allocation = card.data.lines.flatMap((row) => row.allocations).find((row) => row.orderId === orderId);
    expect(allocation).toBeDefined();
    await connA.query(
      `UPDATE order_details SET sheet_material_type_id = $2, updated_at = now() WHERE order_id = $1`,
      [orderId, otherSheetMaterialTypeId]);
    const demand = await readsA.getCard({ currentUser: admin, orderId }, options);
    const orphan = demand.data.lines.find((row) => row.resourceKey === sheetKey());
    expect(orphan).toMatchObject({ orphan: true, procurement: { purchased: false } });
    expect(orphan?.onec.payments).toHaveLength(1);
    const fresh = (await docsA.getCard(admin, paymentId, options)).data.lines
      .flatMap((row) => row.allocations).find((row) => row.allocationId === allocation!.allocationId)!;
    const removed = await docsA.removeAllocation({ currentUser: admin, documentId: paymentId, lineId: paymentLineId,
      allocationId: fresh.allocationId, expectedVersion: fresh.procurementVersion, requestId: `${tag}-orphan-pay-remove` });
    expect(removed.changed).toBe(true);
  });
});
