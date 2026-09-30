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
      Контрагент_Key: CP, ВалютаДенежныхСредств_Key: CUR, СуммаДокумента: amount, ...extra,
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
    for (const entity of ['doc_purchase_receipts', 'doc_cash_outflows', 'units', 'items', 'counterparties']) {
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
    } as Partial<BackendEnv>);
    database = new DatabaseService(config, { measure: (_text: string, run: () => Promise<unknown>) => run() } as never);
    const reader = new OnecCatalogReader(database, new OnecRuntimeConfigService(config));
    const consumers = new OnecDocumentConsumers();
    new OnecDocumentsProcurementConsumer(consumers).onModuleInit();
    loader = new OnecDocumentsLoaderService(database, config, reader, new OnecEtlEvents(), new OnecAlertsPort(new PgOnecRepository(database)), consumers);
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
    await internals.repository.loadDocument({ sourceId: source, entityCode: 'doc_purchase_receipts', config: { docKind: 'purchase_receipt', linesField: 'Запасы', currencyField: 'ВалютаДокумента_Key' },
      requestId: 'req-march', correlationId: 'corr-march', runId: null }, MARCH, refs);
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
});
