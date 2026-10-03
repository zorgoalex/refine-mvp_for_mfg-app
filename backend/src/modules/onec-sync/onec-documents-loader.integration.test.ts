import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import { PgOnecRepository } from '../onec-agent/adapters/pg-onec-repository';
import { OnecAlertsPort } from '../onec-agent/application/onec-alerts-port';
import { OnecEtlEvents } from '../onec-agent/application/onec-etl-events';
import { OnecCatalogReader } from '../onec-agent/onec-catalog-reader';
import { OnecRuntimeConfigService } from '../onec-agent/onec-runtime-config.service';
import { lineClosedCode, lockDocumentLine, PgOnecDocumentsRepository } from '../orders/adapters/pg-onec-documents-repository';
import { OnecDocumentsProcurementConsumer } from '../orders/application/onec-documents-procurement-consumer';
import { OnecDocumentConsumers } from './application/onec-document-consumers';
import { OnecDocumentsLoaderService, type LoadTrigger } from './application/onec-documents-loader.service';
import { OnecDocumentsEvents, type OnecDocumentsLoaded } from './application/onec-documents-events';
import { OnecDocumentsReader } from './application/onec-documents-reader';
import { OnecCustomerDocumentsReadService } from './application/onec-customer-documents-read.service';
import { DOCUMENT_ENTITIES } from './domain/onec-document-normalizer';

// Загрузчик документов 1С (план 2026-09-30-onec-documents-loader-plan.md): настоящие сервисы, потребитель закупок,
// одноразовая БД film_catalog_it_* (schema-only erp_test + миграция 213). Фикстуры заказов/закупов/распределений и
// материалов вставляются с session_replication_role=replica (без цепочек справочников) — только в этой БД.
const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;

describe.skipIf(!url)('1C documents loader — real PostgreSQL', { timeout: 120000 }, () => {
  let database: DatabaseService;
  let watcher: Client;
  let loader: OnecDocumentsLoaderService;
  let source = 0;
  const tag = 'E2E-Тест-доки-' + randomUUID().slice(0, 8);
  const K = () => randomUUID();
  const CUR = K();
  const UNIT_M2 = K();
  const UNIT_SHEET = K();
  const ITEM_A = K();
  const ITEM_B = K();
  const ITEM_FILM = K();
  const ITEM_AMB = K();
  const CP = K();
  let seq = 0;
  let configRef: ConfigService<BackendEnv, true>;
  let consumersRef: OnecDocumentConsumers;
  const documentEvents = new OnecDocumentsEvents();

  const trigger = (entityCode: string): LoadTrigger => {
    seq += 1;
    return { kind: 'run', sourceId: source, entityCode, runId: randomUUID(), requestId: `req-${seq}`, correlationId: `corr-${seq}` };
  };
  const mirror = async (entity: string, key: string, data: Record<string, unknown>, missing = false) => {
    await watcher.query(
      `INSERT INTO onec_etl_mirror_rows (source_id, entity_code, source_key, deleted, data, row_hash, first_seen_run, last_run_id, missing_in_source_at)
       VALUES ($1, $2, $3, false, $4::jsonb, md5($4::text), gen_random_uuid(), gen_random_uuid(), CASE WHEN $5 THEN now() END)
       ON CONFLICT (source_id, entity_code, source_key)
       DO UPDATE SET data = EXCLUDED.data, row_hash = EXCLUDED.row_hash, missing_in_source_at = EXCLUDED.missing_in_source_at`,
      [source, entity, key, JSON.stringify(data), missing],
    );
  };
  const receipt = (key: string, date: string, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    mirror('doc_purchase_receipts', key, {
      Ref_Key: key, Number: `${tag}-${key.slice(0, 6)}`, Date: `${date}T12:00:00`, Posted: true, DeletionMark: false,
      Контрагент_Key: CP, ВалютаДокумента_Key: CUR, СуммаДокумента: 1000, Комментарий: tag, Запасы: lines, ...extra,
    });
  const rline = (no: number, item: string, qty: number, unit = UNIT_SHEET) =>
    ({ LineNumber: String(no), Номенклатура_Key: item, Количество: qty, ЕдиницаИзмерения: unit, Цена: 10, Всего: qty * 10, ЗаказПокупателя_Key: '00000000-0000-0000-0000-000000000000' });
  const payment = (key: string, amount: number, extra: Record<string, unknown> = {}) =>
    mirror('doc_cash_outflows', key, {
      Ref_Key: key, Number: `${tag}-P${key.slice(0, 5)}`, Date: '2024-02-01T09:00:00', Posted: true, DeletionMark: false,
      ВидОперации: 'Поставщику', Контрагент_Key: CP, ВалютаДенежныхСредств_Key: CUR, СуммаДокумента: amount, ...extra,
    });
  const doc = async (key: string) =>
    (await watcher.query(
      `SELECT onec_document_id::int AS id, posted, deleted_in_onec, amount::text, applied_revision::int AS revision, load_conflict,
              missing_in_source_at IS NOT NULL AS missing, supplier_id
         FROM onec_documents WHERE source_id = $1 AND onec_ref_key = $2::uuid`, [source, key])).rows[0];
  const lines = async (id: number) =>
    (await watcher.query(
      `SELECT onec_document_line_id::int AS id, line_no, quantity::text, amount::text, sheet_material_type_id::int AS smt, film_id::int AS film,
              unit_code, removed_in_onec_at IS NOT NULL AS removed, load_conflict_code, mapping_issue
         FROM onec_document_lines WHERE onec_document_id = $1 ORDER BY line_no`, [id])).rows;
  const events = async (id: number) =>
    (await watcher.query(`SELECT idempotency_key, payload_json FROM outbox_events WHERE aggregate_type = 'onec_document' AND aggregate_id = $1
       ORDER BY split_part(idempotency_key, ':', 3)::int`, [String(id)])).rows;
  const audits = async (id: number) =>
    (await watcher.query(`SELECT event FROM audit_log WHERE entity_type = 'onec_document' AND entity_id = $1 ORDER BY created_at, audit_id`, [String(id)])).rows.map((r) => r.event);
  const replica = async (sql: string, params: unknown[]) => {
    await watcher.query('SET session_replication_role = replica');
    try {
      return await watcher.query(sql, params);
    } finally {
      await watcher.query('SET session_replication_role = origin');
    }
  };
  const allocate = async (lineId: number, role: 'receipt' | 'payment', measure: number) => {
    const orderId = 900000000 + Math.floor(Math.random() * 99999999);
    await replica(`INSERT INTO orders (order_id, order_name, client_id, order_status_id, payment_status_id, created_by, project_id) OVERRIDING SYSTEM VALUE VALUES ($1, $2, 1, 1, 1, 1, 1)`, [orderId, `${tag}-${orderId}`]);
    const procurement = (await replica(
      `INSERT INTO order_resource_procurement (order_id, resource_kind, sheet_material_type_id, purchased, version) VALUES ($1, 'sheet_material', 1, false, 1)
       RETURNING order_resource_procurement_id::int AS id`, [orderId])).rows[0].id;
    return (await replica(
      `INSERT INTO order_resource_onec_allocations (order_resource_procurement_id, onec_document_line_id, role, quantity, unit_code, amount, origin)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual') RETURNING allocation_id::int AS id`,
      [procurement, lineId, role, role === 'receipt' ? measure : null, role === 'receipt' ? 'sheet' : null, role === 'payment' ? measure : null])).rows[0].id;
  };
  const unallocate = (allocationId: number) => watcher.query('UPDATE order_resource_onec_allocations SET removed_at = now() WHERE allocation_id = $1', [allocationId]);

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    watcher = new Client({ connectionString: url });
    await watcher.connect();
    source = Number((await watcher.query('INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id',
      [`it-${randomUUID().slice(0, 8)}`, `${tag} база`])).rows[0].source_id);
    await watcher.query('INSERT INTO onec_agents (agent_id, source_id, site_id, display_name) VALUES ($1, $2, $3, $4)',
      [`it-${randomUUID().slice(0, 12)}`, source, 'it', `${tag} агент`]);
    for (const entity of ['doc_purchase_receipts', 'doc_cash_outflows', 'doc_bank_outflows', 'doc_sales_shipments', 'doc_inventory_writeoffs', 'doc_inventory_transfers',
      'doc_customer_orders', 'doc_cash_receipts', 'doc_bank_receipts', 'units', 'items', 'counterparties', 'users', 'employees', 'order_states', 'order_kinds', 'delivery_services']) {
      await watcher.query('INSERT INTO onec_etl_entity_state (source_id, entity_code) VALUES ($1, $2)', [source, entity]);
    }
    await watcher.query('INSERT INTO onec_currency_map (source_id, currency_ref_key, iso_code) VALUES ($1, $2, $3)', [source, CUR, 'KZT']);
    await mirror('units', UNIT_M2, { Ref_Key: UNIT_M2, Code: '055', Description: 'м2' });
    await mirror('units', UNIT_SHEET, { Ref_Key: UNIT_SHEET, Code: '625', Description: 'л.' });
    for (const [key, name] of [[ITEM_A, 'Плита А'], [ITEM_B, 'Плита Б'], [ITEM_FILM, 'Плёнка'], [ITEM_AMB, 'Двойник']]) await mirror('items', key, { Ref_Key: key, Description: `${tag} ${name}` });
    await mirror('counterparties', CP, { Ref_Key: CP, Description: `${tag} Поставщик` });
    // Листовые материалы: ITEM_A однозначно; ITEM_AMB — у двух материалов.
    for (const [id, key] of [[990001, ITEM_A], [990002, ITEM_AMB], [990003, ITEM_AMB], [990004, ITEM_B]] as const) {
      await replica(`INSERT INTO sheet_material_types (sheet_material_type_id, name, material_type_id, thickness_mm, width_mm, height_mm, unit_id, ref_key_1c)
                     OVERRIDING SYSTEM VALUE VALUES ($1, $2, 1, 16, 2800, 2070, 1, $3::uuid)`, [id, `${tag} ${id}`, key]);
    }
    const config = new ConfigService<BackendEnv, true>({
      DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 3, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 15000,
      BACKEND_ENABLE_ONEC_AGENT: true, ONEC_CLIENT_CERT_HEADER: 'x-client-cert',
      BACKEND_ONEC_DOCUMENTS_LOAD: true, BACKEND_RESOURCE_PROCUREMENT_ENABLED: true,
      BACKEND_ONEC_DOCUMENTS_KINDS: 'purchase_receipt,cash_outflow,bank_outflow,sales_shipment,supplier_return,inventory_writeoff,inventory_transfer',
    } as Partial<BackendEnv>);
    configRef = config;
    database = new DatabaseService(config, { measure: (_text: string, run: () => Promise<unknown>) => run() } as never);
    const reader = new OnecCatalogReader(database, new OnecRuntimeConfigService(config));
    const consumers = new OnecDocumentConsumers();
    consumersRef = consumers;
    new OnecDocumentsProcurementConsumer(consumers).onModuleInit();
    loader = new OnecDocumentsLoaderService(database, config, reader, new OnecEtlEvents(), new OnecAlertsPort(new PgOnecRepository(database)), consumers, documentEvents);
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
    await watcher?.end();
  });

  it('loads receipts and payments; a repeated pass is a no-op without audit or outbox', async () => {
    const R = K();
    const P = K();
    await receipt(R, '2024-03-05', [rline(1, ITEM_A, 10), rline(2, K(), 3, UNIT_M2)]);
    await payment(P, 100);
    expect(await loader.run(trigger('doc_purchase_receipts'))).toMatchObject({ status: 'succeeded', result: { created: 1, failed: 0 } });
    expect(await loader.run(trigger('doc_cash_outflows'))).toMatchObject({ status: 'succeeded', result: { created: 1 } });
    const r = await doc(R);
    expect(r).toMatchObject({ posted: true, deleted_in_onec: false, revision: 1, missing: false });
    expect((await lines(r.id)).map((l) => [l.line_no, l.quantity, l.smt, l.unit_code])).toEqual([[1, '10.000', 990001, 'sheet'], [2, '3.000', null, 'm2']]);
    const p = await doc(P);
    expect((await lines(p.id)).map((l) => [l.quantity, l.amount])).toEqual([['0.000', '100.00']]);
    expect(await audits(r.id)).toEqual(['onec.document.loaded']);
    const again = await loader.run(trigger('doc_purchase_receipts'));
    expect(again).toMatchObject({ status: 'succeeded', result: { created: 0, changed: 0 } });
    expect(await events(r.id)).toHaveLength(1);
    expect(await audits(r.id)).toEqual(['onec.document.loaded']);
  });

  it('posted A → B → A gives three revisions and three outbox events', async () => {
    const R = K();
    await receipt(R, '2024-03-06', [rline(1, ITEM_B, 2)]);
    await loader.run(trigger('doc_purchase_receipts'));
    await receipt(R, '2024-03-06', [rline(1, ITEM_B, 2)], { Posted: false });
    await loader.run(trigger('doc_purchase_receipts'));
    await receipt(R, '2024-03-06', [rline(1, ITEM_B, 2)]);
    await loader.run(trigger('doc_purchase_receipts'));
    const r = await doc(R);
    expect(r.revision).toBe(3);
    const outbox = await events(r.id);
    expect(outbox.map((e) => e.idempotency_key)).toEqual([1, 2, 3].map((rev) => `onec_document:${r.id}:${rev}`));
    expect(outbox[1].payload_json).toMatchObject({ nowUnposted: true, postedChanged: true });
  });

  it('missing from the export is only a flag: deleted_in_onec and allocation rules do not change', async () => {
    const R = K();
    await receipt(R, '2024-03-07', [rline(1, ITEM_B, 2)]);
    await loader.run(trigger('doc_purchase_receipts'));
    await mirror('doc_purchase_receipts', R, (await watcher.query('SELECT data FROM onec_etl_mirror_rows WHERE source_id = $1 AND source_key = $2', [source, R])).rows[0].data, true);
    await loader.run(trigger('doc_purchase_receipts'));
    const r = await doc(R);
    expect(r).toMatchObject({ missing: true, deleted_in_onec: false, posted: true });
    const line = (await lines(r.id))[0];
    expect(lineClosedCode(await lockDocumentLine({ query: (sql: string, params?: unknown[]) => watcher.query(sql, params as unknown[]) } as never, r.id, line.id))).toBeNull();
    expect((await events(r.id)).at(-1)!.payload_json).toMatchObject({ missingInSource: true });
  });

  it('quantity below the allocated keeps the line, blocks new allocations, and applies after the allocation is removed', async () => {
    const R = K();
    await receipt(R, '2024-03-08', [rline(1, ITEM_A, 10)]);
    await loader.run(trigger('doc_purchase_receipts'));
    const r = await doc(R);
    const [line] = await lines(r.id);
    const allocation = await allocate(line.id, 'receipt', 8);
    await receipt(R, '2024-03-08', [rline(1, ITEM_A, 5)]);
    expect(await loader.run(trigger('doc_purchase_receipts'))).toMatchObject({ result: { conflicts: 1 } });
    expect((await lines(r.id))[0]).toMatchObject({ quantity: '10.000', load_conflict_code: 'QUANTITY_BELOW_ALLOCATED' });
    expect((await doc(R)).load_conflict.lines[0]).toMatchObject({ lineNo: 1, code: 'QUANTITY_BELOW_ALLOCATED' });
    const locked = await lockDocumentLine({ query: (sql: string, params?: unknown[]) => watcher.query(sql, params as unknown[]) } as never, r.id, line.id);
    expect(lineClosedCode(locked)?.code).toBe('ONEC_LINE_CONFLICT');
    expect((await watcher.query(`SELECT state FROM onec_alerts WHERE dedupe_key = $1`, [`onec_document_conflict:${r.id}`])).rows[0].state).toBe('open');
    expect(await audits(r.id)).toContain('onec.document.conflict');
    // Повторный проход с тем же конфликтом — без новой ревизии.
    const revision = (await doc(R)).revision;
    await loader.run(trigger('doc_purchase_receipts'));
    expect((await doc(R)).revision).toBe(revision);
    await unallocate(allocation);
    await loader.run(trigger('doc_purchase_receipts'));
    expect((await lines(r.id))[0]).toMatchObject({ quantity: '5.000', load_conflict_code: null });
    expect((await doc(R)).load_conflict).toBeNull();
    expect((await watcher.query(`SELECT state FROM onec_alerts WHERE dedupe_key = $1`, [`onec_document_conflict:${r.id}`])).rows[0].state).toBe('resolved');
  });

  it('a removed line with allocation history stays with a flag; a line without references is deleted', async () => {
    const R = K();
    await receipt(R, '2024-03-09', [rline(1, ITEM_A, 4), rline(2, ITEM_B, 1), rline(3, ITEM_B, 1)]);
    await loader.run(trigger('doc_purchase_receipts'));
    const r = await doc(R);
    const before = await lines(r.id);
    const allocation = await allocate(before[0].id, 'receipt', 2);
    await receipt(R, '2024-03-09', [rline(2, ITEM_B, 1)]);
    await loader.run(trigger('doc_purchase_receipts'));
    let after = await lines(r.id);
    expect(after.map((l) => [l.line_no, l.removed, l.load_conflict_code])).toEqual([[1, true, 'REMOVED_WITH_ALLOCATION'], [2, false, null]]);
    await unallocate(allocation);
    await loader.run(trigger('doc_purchase_receipts'));
    after = await lines(r.id);
    expect(after.map((l) => [l.line_no, l.removed, l.load_conflict_code])).toEqual([[1, true, null], [2, false, null]]);
    const locked = await lockDocumentLine({ query: (sql: string, params?: unknown[]) => watcher.query(sql, params as unknown[]) } as never, r.id, after[0].id);
    expect(lineClosedCode(locked)?.code).toBe('ONEC_LINE_REMOVED_IN_ONEC');
    expect((await watcher.query('SELECT count(*)::int AS n FROM order_resource_onec_allocations WHERE allocation_id = $1', [allocation])).rows[0].n).toBe(1);
    // Список и карточка: удалённая строка не входит в ёмкость; оставшаяся строка распределена полностью → full.
    await allocate(after[1].id, 'receipt', 1);
    const user = { id: '1', username: 'it', role: 'superadmin', roleId: 2, permissions: ['procurement.view', 'orders.view', 'finance.view'] } as never;
    const options = { procurementEnabled: true, canSeeAmounts: true };
    const documents = new PgOnecDocumentsRepository(database);
    const listed = (await documents.list(user, { tab: 'receipts', page: 1, pageSize: 200, search: `${tag}-${R.slice(0, 6)}` }, options))
      .data.find((row) => row.documentId === r.id);
    expect(listed).toMatchObject({ allocationState: 'full' });
    const card = await documents.getCard(user, r.id, options);
    expect(card.data.lines.map((l) => [l.lineNo, l.removedInOnec, l.remaining])).toEqual([[1, true, 0], [2, false, 0]]);
  });

  it('a removed line that returns with a conflict loses the removed flag and keeps the conflict; a repeat adds no event', async () => {
    const R = K();
    await receipt(R, '2024-03-14', [rline(1, ITEM_A, 10), rline(2, ITEM_B, 1)]);
    await loader.run(trigger('doc_purchase_receipts'));
    const r = await doc(R);
    const [line] = await lines(r.id);
    await allocate(line.id, 'receipt', 8);
    await receipt(R, '2024-03-14', [rline(2, ITEM_B, 1)]);
    await loader.run(trigger('doc_purchase_receipts'));
    expect((await lines(r.id))[0]).toMatchObject({ line_no: 1, removed: true, load_conflict_code: 'REMOVED_WITH_ALLOCATION' });
    await receipt(R, '2024-03-14', [rline(1, ITEM_A, 5), rline(2, ITEM_B, 1)]);
    await loader.run(trigger('doc_purchase_receipts'));
    expect((await lines(r.id))[0]).toMatchObject({ line_no: 1, removed: false, quantity: '10.000', load_conflict_code: 'QUANTITY_BELOW_ALLOCATED' });
    const locked = await lockDocumentLine({ query: (sql: string, params?: unknown[]) => watcher.query(sql, params as unknown[]) } as never, r.id, line.id);
    expect(lineClosedCode(locked)?.code).toBe('ONEC_LINE_CONFLICT');
    const count = (await events(r.id)).length;
    await loader.run(trigger('doc_purchase_receipts'));
    expect(await events(r.id)).toHaveLength(count);
  });

  it('a payment amount below the allocated keeps the old amount in the header and the total line', async () => {
    const P = K();
    await payment(P, 100);
    await loader.run(trigger('doc_cash_outflows'));
    const p = await doc(P);
    const [total] = await lines(p.id);
    const allocation = await allocate(total.id, 'payment', 80);
    await payment(P, 50);
    await loader.run(trigger('doc_cash_outflows'));
    expect(await doc(P)).toMatchObject({ amount: '100.00' });
    expect((await doc(P)).load_conflict).toMatchObject({ proposedAmount: '50.00' });
    expect((await lines(p.id))[0]).toMatchObject({ amount: '100.00', load_conflict_code: 'AMOUNT_BELOW_ALLOCATED' });
    // Предложение 1С меняется при сохранённом конфликте — в аудите видно 50 → 40.
    await payment(P, 40);
    await loader.run(trigger('doc_cash_outflows'));
    const conflictAudit = (await watcher.query(
      `SELECT diff_json FROM audit_log WHERE entity_type = 'onec_document' AND entity_id = $1 AND event = 'onec.document.conflict'
        ORDER BY created_at DESC, audit_id DESC LIMIT 1`, [String(p.id)])).rows[0];
    expect(conflictAudit.diff_json.header.loadConflict.from).toMatchObject({ proposedAmount: '50.00' });
    expect(conflictAudit.diff_json.header.loadConflict.to).toMatchObject({ proposedAmount: '40.00' });
    await unallocate(allocation);
    await loader.run(trigger('doc_cash_outflows'));
    expect(await doc(P)).toMatchObject({ amount: '40.00', load_conflict: null });
    expect((await lines(p.id))[0]).toMatchObject({ amount: '40.00', load_conflict_code: null });
  });

  it('an ambiguous 1C key is not mapped and is reported', async () => {
    const R = K();
    await receipt(R, '2024-03-10', [rline(1, ITEM_AMB, 1)]);
    await loader.run(trigger('doc_purchase_receipts'));
    expect((await lines((await doc(R)).id))[0]).toMatchObject({ smt: null, film: null, mapping_issue: 'ambiguous_material' });
  });

  it('delayed mapping: the earliest receipt becomes the first supplier date even when a later one is applied first', async () => {
    const MARCH = K();
    const JAN = K();
    await receipt(MARCH, '2024-03-20', [rline(1, ITEM_FILM, 5)]);
    await receipt(JAN, '2024-01-15', [rline(1, ITEM_FILM, 5)]);
    await loader.run(trigger('doc_purchase_receipts'));
    expect((await lines((await doc(JAN)).id))[0].film).toBeNull();
    const filmId = 990101;
    await replica(`INSERT INTO films (film_id, film_name, film_type_id, vendor_id, ref_key_1c) OVERRIDING SYSTEM VALUE VALUES ($1, $2, 1, 1, $3::uuid)`,
      [filmId, `${tag} плёнка`, ITEM_FILM]);
    // Март сопоставляется раньше января (отдельный вызов), затем полный проход.
    const internals = loader as unknown as { repository: { loadReferences(s: number): Promise<unknown>; loadDocument(ctx: unknown, key: string, refs: unknown): Promise<unknown> } };
    const refs = await internals.repository.loadReferences(source);
    await internals.repository.loadDocument({ sourceId: source, entityCode: 'doc_purchase_receipts', config: DOCUMENT_ENTITIES.doc_purchase_receipts,
      enabledKinds: new Set(['purchase_receipt']), requestId: 'req-march', correlationId: 'corr-march', runId: null }, MARCH, refs);
    await loader.run(trigger('doc_purchase_receipts'));
    const supplier = (await watcher.query(
      `SELECT to_char(first_seen_at, 'YYYY-MM-DD') AS first_seen, first_onec_document_id::int AS doc_id, source
         FROM resource_suppliers WHERE resource_kind = 'film' AND film_id = $1`, [filmId])).rows;
    expect(supplier).toEqual([{ first_seen: '2024-01-15', doc_id: (await doc(JAN)).id, source: 'onec_receipt' }]);
    // Поставщику ERP заполнили ref_key_1c: документ получает supplier_id, ключ реестра остаётся c:<ref> — без второй строки.
    await replica('INSERT INTO suppliers (supplier_id, supplier_name, ref_key_1c) OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3::uuid)', [32001, `${tag} поставщик`, CP]);
    await loader.run(trigger('doc_purchase_receipts'));
    expect((await doc(JAN)).supplier_id).toBe('32001');
    const keys = (await watcher.query(`SELECT supplier_key, to_char(first_seen_at, 'YYYY-MM-DD') AS first_seen FROM resource_suppliers WHERE resource_kind = 'film' AND film_id = $1`, [filmId])).rows;
    expect(keys).toEqual([{ supplier_key: `c:${CP}`, first_seen: '2024-01-15' }]);
  });

  it('a refund to a customer in the payments mirror is never loaded as a supplier payment (plan 2026-10-02 §3.1, step 0)', async () => {
    const REFUND = K();
    await payment(REFUND, 70, { ВидОперации: 'Покупателю' });
    try {
      // Refund kinds are not enabled in this loader: the row is skipped (never a cash_outflow), the pass succeeds.
      expect(await loader.run(trigger('doc_cash_outflows'))).toMatchObject({ status: 'succeeded', result: { created: 0, skipped: 1, invalid: {} } });
      expect(await doc(REFUND)).toBeUndefined();
    } finally {
      await watcher.query('DELETE FROM onec_etl_mirror_rows WHERE source_id = $1 AND entity_code = $2 AND source_key = $3', [source, 'doc_cash_outflows', REFUND]);
    }
    expect(await loader.run(trigger('doc_cash_outflows'))).toMatchObject({ status: 'succeeded', result: { invalid: {} } });
  });

  it('an unmapped currency fails the pass with an alert; mapping it fixes the next pass', async () => {
    const OTHER = K();
    const R = K();
    await receipt(R, '2024-04-01', [rline(1, ITEM_B, 1)], { ВалютаДокумента_Key: OTHER });
    const failed = await loader.run(trigger('doc_purchase_receipts'));
    expect(failed).toMatchObject({ status: 'failed', result: { invalid: { UNKNOWN_CURRENCY: 1 } } });
    const alert = () => watcher.query(`SELECT state FROM onec_alerts WHERE dedupe_key = $1`, [`onec_documents_load_failed:${source}:doc_purchase_receipts`]);
    expect((await alert()).rows[0].state).toBe('open');
    await watcher.query('INSERT INTO onec_currency_map (source_id, currency_ref_key, iso_code) VALUES ($1, $2, $3)', [source, OTHER, 'USD']);
    expect(await loader.run(trigger('doc_purchase_receipts'))).toMatchObject({ status: 'succeeded' });
    expect((await alert()).rows[0].state).toBe('resolved');
    expect((await watcher.query('SELECT currency FROM onec_documents WHERE onec_ref_key = $1::uuid', [R])).rows[0].currency).toBe('USD');
    // Смена соответствия валюты без изменения документа → переприменение и аудит поля валюты.
    await watcher.query('UPDATE onec_currency_map SET iso_code = $3 WHERE source_id = $1 AND currency_ref_key = $2', [source, OTHER, 'EUR']);
    await loader.run(trigger('doc_purchase_receipts'));
    const id = (await doc(R)).id;
    const audit = (await watcher.query(
      `SELECT diff_json FROM audit_log WHERE entity_type = 'onec_document' AND entity_id = $1 AND event = 'onec.document.changed'
        ORDER BY created_at DESC, audit_id DESC LIMIT 1`, [String(id)])).rows[0];
    expect(audit.diff_json.header.currency).toEqual({ from: 'USD', to: 'EUR' });
  });

  it('a command waiting on the line lock sees the header the loader committed (R1-1)', async () => {
    const R = K();
    await receipt(R, '2024-03-11', [rline(1, ITEM_A, 3)]);
    await loader.run(trigger('doc_purchase_receipts'));
    const r = await doc(R);
    const [line] = await lines(r.id);
    const command = new Client({ connectionString: url });
    await command.connect();
    try {
      // «Загрузчик»: блокирует строку и меняет только шапку, не фиксируя.
      await watcher.query('BEGIN');
      await watcher.query('SELECT 1 FROM onec_document_lines WHERE onec_document_line_id = $1 FOR NO KEY UPDATE', [line.id]);
      await watcher.query('UPDATE onec_documents SET posted = false WHERE onec_document_id = $1', [r.id]);
      await command.query('BEGIN');
      const pending = lockDocumentLine({ query: (sql: string, params?: unknown[]) => command.query(sql, params as unknown[]) } as never, r.id, line.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await watcher.query('COMMIT');
      const locked = await pending;
      expect(locked.posted).toBe(false);
      await command.query('ROLLBACK');
    } finally {
      await command.end();
      await watcher.query('UPDATE onec_documents SET posted = true WHERE onec_document_id = $1', [r.id]).catch(() => undefined);
    }
  });

  it('locks lines in numeric id order (99999 before 100000): no deadlock with a command locking the same way', async () => {
    const R = K();
    await receipt(R, '2024-03-12', [rline(1, ITEM_B, 1), rline(2, ITEM_B, 1)]);
    await loader.run(trigger('doc_purchase_receipts'));
    const r = await doc(R);
    const [first, second] = await lines(r.id);
    const low = 99999999;
    const high = 100000000; // в тексте '100000000' < '99999999', численно наоборот
    // id строки — GENERATED ALWAYS: пересоздаём те же строки с нужными id (ссылок на них нет).
    const columns = 'onec_document_id, line_no, nomenclature_ref_key, nomenclature_name, quantity, unit_name, unit_code, price, amount, is_document_total, sheet_material_type_id, film_id, onec_order_ref_key, mapping_issue';
    const saved = (await watcher.query(`SELECT onec_document_line_id::int AS id, ${columns} FROM onec_document_lines WHERE onec_document_id = $1 ORDER BY line_no`, [r.id])).rows;
    await watcher.query('DELETE FROM onec_document_lines WHERE onec_document_id = $1', [r.id]);
    for (const [row, id] of [[saved[0], low], [saved[1], high]] as const) {
      await watcher.query(
        `INSERT INTO onec_document_lines (onec_document_line_id, ${columns}) OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [id, row.onec_document_id, row.line_no, row.nomenclature_ref_key, row.nomenclature_name, row.quantity, row.unit_name, row.unit_code,
          row.price, row.amount, row.is_document_total, row.sheet_material_type_id, row.film_id, row.onec_order_ref_key, row.mapping_issue]);
    }
    expect([first.id, second.id].every((id) => id < low)).toBe(true);
    await receipt(R, '2024-03-12', [rline(1, ITEM_B, 2), rline(2, ITEM_B, 2)]);
    const command = new Client({ connectionString: url });
    await command.connect();
    try {
      await command.query('BEGIN');
      await command.query("SET LOCAL lock_timeout = '5s'");
      await command.query('SELECT 1 FROM onec_document_lines WHERE onec_document_line_id = $1 FOR UPDATE', [low]);
      const pending = loader.run(trigger('doc_purchase_receipts'));
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Загрузчик ждёт low и не держит high — команда берёт high без ожидания.
      await command.query('SELECT 1 FROM onec_document_lines WHERE onec_document_line_id = $1 FOR UPDATE', [high]);
      await command.query('COMMIT');
      expect(await pending).toMatchObject({ status: 'succeeded', result: { failed: 0 } });
    } finally {
      await command.end();
    }
    expect((await lines(r.id)).map((l) => l.quantity)).toEqual(['2.000', '2.000']);
  });

  it('audits line values before/after and lists inserted lines in the outbox event', async () => {
    const R = K();
    await receipt(R, '2024-03-13', [rline(1, ITEM_B, 3)]);
    await loader.run(trigger('doc_purchase_receipts'));
    const r = await doc(R);
    await receipt(R, '2024-03-13', [rline(1, ITEM_B, 4), rline(2, ITEM_A, 1)]);
    await loader.run(trigger('doc_purchase_receipts'));
    const audit = (await watcher.query(
      `SELECT diff_json, before_json, after_json FROM audit_log WHERE entity_type = 'onec_document' AND entity_id = $1 AND event = 'onec.document.changed'`,
      [String(r.id)])).rows[0];
    expect(audit.diff_json.lines).toEqual([
      { lineNo: 1, change: 'updated', fields: expect.objectContaining({ quantity: { from: '3.000', to: '4.000' } }) },
      { lineNo: 2, change: 'inserted', after: expect.objectContaining({ quantity: '1.000', sheetMaterialTypeId: 990001 }) },
    ]);
    expect(audit.before_json.lines).toHaveLength(1);
    expect(audit.after_json.lines).toHaveLength(2);
    const current = await lines(r.id);
    const last = (await events(r.id)).at(-1)!.payload_json;
    expect(last.linesChanged).toEqual(current.map((l) => l.id).sort((a, b) => a - b));
    const count = (await events(r.id)).length;
    await loader.run(trigger('doc_purchase_receipts'));
    expect(await events(r.id)).toHaveLength(count);
  });

  it('does nothing while the loader flag is off', async () => {
    const config = new ConfigService<BackendEnv, true>({ BACKEND_ONEC_DOCUMENTS_LOAD: false, BACKEND_RESOURCE_PROCUREMENT_ENABLED: true, BACKEND_ENABLE_ONEC_AGENT: true } as Partial<BackendEnv>);
    const off = new OnecDocumentsLoaderService(database, config, new OnecCatalogReader(database, new OnecRuntimeConfigService(config)), new OnecEtlEvents(),
      new OnecAlertsPort(new PgOnecRepository(database)), new OnecDocumentConsumers());
    expect(await off.run(trigger('doc_purchase_receipts'))).toEqual({ status: 'skipped', reason: 'disabled' });
  });

  describe('consumption documents (plan 2026-09-30-onec-consumption-documents-plan.md §3)', () => {
    const WH = K();
    const WH2 = K();
    const SERVICE = K();
    const shipment = (key: string, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
      mirror('doc_sales_shipments', key, {
        Ref_Key: key, Number: `${tag}-S${key.slice(0, 5)}`, Date: '2026-06-02T14:36:52', Posted: true, DeletionMark: false,
        ВидОперации: 'ПродажаПокупателю', Контрагент_Key: CP, ВалютаДокумента_Key: CUR, СуммаДокумента: 500, СтруктурнаяЕдиница_Key: WH,
        Запасы: lines, ...extra,
      });
    const sline = (no: number, item: string, qty: number, extra: Record<string, unknown> = {}) => ({
      LineNumber: no, Номенклатура_Key: item, Количество: qty, ЕдиницаИзмерения: UNIT_SHEET,
      ЕдиницаИзмерения_Type: 'StandardODATA.Catalog_КлассификаторЕдиницИзмерения', ТипНоменклатурыЗапас: true, Цена: 5, Всего: qty * 5,
      СтруктурнаяЕдиница_Key: WH, ...extra,
    });
    const header = async (key: string) => (await watcher.query(
      `SELECT onec_document_id::int AS id, doc_kind, currency, operation_kind, lower(warehouse_ref_key::text) AS wh,
              lower(destination_warehouse_ref_key::text) AS dest, to_char(doc_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS doc_at_utc,
              normalizer_version, applied_revision::int AS revision
         FROM onec_documents WHERE source_id = $1 AND onec_ref_key = $2::uuid`, [source, key])).rows;
    const flags = async (id: number) => (await watcher.query(
      `SELECT line_no, lower(warehouse_ref_key::text) AS wh, is_stock_item, unit_is_package FROM onec_document_lines WHERE onec_document_id = $1 ORDER BY line_no`,
      [id])).rows;
    const reader = () => new OnecDocumentsReader(database, configRef);

    it('loads shipments, write-offs and transfers: kind, moment in the source zone, warehouses, stock flag, package unit', async () => {
      const S = K();
      const W = K();
      const T = K();
      await shipment(S, [sline(1, ITEM_A, 4), sline(2, SERVICE, 1, { ТипНоменклатурыЗапас: false, СтруктурнаяЕдиница_Key: WH2 }),
        sline(3, ITEM_B, 2, { ЕдиницаИзмерения_Type: 'UnavailableEntities.UnavailableEntity_8e3bc82d-8e1f-4c4b-80be-7cfff345e705' })]);
      await mirror('doc_inventory_writeoffs', W, { Ref_Key: W, Number: `${tag}-W`, Date: '2026-03-09T12:00:00', Posted: true, DeletionMark: false,
        СтруктурнаяЕдиница_Key: WH, Запасы: [{ LineNumber: 1, Номенклатура_Key: ITEM_A, Количество: 1, ЕдиницаИзмерения: UNIT_SHEET }] });
      await mirror('doc_inventory_transfers', T, { Ref_Key: T, Number: `${tag}-T`, Date: '2026-03-11T14:03:28', Posted: true, DeletionMark: false,
        ВидОперации: 'Перемещение', СтруктурнаяЕдиница_Key: WH, СтруктурнаяЕдиницаПолучатель_Key: WH2,
        Запасы: [{ LineNumber: 1, Номенклатура_Key: ITEM_A, Количество: 3, ЕдиницаИзмерения: UNIT_SHEET }] });
      expect(await loader.run(trigger('doc_sales_shipments'))).toMatchObject({ status: 'succeeded', result: { created: 1, failed: 0 } });
      expect(await loader.run(trigger('doc_inventory_writeoffs'))).toMatchObject({ status: 'succeeded', result: { created: 1 } });
      expect(await loader.run(trigger('doc_inventory_transfers'))).toMatchObject({ status: 'succeeded', result: { created: 1 } });
      const [s] = await header(S);
      // Asia/Almaty = UTC+5: 14:36:52 местного — 09:36:52 UTC.
      expect(s).toMatchObject({ doc_kind: 'sales_shipment', currency: 'KZT', operation_kind: 'ПродажаПокупателю', wh: WH, dest: null,
        doc_at_utc: '2026-06-02T09:36:52', normalizer_version: 'onec-documents-v3', revision: 1 });
      expect(await flags(s.id)).toEqual([
        { line_no: 1, wh: WH, is_stock_item: true, unit_is_package: false },
        { line_no: 2, wh: WH2, is_stock_item: false, unit_is_package: false },
        { line_no: 3, wh: WH, is_stock_item: true, unit_is_package: true },
      ]);
      expect((await header(W))[0]).toMatchObject({ doc_kind: 'inventory_writeoff', currency: null, wh: WH });
      const [t] = await header(T);
      expect(t).toMatchObject({ doc_kind: 'inventory_transfer', currency: null, wh: WH, dest: WH2 });
      expect((await flags(t.id))[0].wh).toBe(WH);
      // Повтор — без изменений; потребитель закупок новые виды не видит (реестр поставщиков не пополняется).
      expect(await loader.run(trigger('doc_sales_shipments'))).toMatchObject({ result: { created: 0, changed: 0, unchanged: 1 } });
      expect((await watcher.query('SELECT count(*)::int AS n FROM resource_suppliers WHERE first_onec_document_id = $1', [s.id])).rows[0].n).toBe(0);
      // Read-порт: кандидаты по складу получателя и документу.
      const candidates = await reader().consumptionCandidates({ sourceIds: [source], warehouseRefKeys: [WH2] });
      expect(candidates.map((c) => c.documentId).sort((a, b) => a - b)).toEqual([s.id, t.id].sort((a, b) => a - b));
      const view = candidates.find((c) => c.documentId === t.id)!;
      expect(view).toMatchObject({ docKind: 'inventory_transfer', revision: 1, docAt: '2026-03-11T09:03:28Z', warehouseRefKey: WH, destinationWarehouseRefKey: WH2,
        posted: true, deletedInOnec: false, missingInSource: false });
      expect(view.lines).toEqual([expect.objectContaining({ lineNo: 1, warehouseRefKey: WH, quantity: '3.000', unitCode: 'sheet', isStockItem: true, unitIsPackage: false })]);
    });

    it('a kind change removes the old-kind document with audit and event; the read port then sees it as gone', async () => {
      const S = K();
      await shipment(S, [sline(1, ITEM_A, 2)]);
      await loader.run(trigger('doc_sales_shipments'));
      const [before] = await header(S);
      await shipment(S, [sline(1, ITEM_A, 2)], { ВидОперации: 'ВозвратПоставщику' });
      await loader.run(trigger('doc_sales_shipments'));
      const after = await header(S);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ doc_kind: 'supplier_return', revision: 1 });
      expect(after[0].id).not.toBe(before.id);
      expect(await audits(before.id)).toEqual(['onec.document.loaded', 'onec.document.removed']);
      expect((await events(before.id)).map((e) => [e.idempotency_key, e.payload_json.removed ?? false])).toEqual([
        [`onec_document:${before.id}:1`, false], [`onec_document:${before.id}:2`, true],
      ]);
      const tx = await database.transaction(async (client) => reader().lockDocumentForProjection(before.id, client));
      expect(tx).toBeNull();
    });

    it('lockDocumentForProjection holds the loader until the caller commits', async () => {
      const S = K();
      await shipment(S, [sline(1, ITEM_A, 2)]);
      await loader.run(trigger('doc_sales_shipments'));
      const [s] = await header(S);
      const projection = new Client({ connectionString: url });
      await projection.connect();
      try {
        await projection.query('BEGIN');
        const view = await reader().lockDocumentForProjection(s.id, projection as never);
        expect(view?.lines[0].quantity).toBe('2.000');
        await shipment(S, [sline(1, ITEM_A, 7)]);
        const pending = loader.run(trigger('doc_sales_shipments'));
        await new Promise((resolve) => setTimeout(resolve, 700));
        expect((await lines(s.id))[0].quantity).toBe('2.000');
        await projection.query('COMMIT');
        expect(await pending).toMatchObject({ status: 'succeeded', result: { changed: 1 } });
      } finally {
        await projection.end();
      }
      expect((await lines(s.id))[0].quantity).toBe('7.000');
    });

    it('v1 → v3: a receipt applied by v1 gets the new fields without a revision, audit or outbox; a second pass is a no-op', async () => {
      const R = K();
      await receipt(R, '2024-04-01', [rline(1, ITEM_A, 2, UNIT_SHEET)], { СтруктурнаяЕдиница_Key: WH });
      await loader.run(trigger('doc_purchase_receipts'));
      const r = await doc(R);
      // Имитация документа, применённого правилами v1: новых полей нет, отпечатки — прежние (другие).
      await watcher.query(`UPDATE onec_documents SET normalizer_version = NULL, operation_kind = NULL, doc_at = NULL, warehouse_ref_key = NULL,
        observed_fingerprint = 'v1-observed', applied_fingerprint = 'v1-applied' WHERE onec_document_id = $1`, [r.id]);
      await watcher.query('UPDATE onec_document_lines SET warehouse_ref_key = NULL WHERE onec_document_id = $1', [r.id]);
      const eventsBefore = (await events(r.id)).length;
      const auditsBefore = (await audits(r.id)).length;
      expect(await loader.run(trigger('doc_purchase_receipts'))).toMatchObject({ status: 'succeeded', result: { upgraded: 1, changed: 0 } });
      const upgraded = (await watcher.query(
        `SELECT applied_revision::int AS revision, normalizer_version, lower(warehouse_ref_key::text) AS wh, doc_at IS NOT NULL AS has_at,
                observed_fingerprint <> 'v1-observed' AS observed_new, applied_fingerprint <> 'v1-applied' AS applied_new
           FROM onec_documents WHERE onec_document_id = $1`, [r.id])).rows[0];
      expect(upgraded).toEqual({ revision: r.revision, normalizer_version: 'onec-documents-v3', wh: WH, has_at: true, observed_new: true, applied_new: true });
      expect((await flags(r.id))[0].wh).toBe(WH);
      expect(await events(r.id)).toHaveLength(eventsBefore);
      // Аудит перехода — одна запись на документ, в его транзакции (code review R1-1).
      expect((await audits(r.id)).slice(auditsBefore)).toEqual(['onec.document.normalizer_upgraded']);
      const upgradeAudit = (await watcher.query(
        `SELECT metadata_json, diff_json FROM audit_log WHERE event = 'onec.document.normalizer_upgraded' AND entity_id = $1`, [String(r.id)])).rows[0];
      expect(upgradeAudit.metadata_json).toMatchObject({ documentId: r.id, revision: r.revision, normalizerVersion: 'onec-documents-v3' });
      expect(upgradeAudit.diff_json).toEqual({ normalizerVersion: { from: null, to: 'onec-documents-v3' } });
      // Повтор — документ не выбирается (оба отпечатка v3): ни транзакции обновления, ни аудита, ни outbox.
      expect(await loader.run(trigger('doc_purchase_receipts'))).toMatchObject({ result: { upgraded: 0, changed: 0 } });
      expect(await events(r.id)).toHaveLength(eventsBefore);
      expect(await audits(r.id)).toHaveLength(auditsBefore + 1);
    });

    it('flag matrix: procurement off loads consumption kinds only; a kind outside the list is skipped', async () => {
      const make = (extra: Partial<BackendEnv>) => {
        const config = new ConfigService<BackendEnv, true>({ BACKEND_ONEC_DOCUMENTS_LOAD: true, BACKEND_ENABLE_ONEC_AGENT: true, ONEC_CLIENT_CERT_HEADER: 'x-client-cert', ...extra } as Partial<BackendEnv>);
        return new OnecDocumentsLoaderService(database, config, new OnecCatalogReader(database, new OnecRuntimeConfigService(config)), new OnecEtlEvents(),
          new OnecAlertsPort(new PgOnecRepository(database)), new OnecDocumentConsumers());
      };
      const all = 'purchase_receipt,cash_outflow,bank_outflow,sales_shipment,supplier_return,inventory_writeoff,inventory_transfer';
      const noProcurement = make({ BACKEND_RESOURCE_PROCUREMENT_ENABLED: false, BACKEND_ONEC_DOCUMENTS_KINDS: all });
      expect(await noProcurement.run(trigger('doc_purchase_receipts'))).toEqual({ status: 'skipped', reason: 'disabled' });
      const S = K();
      await shipment(S, [sline(1, ITEM_A, 1)]);
      expect(await noProcurement.run(trigger('doc_sales_shipments'))).toMatchObject({ status: 'succeeded' });
      expect(await header(S)).toHaveLength(1);
      // По умолчанию (виды закупок) без закупок — загрузчик выключен, как раньше.
      expect(await make({ BACKEND_RESOURCE_PROCUREMENT_ENABLED: false }).run(trigger('doc_sales_shipments'))).toEqual({ status: 'skipped', reason: 'disabled' });
      // Только продажа: возврат поставщику в той же сущности пропускается.
      const onlySales = make({ BACKEND_RESOURCE_PROCUREMENT_ENABLED: false, BACKEND_ONEC_DOCUMENTS_KINDS: 'sales_shipment' });
      const B = K();
      await shipment(B, [sline(1, ITEM_A, 1)], { ВидОперации: 'ВозвратПоставщику' });
      const outcome = await onlySales.run(trigger('doc_sales_shipments'));
      expect(outcome).toMatchObject({ status: 'succeeded' });
      expect(await header(B)).toHaveLength(0);
      // Выключенный вид пропускается до нормализации — и с неизвестной валютой (code review R1-3).
      await shipment(B, [sline(1, ITEM_A, 1)], { ВидОперации: 'ВозвратПоставщику', ВалютаДокумента_Key: K() });
      expect(await onlySales.run(trigger('doc_sales_shipments'))).toMatchObject({ status: 'succeeded', result: { invalid: {} } });
      expect(await header(B)).toHaveLength(0);
      // …и с невалидной строкой (code review R2).
      await shipment(B, [sline(1, ITEM_A, -3)], { ВидОперации: 'ВозвратПоставщику' });
      expect(await onlySales.run(trigger('doc_sales_shipments'))).toMatchObject({ status: 'succeeded', result: { invalid: {} } });
      // Не оставлять в общей копии документ с неизвестной валютой для следующих проходов основного загрузчика.
      await shipment(B, [sline(1, ITEM_A, 1)], { ВидОперации: 'ВозвратПоставщику' });
      // Read-порт выключен вместе с загрузчиком.
      const off = new OnecDocumentsReader(database, new ConfigService<BackendEnv, true>({ BACKEND_ONEC_DOCUMENTS_LOAD: false, BACKEND_ENABLE_ONEC_AGENT: true } as Partial<BackendEnv>));
      await expect(off.consumptionCandidates({ sourceIds: [source] })).rejects.toMatchObject({ code: 'ONEC_DOCUMENTS_UNAVAILABLE' });
    });

    it('an unknown operation kind is not loaded and raises the load alert', async () => {
      const S = K();
      await shipment(S, [sline(1, ITEM_A, 1)], { ВидОперации: 'ПередачаНаКомиссию' });
      const outcome = await loader.run(trigger('doc_sales_shipments'));
      expect(outcome).toMatchObject({ status: 'failed', result: { invalid: { UNKNOWN_OPERATION_KIND: 1 } } });
      expect(await header(S)).toHaveLength(0);
      await shipment(S, [sline(1, ITEM_A, 1)]);
      expect(await loader.run(trigger('doc_sales_shipments'))).toMatchObject({ status: 'succeeded' });
    });

    it('publishes OnecDocumentsLoaded with committed created/changed/removed documents only', async () => {
      const received: OnecDocumentsLoaded[] = [];
      const off = documentEvents.onDocumentsLoaded((event) => { received.push(event); });
      try {
        const A = K();
        const BAD = K();
        await shipment(A, [sline(1, ITEM_A, 1)]);
        await shipment(BAD, [sline(1, ITEM_A, 1)], { ВидОперации: 'ПередачаНаКомиссию' });
        const first = await loader.run(trigger('doc_sales_shipments'));
        expect(first).toMatchObject({ status: 'failed', result: { invalid: { UNKNOWN_OPERATION_KIND: 1 } } });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const [a] = await header(A);
        expect(received.at(-1)).toMatchObject({ sourceId: source, entityCode: 'doc_sales_shipments', docKinds: ['sales_shipment'] });
        expect(received.at(-1)!.documentIds).toContain(a.id);
        expect(await header(BAD)).toHaveLength(0);
        // Смена вида: в сигнале удалённый документ и новый.
        const count = received.length;
        await shipment(BAD, [sline(1, ITEM_A, 1)]);
        await shipment(A, [sline(1, ITEM_A, 1)], { ВидОперации: 'ВозвратПоставщику' });
        await loader.run(trigger('doc_sales_shipments'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        const [aNew] = await header(A);
        expect(received).toHaveLength(count + 1);
        expect(received.at(-1)!.docKinds).toEqual(['sales_shipment', 'supplier_return']);
        expect(received.at(-1)!.documentIds).toEqual(expect.arrayContaining([a.id, aNew.id, (await header(BAD))[0].id]));
        // Повтор без изменений — без сигнала.
        await loader.run(trigger('doc_sales_shipments'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(received).toHaveLength(count + 1);
      } finally {
        off();
      }
    });
  });

  describe('customer documents (plan 2026-10-02-onec-customer-documents-plan.md)', () => {
    const AUTHOR = K();
    const STATE_WORK = K();
    const STATE_DONE = K();
    const customerKinds = 'purchase_receipt,cash_outflow,bank_outflow,sales_shipment,supplier_return,customer_order,cash_receipt,bank_receipt,cash_refund,bank_refund';
    const makeLoader = (kinds: string) => {
      const config = new ConfigService<BackendEnv, true>({ BACKEND_ONEC_DOCUMENTS_LOAD: true, BACKEND_ENABLE_ONEC_AGENT: true, ONEC_CLIENT_CERT_HEADER: 'x-client-cert',
        BACKEND_RESOURCE_PROCUREMENT_ENABLED: true, BACKEND_ONEC_DOCUMENTS_KINDS: kinds } as Partial<BackendEnv>);
      return new OnecDocumentsLoaderService(database, config, new OnecCatalogReader(database, new OnecRuntimeConfigService(config)), new OnecEtlEvents(),
        new OnecAlertsPort(new PgOnecRepository(database)), consumersRef);
    };
    const readService = () => {
      const config = new ConfigService<BackendEnv, true>({ BACKEND_ENABLE_ONEC_AGENT: true, ONEC_CLIENT_CERT_HEADER: 'x-client-cert' } as Partial<BackendEnv>);
      return new OnecCustomerDocumentsReadService(database, new OnecRuntimeConfigService(config));
    };
    const order = (key: string, extra: Record<string, unknown> = {}) => mirror('doc_customer_orders', key, {
      Ref_Key: key, Number: `${tag}-O${key.slice(0, 5)}`, Date: '2026-09-01T10:00:00', Posted: true, DeletionMark: false, ВидОперации: 'ЗаказНаПродажу',
      Контрагент_Key: CP, ВалютаДокумента_Key: CUR, СуммаДокумента: 1000, Автор_Key: AUTHOR, СостояниеЗаказа: STATE_WORK, Оплата: 'НеОплачен',
      СпособДоставки: 'Самовывоз', Запасы: [{ LineNumber: '1', Номенклатура: ITEM_A, Номенклатура_Type: 'StandardODATA.Catalog_Номенклатура', Количество: 2,
        ЕдиницаИзмерения: UNIT_SHEET, Цена: 500, Всего: 1000, ТипНоменклатурыЗапас: true }], Работы: [], ...extra,
    });
    const pay = (entity: string, key: string, operation: string, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
      mirror(entity, key, {
        Ref_Key: key, Number: `${tag}-R${key.slice(0, 5)}`, Date: '2026-09-02T09:00:00', Posted: true, DeletionMark: false, ВидОперации: operation,
        Контрагент_Key: CP, ВалютаДенежныхСредств_Key: CUR, СуммаДокумента: lines.reduce((sum, l) => sum + Number(l.СуммаПлатежа ?? 0), 0) || 100,
        Автор_Key: AUTHOR, РасшифровкаПлатежа: lines, ...extra,
      });
    const payLine = (no: number, orderKey: string | null, amount: number, extra: Record<string, unknown> = {}) => ({
      LineNumber: String(no), Заказ: orderKey ?? '00000000-0000-0000-0000-000000000000',
      Заказ_Type: orderKey ? 'StandardODATA.Document_ЗаказПокупателя' : 'StandardODATA.Undefined', СуммаПлатежа: amount, ПризнакАванса: false, ...extra,
    });
    const ship = (key: string, orderKey: string, amount: number) => mirror('doc_sales_shipments', key, {
      Ref_Key: key, Number: `${tag}-S${key.slice(0, 5)}`, Date: '2026-09-03T12:00:00', Posted: true, DeletionMark: false, ВидОперации: 'ПродажаПокупателю',
      Контрагент_Key: CP, ВалютаДокумента_Key: CUR, СуммаДокумента: amount, Заказ: orderKey, Заказ_Type: 'StandardODATA.Document_ЗаказПокупателя',
      Запасы: [{ LineNumber: 1, Номенклатура_Key: ITEM_A, Количество: 2, ЕдиницаИзмерения: UNIT_SHEET, Цена: amount / 2, Всего: amount,
        ТипНоменклатурыЗапас: true, Заказ: orderKey, Заказ_Type: 'StandardODATA.Document_ЗаказПокупателя' }],
    });
    const byRef = async (key: string) => (await watcher.query(
      `SELECT onec_document_id::int AS id, doc_kind, applied_revision::int AS revision, missing_in_source_at IS NOT NULL AS missing,
              load_conflict->>'kindChangedTo' AS kind_changed_to, author_name, lower(onec_order_ref_key::text) AS order_ref, normalizer_version
         FROM onec_documents WHERE source_id = $1 AND onec_ref_key = $2::uuid ORDER BY onec_document_id`, [source, key])).rows;
    const lineFlags = async (id: number) => (await watcher.query(
      `SELECT line_no, line_section, lower(onec_order_ref_key::text) AS order_ref, removed_in_onec_at IS NOT NULL AS removed, load_conflict_code
         FROM onec_document_lines WHERE onec_document_id = $1 ORDER BY line_no`, [id])).rows;
    const auditRefs = async (documentId: number) => (await watcher.query(
      `SELECT a.event, r.ref_role, lower(r.onec_ref_key::text) AS ref, r.state FROM onec_document_audit_refs r JOIN audit_log a ON a.audit_id = r.audit_id
        WHERE a.entity_type = 'onec_document' AND a.entity_id = $1 ORDER BY a.created_at, r.state, r.ref_role, r.onec_ref_key`, [String(documentId)])).rows;

    beforeAll(async () => {
      await mirror('users', AUTHOR, { Ref_Key: AUTHOR, Description: `${tag} Автор` });
      await mirror('order_states', STATE_WORK, { Ref_Key: STATE_WORK, Description: 'В работе' });
      await mirror('order_states', STATE_DONE, { Ref_Key: STATE_DONE, Description: 'Завершен' });
    });

    it('order, receipt and shipment in reverse order: links resolve at read time; paid = receipts − refunds, shipped from shipment lines', async () => {
      const loader3 = makeLoader(customerKinds);
      const O = K();
      const RCPT = K();
      const S = K();
      const REF = K();
      // Shipment and receipt first, the order last (order outside the window at first).
      await ship(S, O, 1000);
      await pay('doc_bank_receipts', RCPT, 'ОтПокупателя', [payLine(1, O, 600), payLine(2, O, 400, { Документ: S, Документ_Type: 'StandardODATA.Document_РасходнаяНакладная' })]);
      await pay('doc_cash_outflows', REF, 'Покупателю', [payLine(1, O, 100)]);
      expect(await loader3.run(trigger('doc_sales_shipments'))).toMatchObject({ status: 'succeeded' });
      expect(await loader3.run(trigger('doc_bank_receipts'))).toMatchObject({ status: 'succeeded', result: { created: 1 } });
      expect(await loader3.run(trigger('doc_cash_outflows'))).toMatchObject({ status: 'succeeded' });
      const [shipDoc] = await byRef(S);
      expect(shipDoc).toMatchObject({ doc_kind: 'sales_shipment', order_ref: O });
      expect((await lineFlags(shipDoc.id))[0]).toMatchObject({ line_section: 'goods', order_ref: O });
      const [receiptDoc] = await byRef(RCPT);
      expect(receiptDoc).toMatchObject({ doc_kind: 'bank_receipt', author_name: `${tag} Автор` });
      expect((await lineFlags(receiptDoc.id)).map((l) => [l.line_no, l.line_section, l.order_ref])).toEqual([[1, 'payment', O], [2, 'payment', O]]);
      expect((await byRef(REF))[0]).toMatchObject({ doc_kind: 'cash_refund' });
      // Shipment links before the order is loaded: the order is an unresolved 1C reference; the receipt settles it.
      const links = await readService().getDocumentLinks(shipDoc.id);
      expect(links.orders).toEqual([{ refKey: O, type: 'Document_ЗаказПокупателя', documentId: null, docKind: null, number: null, docDate: null }]);
      expect(links.settledBy).toEqual([expect.objectContaining({ documentId: receiptDoc.id, amount: '400.00' })]);
      await order(O);
      expect(await loader3.run(trigger('doc_customer_orders'))).toMatchObject({ status: 'succeeded', result: { created: 1 } });
      const [orderDoc] = await byRef(O);
      const detail = await readService().getOrder(orderDoc.id);
      expect(detail).toMatchObject({ number: `${tag}-O${O.slice(0, 5)}`, stateName: 'В работе', paymentStatus: 'НеОплачен', authorName: `${tag} Автор`,
        paid: '900.00', shipped: '1000.00' });
      expect(detail.lines).toEqual([expect.objectContaining({ lineNo: 1, section: 'goods', amount: '1000.00' })]);
      expect(detail.payments.map((p) => [p.docKind, p.amount])).toEqual([['bank_receipt', '1000.00'], ['cash_refund', '100.00']]);
      expect(detail.payments[0].settlements).toEqual([expect.objectContaining({ refKey: S, documentId: shipDoc.id })]);
      expect(detail.shipments.map((p) => [p.documentId, p.amount])).toEqual([[shipDoc.id, '1000.00']]);
      const list = await readService().listOrders({ search: `${tag}-O${O.slice(0, 5)}` });
      // Period filter; an impossible calendar date is a 400, not a database error (code review R2-1).
      expect((await readService().listOrders({ search: `${tag}-O${O.slice(0, 5)}`, from: '2026-09-01', to: '2026-09-01' })).total).toBe(1);
      expect((await readService().listOrders({ search: `${tag}-O${O.slice(0, 5)}`, from: '2026-09-02' })).total).toBe(0);
      await expect(readService().listOrders({ from: '2026-02-30' })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_FAILED' });
      expect(list.items).toEqual([expect.objectContaining({ documentId: orderDoc.id, paid: '900.00', shipped: '1000.00' })]);
      // A receipt marked for deletion stops counting.
      await pay('doc_bank_receipts', RCPT, 'ОтПокупателя', [payLine(1, O, 600), payLine(2, O, 400)], { DeletionMark: true });
      await loader3.run(trigger('doc_bank_receipts'));
      expect((await readService().getOrder(orderDoc.id)).paid).toBe('-100.00');
      // An order without payments or shipments: zero totals keep the same two-decimal format.
      const EMPTY = K();
      await order(EMPTY);
      expect(await loader3.run(trigger('doc_customer_orders'))).toMatchObject({ status: 'succeeded', result: { created: 1 } });
      const [emptyDoc] = await byRef(EMPTY);
      expect(await readService().getOrder(emptyDoc.id)).toMatchObject({ paid: '0.00', shipped: '0.00' });
      expect((await readService().listOrders({ search: `${tag}-O${EMPTY.slice(0, 5)}` })).items)
        .toEqual([expect.objectContaining({ documentId: emptyDoc.id, paid: '0.00', shipped: '0.00' })]);
      // Totals are not bounded by the per-line numeric(14,2): two receipts above its limit together still read.
      const BIG = K();
      const BIG_R1 = K();
      const BIG_R2 = K();
      await order(BIG);
      await pay('doc_bank_receipts', BIG_R1, 'ОтПокупателя', [payLine(1, BIG, 600000000000)]);
      await pay('doc_bank_receipts', BIG_R2, 'ОтПокупателя', [payLine(1, BIG, 600000000000)]);
      expect(await loader3.run(trigger('doc_customer_orders'))).toMatchObject({ status: 'succeeded' });
      expect(await loader3.run(trigger('doc_bank_receipts'))).toMatchObject({ status: 'succeeded' });
      const [bigDoc] = await byRef(BIG);
      expect(await readService().getOrder(bigDoc.id)).toMatchObject({ paid: '1200000000000.00', shipped: '0.00' });
      expect((await readService().listOrders({ search: `${tag}-O${BIG.slice(0, 5)}` })).items)
        .toEqual([expect.objectContaining({ documentId: bigDoc.id, paid: '1200000000000.00' })]);
    });

    it('v2 → v3: a shipment applied by v2 gets order links and authors without a revision, outbox or consumer events', async () => {
      const loader3 = makeLoader(customerKinds);
      const O = K();
      const S = K();
      await ship(S, O, 300);
      await loader3.run(trigger('doc_sales_shipments'));
      const [s] = await byRef(S);
      await watcher.query(`UPDATE onec_documents SET normalizer_version = 'onec-documents-v2', onec_order_ref_key = NULL, author_ref_key = NULL,
        author_name = NULL, observed_fingerprint = 'v2-observed', applied_fingerprint = 'v2-applied' WHERE onec_document_id = $1`, [s.id]);
      await watcher.query('UPDATE onec_document_lines SET onec_order_ref_key = NULL WHERE onec_document_id = $1', [s.id]);
      const eventsBefore = (await events(s.id)).length;
      expect(await loader3.run(trigger('doc_sales_shipments'))).toMatchObject({ result: { upgraded: 1, changed: 0 } });
      expect((await byRef(S))[0]).toMatchObject({ revision: s.revision, normalizer_version: 'onec-documents-v3', order_ref: O });
      expect((await lineFlags(s.id))[0].order_ref).toBe(O);
      expect(await events(s.id)).toHaveLength(eventsBefore);
      // The upgrade audit records the now-known order link as an "after" reference.
      expect((await auditRefs(s.id)).filter((r) => r.event === 'onec.document.normalizer_upgraded')).toEqual([
        { event: 'onec.document.normalizer_upgraded', ref_role: 'customer_order', ref: O, state: 'after' }]);
      expect(await loader3.run(trigger('doc_sales_shipments'))).toMatchObject({ result: { upgraded: 0, changed: 0 } });
    });

    it('order state transitions: each revision is an outbox event with the order state before/after', async () => {
      const loader3 = makeLoader(customerKinds);
      const O = K();
      await order(O);
      await loader3.run(trigger('doc_customer_orders'));
      await order(O, { СостояниеЗаказа: STATE_DONE });
      await loader3.run(trigger('doc_customer_orders'));
      await order(O, { СостояниеЗаказа: STATE_DONE, Оплата: 'Оплачен' });
      await loader3.run(trigger('doc_customer_orders'));
      const [o] = await byRef(O);
      const states = (await events(o.id)).map((e) => [e.payload_json.action, e.payload_json.orderState?.before?.stateName ?? null,
        e.payload_json.orderState?.after?.stateName, e.payload_json.orderState?.after?.paymentStatus, e.payload_json.actor?.type]);
      expect(states).toEqual([
        ['loaded', null, 'В работе', 'НеОплачен', 'system'],
        ['changed', 'В работе', 'Завершен', 'НеОплачен', 'system'],
        ['changed', 'Завершен', 'Завершен', 'Оплачен', 'system'],
      ]);
      expect(await loader3.run(trigger('doc_customer_orders'))).toMatchObject({ result: { changed: 0 } });
      expect(await events(o.id)).toHaveLength(3);
    });

    it('audit refs: a receipt line moved from order A to B is found under both; a kind change without consumers keeps "before" refs', async () => {
      const loader3 = makeLoader(customerKinds);
      const A = K();
      const B = K();
      const R = K();
      await pay('doc_cash_receipts', R, 'ОтПокупателя', [payLine(1, A, 50)]);
      await loader3.run(trigger('doc_cash_receipts'));
      await pay('doc_cash_receipts', R, 'ОтПокупателя', [payLine(1, B, 50)]);
      await loader3.run(trigger('doc_cash_receipts'));
      const [r] = await byRef(R);
      const refs = await auditRefs(r.id);
      expect(refs).toEqual([
        { event: 'onec.document.loaded', ref_role: 'customer_order', ref: A, state: 'after' },
        { event: 'onec.document.changed', ref_role: 'customer_order', ref: B, state: 'after' },
        { event: 'onec.document.changed', ref_role: 'customer_order', ref: A, state: 'before' },
      ]);
      const byOrder = async (ref: string) => (await watcher.query(
        `SELECT count(DISTINCT audit_id)::int AS n FROM onec_document_audit_refs WHERE source_id = $1 AND onec_ref_key = $2::uuid`, [source, ref])).rows[0].n;
      expect(await byOrder(A)).toBe(2);
      expect(await byOrder(B)).toBe(1);
      // Refund ↔ supplier payment: a refund document has no consumers → removed physically, refs kept as "before".
      const P = K();
      await pay('doc_cash_outflows', P, 'Покупателю', [payLine(1, A, 20)]);
      await loader3.run(trigger('doc_cash_outflows'));
      const [refund] = await byRef(P);
      await pay('doc_cash_outflows', P, 'Поставщику', [payLine(1, A, 20)]);
      await loader3.run(trigger('doc_cash_outflows'));
      expect((await byRef(P)).map((d) => d.doc_kind)).toEqual(['cash_outflow']);
      expect((await auditRefs(refund.id)).filter((x) => x.event === 'onec.document.removed')).toEqual([
        { event: 'onec.document.removed', ref_role: 'customer_order', ref: A, state: 'before' }]);
    });

    it('supplier payment → refund with an active allocation: withdrawn from its kind (lines closed, 422), refund created; reverse restores', async () => {
      const loader3 = makeLoader(customerKinds);
      const P = K();
      const O = K();
      await payment(P, 100);
      await loader3.run(trigger('doc_cash_outflows'));
      const [p] = await byRef(P);
      const [line] = await lines(p.id);
      const allocation = await allocate(line.id, 'payment', 60);
      await pay('doc_cash_outflows', P, 'Покупателю', [payLine(1, O, 100)]);
      const outcome = await loader3.run(trigger('doc_cash_outflows'));
      expect(outcome).toMatchObject({ status: 'succeeded', result: { invalid: {} } });
      const docs = await byRef(P);
      expect(docs.map((d) => [d.doc_kind, d.missing, d.kind_changed_to])).toEqual([['cash_outflow', true, 'cash_refund'], ['cash_refund', false, null]]);
      expect(await lineFlags(p.id)).toEqual([{ line_no: 1, line_section: 'total', order_ref: null, removed: true, load_conflict_code: 'REMOVED_WITH_ALLOCATION' }]);
      const locked = await database.transaction((tx) => lockDocumentLine(tx, p.id, line.id));
      // Closed for new allocations (removed in 1C wins over the conflict code; both are 422 in the allocation command).
      expect(lineClosedCode(locked)).toMatchObject({ code: 'ONEC_LINE_REMOVED_IN_ONEC' });
      expect((await audits(p.id)).at(-1)).toBe('onec.document.changed');
      const lastEvent = (await events(p.id)).at(-1)!.payload_json;
      expect(lastEvent).toMatchObject({ action: 'kind_changed', reason: 'kind_changed', newDocKind: 'cash_refund', missingInSource: true });
      // Repeat: nothing new (the still-conflicted withdrawn document is re-checked but not counted as changed).
      const revision = (await byRef(P))[0].revision;
      expect(await loader3.run(trigger('doc_cash_outflows'))).toMatchObject({ result: { changed: 0 } });
      expect((await byRef(P))[0].revision).toBe(revision);
      // Allocation removed (history stays): the line conflict resolves into "removed" on the next pass.
      await unallocate(allocation);
      await loader3.run(trigger('doc_cash_outflows'));
      expect(await lineFlags(p.id)).toEqual([{ line_no: 1, line_section: 'total', order_ref: null, removed: true, load_conflict_code: null }]);
      // Reverse change: the supplier payment is restored, the refund (no consumers) is removed.
      await payment(P, 100);
      await loader3.run(trigger('doc_cash_outflows'));
      expect((await byRef(P)).map((d) => [d.doc_kind, d.missing, d.kind_changed_to])).toEqual([['cash_outflow', false, null]]);
      expect(await lineFlags(p.id)).toEqual([{ line_no: 1, line_section: 'total', order_ref: null, removed: false, load_conflict_code: null }]);
    });

    it('refund kinds disabled: a referenced supplier payment is still withdrawn, no refund is created; repeated passes add nothing', async () => {
      const procurementOnly = makeLoader('purchase_receipt,cash_outflow,bank_outflow');
      const P = K();
      await payment(P, 80);
      await procurementOnly.run(trigger('doc_cash_outflows'));
      const [p] = await byRef(P);
      const [line] = await lines(p.id);
      await unallocate(await allocate(line.id, 'payment', 10)); // history only
      await pay('doc_cash_outflows', P, 'Покупателю', [payLine(1, null, 80)]);
      expect(await procurementOnly.run(trigger('doc_cash_outflows'))).toMatchObject({ status: 'succeeded', result: { changed: 1 } });
      expect((await byRef(P)).map((d) => [d.doc_kind, d.missing, d.kind_changed_to])).toEqual([['cash_outflow', true, 'cash_refund']]);
      expect(await lineFlags(p.id)).toEqual([{ line_no: 1, line_section: 'total', order_ref: null, removed: true, load_conflict_code: null }]);
      const revision = (await byRef(P))[0].revision;
      expect(await procurementOnly.run(trigger('doc_cash_outflows'))).toMatchObject({ result: { changed: 0 } });
      expect((await byRef(P))[0].revision).toBe(revision);
    });

    it('code review R1-3: an invalid refund (unknown currency) still withdraws the allocated supplier payment; the pass reports invalid', async () => {
      const loader3 = makeLoader(customerKinds);
      const P = K();
      const OTHER = K();
      await payment(P, 90);
      await loader3.run(trigger('doc_cash_outflows'));
      const [p] = await byRef(P);
      const [line] = await lines(p.id);
      const allocation = await allocate(line.id, 'payment', 30);
      await pay('doc_cash_outflows', P, 'Покупателю', [payLine(1, null, 90)], { ВалютаДенежныхСредств_Key: OTHER });
      try {
        expect(await loader3.run(trigger('doc_cash_outflows'))).toMatchObject({ status: 'failed', result: { invalid: { UNKNOWN_CURRENCY: 1 } } });
        expect((await byRef(P)).map((d) => [d.doc_kind, d.missing, d.kind_changed_to])).toEqual([['cash_outflow', true, 'cash_refund']]);
        expect(await lineFlags(p.id)).toEqual([{ line_no: 1, line_section: 'total', order_ref: null, removed: true, load_conflict_code: 'REMOVED_WITH_ALLOCATION' }]);
      } finally {
        await unallocate(allocation);
        await payment(P, 90);
        await loader3.run(trigger('doc_cash_outflows'));
      }
      expect((await byRef(P)).map((d) => [d.doc_kind, d.missing, d.kind_changed_to])).toEqual([['cash_outflow', false, null]]);
    });

    it('code review R1-2: the pre-v3 loader writes a payment total line with the default section; v3 fixes the section technically', async () => {
      const P = K();
      await payment(P, 45);
      await loader.run(trigger('doc_cash_outflows'));
      const p = await doc(P);
      // Pre-v3 INSERT shape (no line_section): accepted by migration 227.
      await watcher.query(`INSERT INTO onec_document_lines (onec_document_id, line_no, quantity, amount, is_document_total)
        VALUES ($1, 2, 0, 1, false)`, [p.id]);
      await watcher.query('DELETE FROM onec_document_lines WHERE onec_document_id = $1 AND line_no = 2', [p.id]);
      await watcher.query(`UPDATE onec_document_lines SET line_section = 'goods' WHERE onec_document_id = $1`, [p.id]);
      await watcher.query(`UPDATE onec_documents SET normalizer_version = 'onec-documents-v2', observed_fingerprint = 'v2-o', applied_fingerprint = 'v2-a'
        WHERE onec_document_id = $1`, [p.id]);
      expect(await loader.run(trigger('doc_cash_outflows'))).toMatchObject({ result: { upgraded: 1, changed: 0 } });
      expect((await lineFlags(p.id))[0].line_section).toBe('total');
    });

    it('code review R1-4/R1-5: order history by its own key; other-currency payments are reported separately', async () => {
      const loader3 = makeLoader(customerKinds);
      const USD = K();
      await watcher.query('INSERT INTO onec_currency_map (source_id, currency_ref_key, iso_code) VALUES ($1, $2, $3)', [source, USD, 'USD']);
      const O = K();
      const R1 = K();
      const R2 = K();
      await order(O);
      await loader3.run(trigger('doc_customer_orders'));
      await order(O, { СостояниеЗаказа: STATE_DONE });
      await loader3.run(trigger('doc_customer_orders'));
      await pay('doc_cash_receipts', R1, 'ОтПокупателя', [payLine(1, O, 300)]);
      await pay('doc_cash_receipts', R2, 'ОтПокупателя', [payLine(1, O, 25)], { ВалютаДенежныхСредств_Key: USD });
      await loader3.run(trigger('doc_cash_receipts'));
      const history = (await watcher.query(
        `SELECT a.event, a.entity_id FROM onec_document_audit_refs r JOIN audit_log a ON a.audit_id = r.audit_id
          WHERE r.source_id = $1 AND r.onec_ref_key = $2::uuid AND r.state = 'after' ORDER BY a.created_at`, [source, O])).rows;
      const [o] = await byRef(O);
      expect(history.filter((h) => h.entity_id === String(o.id)).map((h) => h.event)).toEqual(['onec.document.loaded', 'onec.document.changed']);
      expect(history.filter((h) => h.entity_id !== String(o.id))).toHaveLength(2);
      const detail = await readService().getOrder(o.id);
      expect(detail).toMatchObject({ paid: '300.00', otherCurrency: [{ currency: 'USD', paid: '25.00', shipped: '0.00' }] });
    });
  });

  describe('currency change with active allocations (CURRENCY_CHANGED, request of the procurement session)', () => {
    // Код ставит настоящий потребитель закупок (OnecDocumentsProcurementConsumer, ф.3б-2), зарегистрированный в beforeAll.
    const CUR_EUR = K();
    beforeAll(async () => {
      await watcher.query('INSERT INTO onec_currency_map (source_id, currency_ref_key, iso_code) VALUES ($1, $2, $3)', [source, CUR_EUR, 'EUR']);
    });
    const header = async (id: number) => (await watcher.query(
      'SELECT currency, amount::text, load_conflict, applied_revision::int AS revision FROM onec_documents WHERE onec_document_id = $1', [id])).rows[0];

    it('keeps currency AND amount, proposes both, marks the unchanged total line; applies after the allocation is removed', async () => {
      const P = K();
      await payment(P, 100);
      await loader.run(trigger('doc_cash_outflows'));
      const p = await doc(P);
      const [total] = await lines(p.id);
      const allocation = await allocate(total.id, 'payment', 60);
      // Валюта и рост суммы: 100 KZT → 200 EUR. Новая сумма в прежней валюте не применяется (code review R1-2).
      await payment(P, 200, { ВалютаДенежныхСредств_Key: CUR_EUR });
      expect(await loader.run(trigger('doc_cash_outflows'))).toMatchObject({ result: { conflicts: 1 } });
      const conflicted = await header(p.id);
      expect(conflicted).toMatchObject({ currency: 'KZT', amount: '100.00' });
      expect(conflicted.load_conflict).toMatchObject({ proposedCurrency: 'EUR', proposedAmount: '200.00',
        lines: [expect.objectContaining({ lineNo: 1, code: 'CURRENCY_CHANGED', codes: ['CURRENCY_CHANGED'] })] });
      expect((await lines(p.id))[0]).toMatchObject({ load_conflict_code: 'CURRENCY_CHANGED', amount: '100.00' });
      expect((await audits(p.id)).at(-1)).toBe('onec.document.conflict');
      // Строка, получившая код без собственных изменений, — в linesChanged события (code review R1-3).
      const eventCount = (await events(p.id)).length;
      expect((await events(p.id)).at(-1)!.payload_json).toMatchObject({ conflict: true, linesChanged: [total.id] });
      // Повтор при том же распределении — без ревизии и события.
      await loader.run(trigger('doc_cash_outflows'));
      expect((await header(p.id)).revision).toBe(conflicted.revision);
      expect(await events(p.id)).toHaveLength(eventCount);
      // Распределение снято — шапка и итог применяются вместе, код снят.
      await unallocate(allocation);
      await loader.run(trigger('doc_cash_outflows'));
      expect(await header(p.id)).toMatchObject({ currency: 'EUR', amount: '200.00', load_conflict: null });
      expect((await lines(p.id))[0]).toMatchObject({ load_conflict_code: null, amount: '200.00' });
    });

    it('currency only (100 KZT → 100 EUR): the unchanged total line gets the code, linesChanged, no repeat event; applies after removal', async () => {
      const P = K();
      await payment(P, 100);
      await loader.run(trigger('doc_cash_outflows'));
      const p = await doc(P);
      const [total] = await lines(p.id);
      const allocation = await allocate(total.id, 'payment', 60);
      await payment(P, 100, { ВалютаДенежныхСредств_Key: CUR_EUR });
      expect(await loader.run(trigger('doc_cash_outflows'))).toMatchObject({ result: { conflicts: 1 } });
      const conflicted = await header(p.id);
      expect(conflicted).toMatchObject({ currency: 'KZT', amount: '100.00' });
      const detail = conflicted.load_conflict.lines[0];
      expect(conflicted.load_conflict).toMatchObject({ proposedCurrency: 'EUR', proposedAmount: '100.00' });
      expect(detail).toMatchObject({ lineNo: 1, lineId: total.id, code: 'CURRENCY_CHANGED', codes: ['CURRENCY_CHANGED'] });
      expect(detail.before).toEqual(detail.after);
      expect((await lines(p.id))[0]).toMatchObject({ load_conflict_code: 'CURRENCY_CHANGED', amount: '100.00' });
      const audit = (await watcher.query(
        `SELECT metadata_json FROM audit_log WHERE entity_type = 'onec_document' AND entity_id = $1 AND event = 'onec.document.conflict'
          ORDER BY created_at DESC, audit_id DESC LIMIT 1`, [String(p.id)])).rows[0];
      expect(audit.metadata_json.linesChanged).toEqual([total.id]);
      expect((await events(p.id)).at(-1)!.payload_json).toMatchObject({ conflict: true, linesChanged: [total.id] });
      const eventCount = (await events(p.id)).length;
      await loader.run(trigger('doc_cash_outflows'));
      expect((await header(p.id)).revision).toBe(conflicted.revision);
      expect(await events(p.id)).toHaveLength(eventCount);
      await unallocate(allocation);
      await loader.run(trigger('doc_cash_outflows'));
      expect(await header(p.id)).toMatchObject({ currency: 'EUR', amount: '100.00', load_conflict: null });
      expect((await lines(p.id))[0].load_conflict_code).toBeNull();
    });

    {
      it('amount below allocated together with a currency change keeps both codes', async () => {
        const P = K();
        await payment(P, 100);
        await loader.run(trigger('doc_cash_outflows'));
        const p = await doc(P);
        const [total] = await lines(p.id);
        const allocation = await allocate(total.id, 'payment', 60);
        await payment(P, 50, { ВалютаДенежныхСредств_Key: CUR_EUR });
        await loader.run(trigger('doc_cash_outflows'));
        const conflicted = await header(p.id);
        expect(conflicted).toMatchObject({ currency: 'KZT', amount: '100.00' });
        expect(conflicted.load_conflict).toMatchObject({ proposedCurrency: 'EUR', proposedAmount: '50.00' });
        expect(conflicted.load_conflict.lines[0].codes.sort()).toEqual(['AMOUNT_BELOW_ALLOCATED', 'CURRENCY_CHANGED']);
        await unallocate(allocation);
        await loader.run(trigger('doc_cash_outflows'));
        expect(await header(p.id)).toMatchObject({ currency: 'EUR', amount: '50.00', load_conflict: null });
      });
    }

    // Регрессия R1-1 загрузчика: блокировки полей — по кодам ВСЕХ потребителей, а не по первому коду строки. Двойник с
    // другим именем (до и после «procurement») ставит AMOUNT_BELOW_ALLOCATED, закупки — только CURRENCY_CHANGED (200 ≥ 60).
    for (const name of ['aa-test-amount', 'zz-test-amount']) {
      it(`codes of all consumers hold the header: ${name} AMOUNT_BELOW_ALLOCATED + procurement CURRENCY_CHANGED`, async () => {
        const unregister = consumersRef.register({
          name,
          docKinds: ['cash_outflow'],
          async guardLineChanges(tx, view) {
            if (!view.previous) return [];
            const { rows } = await tx.query<{ line_no: number }>(
              `SELECT l.line_no FROM onec_document_lines l JOIN order_resource_onec_allocations a ON a.onec_document_line_id = l.onec_document_line_id
                WHERE l.onec_document_id = $1 AND l.is_document_total AND a.removed_at IS NULL LIMIT 1`, [view.documentId]);
            return rows.map((row) => ({ lineNo: row.line_no, code: 'AMOUNT_BELOW_ALLOCATED' as const }));
          },
          async referencedLineIds() { return new Set<number>(); },
          async afterDocumentLoaded() {},
        });
        try {
          const P = K();
          await payment(P, 100);
          await loader.run(trigger('doc_cash_outflows'));
          const p = await doc(P);
          const [total] = await lines(p.id);
          const allocation = await allocate(total.id, 'payment', 60);
          await payment(P, 200, { ВалютаДенежныхСредств_Key: CUR_EUR });
          await loader.run(trigger('doc_cash_outflows'));
          const conflicted = await header(p.id);
          expect(conflicted).toMatchObject({ currency: 'KZT', amount: '100.00' });
          expect(conflicted.load_conflict).toMatchObject({ proposedCurrency: 'EUR', proposedAmount: '200.00' });
          expect([...conflicted.load_conflict.lines[0].codes].sort()).toEqual(['AMOUNT_BELOW_ALLOCATED', 'CURRENCY_CHANGED']);
          await unallocate(allocation);
          await loader.run(trigger('doc_cash_outflows'));
          expect(await header(p.id)).toMatchObject({ currency: 'EUR', amount: '200.00', load_conflict: null });
        } finally {
          unregister();
        }
      });
    }

    it('two payment allocations of one document: the currency is held until the last one is removed (procurement 3b-2 CR2-1)', async () => {
      const P = K();
      await payment(P, 10000);
      await loader.run(trigger('doc_cash_outflows'));
      const p = await doc(P);
      const [total] = await lines(p.id);
      const first = await allocate(total.id, 'payment', 6000);
      const second = await allocate(total.id, 'payment', 4000);
      await payment(P, 10000, { ВалютаДенежныхСредств_Key: CUR_EUR });
      await loader.run(trigger('doc_cash_outflows'));
      expect(await header(p.id)).toMatchObject({ currency: 'KZT', amount: '10000.00' });
      // Сняли одно — второе в прежней валюте, валюта держится.
      await unallocate(first);
      await loader.run(trigger('doc_cash_outflows'));
      expect(await header(p.id)).toMatchObject({ currency: 'KZT', amount: '10000.00' });
      expect((await lines(p.id))[0].load_conflict_code).toBe('CURRENCY_CHANGED');
      await unallocate(second);
      await loader.run(trigger('doc_cash_outflows'));
      expect(await header(p.id)).toMatchObject({ currency: 'EUR', amount: '10000.00', load_conflict: null });
      expect((await lines(p.id))[0].load_conflict_code).toBeNull();
    });

    it('an allocation committed while the loader waits on the line lock still holds the currency', async () => {
      const P = K();
      await payment(P, 500);
      await loader.run(trigger('doc_cash_outflows'));
      const p = await doc(P);
      const [total] = await lines(p.id);
      await payment(P, 500, { ВалютаДенежныхСредств_Key: CUR_EUR });
      // «Команда распределения»: держит строку (как lockDocumentLine) и вставляет распределение, не фиксируя.
      const command = new Client({ connectionString: url });
      await command.connect();
      let allocationId = 0;
      try {
        await command.query('BEGIN');
        await command.query('SELECT 1 FROM onec_document_lines WHERE onec_document_line_id = $1 FOR NO KEY UPDATE', [total.id]);
        const pending = loader.run(trigger('doc_cash_outflows'));
        await new Promise((resolve) => setTimeout(resolve, 300));
        await command.query("SET session_replication_role = replica");
        const orderId = 900000000 + Math.floor(Math.random() * 99999999);
        await command.query(`INSERT INTO orders (order_id, order_name, client_id, order_status_id, payment_status_id, created_by, project_id) OVERRIDING SYSTEM VALUE VALUES ($1, $2, 1, 1, 1, 1, 1)`, [orderId, `${tag}-${orderId}`]);
        const procurement = (await command.query(
          `INSERT INTO order_resource_procurement (order_id, resource_kind, sheet_material_type_id, purchased, version) VALUES ($1, 'sheet_material', 1, false, 1)
           RETURNING order_resource_procurement_id::int AS id`, [orderId])).rows[0].id;
        allocationId = (await command.query(
          `INSERT INTO order_resource_onec_allocations (order_resource_procurement_id, onec_document_line_id, role, amount, origin)
           VALUES ($1, $2, 'payment', 300, 'manual') RETURNING allocation_id::int AS id`, [procurement, total.id])).rows[0].id;
        await command.query("SET session_replication_role = origin");
        await command.query('COMMIT');
        await pending;
      } finally {
        await command.end();
      }
      expect(await header(p.id)).toMatchObject({ currency: 'KZT', amount: '500.00' });
      expect((await lines(p.id))[0].load_conflict_code).toBe('CURRENCY_CHANGED');
      await unallocate(allocationId);
      await loader.run(trigger('doc_cash_outflows'));
      expect(await header(p.id)).toMatchObject({ currency: 'EUR', load_conflict: null });
    });
  });
});
