import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { OnecAlertsPort } from '../../onec-agent/application/onec-alerts-port';
import { OnecCatalogReader } from '../../onec-agent/onec-catalog-reader';
import { OnecRuntimeConfigService } from '../../onec-agent/onec-runtime-config.service';
import { OnecDocumentsEvents } from '../../onec-sync/application/onec-documents-events';
import { OnecDocumentsReader } from '../../onec-sync/application/onec-documents-reader';
import { requestHash } from '../adapters/pg-inventory-repository';
import { ONEC_COMPENSATE_COMMAND } from '../adapters/pg-warehouse-repository';
import { InventoryOnecProjectionService } from './inventory-onec-projection.service';
import { InventoryService } from './inventory.service';
import type { CommandContext } from './inventory.types';
import { NoOnecDocumentsSignal, type ConsumptionDocumentView, type ConsumptionLineView, type OnecConsumptionReader } from './onec-consumption.port';

// Проекция расхода 1С на настоящем PostgreSQL (одноразовая БД film_catalog_it_* со схемой stage + migr 216/217).
// Сценарии логики — на тестовой реализации порта; последний — на настоящих OnecDocumentsReader/OnecDocumentsEvents
// модуля onec-sync поверх таблиц onec_documents* (контракт двух модулей).
const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;

class FakeReader implements OnecConsumptionReader {
  docs = new Map<number, ConsumptionDocumentView>();
  async consumptionCandidates(filter: { sourceIds: readonly number[] }): Promise<ConsumptionDocumentView[]> {
    return [...this.docs.values()].filter((doc) => filter.sourceIds.includes(doc.sourceId)).sort((a, b) => a.documentId - b.documentId);
  }
  async lockDocumentForProjection(documentId: number): Promise<ConsumptionDocumentView | null> {
    return this.docs.get(documentId) ?? null;
  }
}

describe.skipIf(!url)('1C consumption projection — real PostgreSQL', { timeout: 120000 }, () => {
  let database: DatabaseService;
  let watcher: Client;
  let inventory: InventoryService;
  let projection: InventoryOnecProjectionService;
  let admin: CurrentUser;
  let warehouseId: number;
  let sourceA: number;
  let film1: number;
  let film2: number;
  const reader = new FakeReader();
  const alerts = { raise: async () => undefined, resolve: async () => undefined } as unknown as OnecAlertsPort;
  const tag = 'E2E-Тест-расход1С-' + randomUUID().slice(0, 8);
  const W = randomUUID();
  const ITEM1 = randomUUID();
  const ITEM2 = randomUUID();
  const T0 = '2026-09-26T05:14:55.000Z';
  const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
  const ctx = (): CommandContext => ({ currentUser: admin, requestId: `req-${randomUUID()}`, idempotencyKey: randomUUID() });

  const line = (over: Partial<ConsumptionLineView> = {}): ConsumptionLineView => ({
    lineId: Math.floor(Math.random() * 1e9), lineNo: 1, warehouseRefKey: W, nomenclatureRefKey: ITEM1, quantity: '5.000', unitCode: 'lm',
    unitIsPackage: false, isStockItem: true, removedInOnec: false, loadConflictCode: null, ...over,
  });
  const putDoc = (documentId: number, over: Partial<ConsumptionDocumentView> = {}) => {
    const previous = reader.docs.get(documentId);
    reader.docs.set(documentId, {
      documentId, sourceId: sourceA, onecRefKey: previous?.onecRefKey ?? randomUUID(), docKind: 'sales_shipment', number: String(documentId),
      revision: (previous?.revision ?? 0) + 1, posted: true, deletedInOnec: false, missingInSource: false, docDate: '2026-09-26', docAt: at(60),
      warehouseRefKey: W, destinationWarehouseRefKey: null, lines: [line()], ...over,
    });
  };
  const balance = async (filmId: number) => Number((await watcher.query<{ quantity: string }>(
    'SELECT quantity FROM stock_balances WHERE warehouse_id = $1 AND film_id = $2', [warehouseId, filmId])).rows[0]?.quantity ?? 0);
  const onecDocs = async () => Number((await watcher.query<{ n: string }>(
    "SELECT count(*) AS n FROM stock_documents WHERE source = 'onec' AND warehouse_id = $1", [warehouseId])).rows[0].n);
  const inventoryCount = (quantity: number, countedAt = T0, post = true) => inventory.createManual(ctx(), {
    docType: 'inventory', warehouseId, docDate: countedAt.slice(0, 10), orderId: null, comment: tag,
    lines: [{ filmId: film1, quantity }], post, allowNegative: true, countedAt,
  });
  const setSince = async (since: string | null) => {
    const current = (await inventory.listWarehouses(admin, true)).find((row) => row.warehouseId === warehouseId)!;
    return inventory.updateWarehouse(ctx(), { warehouseId, version: current.version, onecConsumptionSince: since });
  };
  const pass = () => projection.runPass('test');
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const addMirrorSource = async (label: string) => {
    const sourceId = Number((await watcher.query<{ source_id: string }>(
      'INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id', [`it-${randomUUID().slice(0, 8)}`, `${tag} ${label}`],
    )).rows[0].source_id);
    await watcher.query(
      `INSERT INTO onec_etl_mirror_rows (source_id, entity_code, source_key, deleted, data, row_hash, first_seen_run, last_run_id)
       VALUES ($1, 'warehouses', $2, false, $3::jsonb, md5($3::text), gen_random_uuid(), gen_random_uuid())`,
      [sourceId, W, JSON.stringify({ Ref_Key: W, Description: `${tag} копия ${label}`, DeletionMark: false, ТипСтруктурнойЕдиницы: 'Склад' })],
    );
    return sourceId;
  };
  let compensationKey = '';
  let compensationResult: unknown;

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    watcher = new Client({ connectionString: url });
    await watcher.connect();
    const adminRole = await watcher.query<{ role_id: number }>('SELECT min(role_id) AS role_id FROM roles');
    const serviceRole = await watcher.query<{ role_id: number }>("SELECT role_id FROM roles WHERE role_code = 'integration_service'");
    const adminId = Number((await watcher.query<{ user_id: string }>(
      `INSERT INTO users (username, email, password_hash, role_id, full_name) VALUES ($1, $2, 'test-hash', $3, $4) RETURNING user_id`,
      [`${tag}-admin`, `${randomUUID()}@example.invalid`, adminRole.rows[0].role_id, `${tag} admin`],
    )).rows[0].user_id);
    const serviceId = Number((await watcher.query<{ user_id: string }>(
      `INSERT INTO users (username, email, password_hash, role_id, full_name, is_service_account) VALUES ($1, $2, 'test-hash', $3, $4, true) RETURNING user_id`,
      [`${tag}-service`, `${randomUUID()}@example.invalid`, serviceRole.rows[0].role_id, `${tag} service`],
    )).rows[0].user_id);
    admin = { id: String(adminId), username: `${tag}-admin`, role: 'admin', roleId: adminRole.rows[0].role_id, permissions: ['inventory.view', 'inventory.manage'] };
    sourceA = Number((await watcher.query<{ source_id: string }>(
      'INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id', [`it-${randomUUID().slice(0, 8)}`, `${tag} A`],
    )).rows[0].source_id);
    await watcher.query("INSERT INTO onec_etl_entity_state (source_id, entity_code) VALUES ($1, 'warehouses')", [sourceA]);
    await watcher.query(
      `INSERT INTO onec_etl_mirror_rows (source_id, entity_code, source_key, deleted, data, row_hash, first_seen_run, last_run_id)
       VALUES ($1, 'warehouses', $2, false, $3::jsonb, md5($3::text), gen_random_uuid(), gen_random_uuid())`,
      [sourceA, W, JSON.stringify({ Ref_Key: W, Description: `${tag} Склад фрезировки`, DeletionMark: false, ТипСтруктурнойЕдиницы: 'Склад' })],
    );
    warehouseId = Number((await watcher.query<{ warehouse_id: number }>(
      'INSERT INTO warehouses (warehouse_name, ref_key_1c) VALUES ($1, $2) RETURNING warehouse_id', [`${tag} Склад фрезеровки`, W],
    )).rows[0].warehouse_id);
    const vendorId = Number((await watcher.query<{ vendor_id: number }>('SELECT min(vendor_id) AS vendor_id FROM vendors')).rows[0].vendor_id);
    const filmTypeId = Number((await watcher.query<{ id: number }>('SELECT min(film_type_id) AS id FROM film_types')).rows[0].id);
    const film = async (name: string, refKey: string | null) => Number((await watcher.query<{ film_id: string }>(
      'INSERT INTO films (film_name, vendor_id, film_type_id, ref_key_1c) VALUES ($1, $2, $3, $4) RETURNING film_id', [name, vendorId, filmTypeId, refKey],
    )).rows[0].film_id);
    film1 = await film(`${tag} Айвори`, ITEM1);
    film2 = await film(`${tag} Магнолия`, null);
    const config = new ConfigService<BackendEnv, true>({
      DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 4, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 20000,
      BACKEND_INVENTORY_ENABLED: true, BACKEND_ENABLE_ONEC_AGENT: true, ONEC_CLIENT_CERT_HEADER: 'x-client-cert',
      BACKEND_INVENTORY_ONEC_CONSUMPTION: true, BACKEND_INVENTORY_ONEC_AUTOSYNC_ACTOR_USER_ID: serviceId,
    });
    database = new DatabaseService(config, { measure: (_t: string, run: () => Promise<unknown>) => run() } as never);
    const catalog = new OnecCatalogReader(database, new OnecRuntimeConfigService(config));
    inventory = new InventoryService(database, config, catalog);
    projection = new InventoryOnecProjectionService(database, config, inventory, catalog, reader, alerts, new NoOnecDocumentsSignal());
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
    await watcher?.end();
  });

  it('gate: an inventory the new backend did not record blocks «since»; a baseline inventory opens it', async () => {
    await inventoryCount(80, at(-600));
    // Инвентаризация «старого backend»: движение есть, поколения нет.
    await watcher.query('DELETE FROM inventory_onec_generation WHERE warehouse_id = $1', [warehouseId]);
    await expect(setSince(T0)).rejects.toMatchObject({ statusCode: 409, code: 'ONEC_BASELINE_REQUIRED' });
    await inventoryCount(100, T0);
    const updated = await setSince(T0);
    expect(updated.onecConsumptionSince).toBe(T0);
    expect(await balance(film1)).toBe(100);
  });

  it('applies a shipment after the cutoff once; a repeat pass writes nothing', async () => {
    putDoc(1);
    const outcome = await pass();
    expect(outcome).toMatchObject({ status: 'done', documents: 1, failed: 0 });
    expect(await balance(film1)).toBe(95);
    const doc = (await watcher.query<{ doc_type: string; status: string; projection_seq: number; onec_document_id: string }>(
      "SELECT doc_type, status, projection_seq, onec_document_id FROM stock_documents WHERE source = 'onec' AND warehouse_id = $1", [warehouseId])).rows;
    expect(doc).toEqual([{ doc_type: 'onec', status: 'posted', projection_seq: 1, onec_document_id: '1' }]);
    const comment = await watcher.query<{ comment: string }>("SELECT comment FROM stock_documents WHERE source = 'onec' AND warehouse_id = $1", [warehouseId]);
    expect(comment.rows[0].comment).toBe('1С: Реализация № 1 от 26.09.2026');
    const audit = await watcher.query("SELECT 1 FROM audit_log WHERE event = 'inventory.onec_consumption_applied' AND metadata_json->>'onecDocumentId' = '1'");
    expect(audit.rows).toHaveLength(1);
    expect(await pass()).toMatchObject({ status: 'done', documents: 0 });
    expect(await onecDocs()).toBe(1);
  });

  it('delta = desired − applied: a revision to 3, unposting, reposting 5', async () => {
    putDoc(1, { lines: [line({ quantity: '3.000' })] });
    await pass();
    expect(await balance(film1)).toBe(97);
    putDoc(1, { posted: false });
    await pass();
    expect(await balance(film1)).toBe(100);
    putDoc(1, { posted: true, lines: [line({ quantity: '5.000' })] });
    await pass();
    expect(await balance(film1)).toBe(95);
    const seqs = (await watcher.query<{ projection_seq: number }>(
      "SELECT projection_seq FROM stock_documents WHERE source = 'onec' AND onec_document_id = 1 ORDER BY projection_seq")).rows.map((row) => row.projection_seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it('a document before the cutoff is not applied; an unlinked film is applied after linking', async () => {
    putDoc(2, { docAt: at(-60) });
    putDoc(3, { docAt: at(120), lines: [line({ nomenclatureRefKey: ITEM2, quantity: '2.000' })] });
    await pass();
    expect(await balance(film1)).toBe(95);
    const issues = await projection.listIssues(admin.permissions, { warehouseId, code: null, includeBeforeCutoff: true, offset: 0, limit: 50 });
    expect(issues.items.map((issue) => [issue.onecDocumentId, issue.code]).sort()).toEqual([[2, 'BEFORE_CUTOFF'], [3, 'FILM_UNLINKED']]);
    await watcher.query('UPDATE films SET ref_key_1c = $2 WHERE film_id = $1', [film2, ITEM2]);
    await pass();
    expect(await balance(film2)).toBe(-2);
    expect((await projection.listIssues(admin.permissions, { warehouseId, code: 'FILM_UNLINKED', includeBeforeCutoff: false, offset: 0, limit: 50 })).total).toBe(0);
  });

  it('a second inventory with the same count moment re-applies consumption after it (95, not 100)', async () => {
    await inventoryCount(100, T0);
    expect(await balance(film1)).toBe(100);
    await pass();
    expect(await balance(film1)).toBe(95);
    expect(await pass()).toMatchObject({ documents: 0 });
  });

  it('an old draft posted after a newer one: the last posting sets the baseline, consumption re-applied', async () => {
    const older = await inventoryCount(100, T0, false);
    const newer = await inventoryCount(100, T0, false);
    await inventory.post(ctx(), newer.documentId, newer.version, true);
    await pass();
    expect(await balance(film1)).toBe(95);
    await inventory.post(ctx(), older.documentId, older.version, true);
    expect(await balance(film1)).toBe(100);
    await pass();
    expect(await balance(film1)).toBe(95);
    expect(await pass()).toMatchObject({ documents: 0 });
  });

  it('a vanished document (kind change) is returned to zero', async () => {
    reader.docs.delete(3);
    await pass();
    expect(await balance(film2)).toBe(0);
    const state = await watcher.query<{ gone: boolean }>('SELECT gone FROM inventory_onec_projection WHERE onec_document_id = 3');
    expect(state.rows[0].gone).toBe(true);
  });

  it('an ambiguous warehouse source freezes the warehouse until resolved', async () => {
    const sourceB = Number((await watcher.query<{ source_id: string }>(
      'INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id', [`it-${randomUUID().slice(0, 8)}`, `${tag} B`],
    )).rows[0].source_id);
    await watcher.query(
      `INSERT INTO onec_etl_mirror_rows (source_id, entity_code, source_key, deleted, data, row_hash, first_seen_run, last_run_id)
       VALUES ($1, 'warehouses', $2, false, $3::jsonb, md5($3::text), gen_random_uuid(), gen_random_uuid())`,
      [sourceB, W, JSON.stringify({ Ref_Key: W, Description: `${tag} копия`, DeletionMark: false, ТипСтруктурнойЕдиницы: 'Склад' })],
    );
    putDoc(1, { lines: [line({ quantity: '7.000' })] });
    await pass();
    expect(await balance(film1)).toBe(95);
    expect((await projection.listIssues(admin.permissions, { warehouseId, code: 'AMBIGUOUS_SOURCE', includeBeforeCutoff: false, offset: 0, limit: 5 })).total).toBeGreaterThan(0);
    await watcher.query('DELETE FROM onec_etl_mirror_rows WHERE source_id = $1', [sourceB]);
    await pass();
    expect(await balance(film1)).toBe(93);
  });

  it('a concurrent inventory posting and pass converge without deadlock', async () => {
    await Promise.all([inventoryCount(100, T0), pass()]);
    await pass();
    expect(await balance(film1)).toBe(93);
  });

  it('a vanished document with applied on a frozen warehouse is returned once the freeze is lifted', async () => {
    putDoc(20, { docAt: at(300), lines: [line({ quantity: '1.000' })] });
    await pass();
    expect(await balance(film1)).toBe(92);
    const sourceC = await addMirrorSource('C');
    reader.docs.delete(20);
    await pass();
    expect(await balance(film1)).toBe(92);
    expect((await watcher.query<{ gone: boolean }>('SELECT gone FROM inventory_onec_projection WHERE onec_document_id = 20')).rows[0].gone).toBe(true);
    await watcher.query('DELETE FROM onec_etl_mirror_rows WHERE source_id = $1', [sourceC]);
    await pass();
    expect(await balance(film1)).toBe(93);
    expect(await pass()).toMatchObject({ documents: 0 });
  });

  it('compensation returns the warehouse consumption to zero and clears «since», with the flag off', async () => {
    const config = new ConfigService<BackendEnv, true>({
      DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 2, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 20000,
      BACKEND_INVENTORY_ENABLED: true, BACKEND_ENABLE_ONEC_AGENT: false, BACKEND_INVENTORY_ONEC_CONSUMPTION: false,
    });
    const off = new InventoryOnecProjectionService(database, config, new InventoryService(database, config, new OnecCatalogReader(database, new OnecRuntimeConfigService(config))),
      new OnecCatalogReader(database, new OnecRuntimeConfigService(config)), reader, alerts, new NoOnecDocumentsSignal());
    expect(await off.runPass('test')).toEqual({ status: 'skipped', reason: 'disabled' });
    compensationKey = randomUUID();
    const result = await off.compensate({ ...ctx(), idempotencyKey: compensationKey }, warehouseId);
    compensationResult = result;
    expect(result.remaining).toBe(0);
    expect(result.documents).toBeGreaterThan(0);
    expect(await balance(film1)).toBe(100);
    const row = await watcher.query<{ onec_consumption_since: Date | null }>('SELECT onec_consumption_since FROM warehouses WHERE warehouse_id = $1', [warehouseId]);
    expect(row.rows[0].onec_consumption_since).toBeNull();
    const last = await watcher.query<{ document_id: string; comment: string }>(
      "SELECT document_id, comment FROM stock_documents WHERE source = 'onec' AND warehouse_id = $1 ORDER BY document_id DESC LIMIT 1", [warehouseId]);
    expect(last.rows[0].comment).toBe('1С: откат расхода склада (компенсация)');
    const audit = await watcher.query<{ source: string | null; actor: string | null }>(
      `SELECT metadata_json->>'commandSource' AS source, user_id::text AS actor FROM audit_log
        WHERE event = 'inventory.onec_consumption_applied' AND entity_id = $1`, [last.rows[0].document_id]);
    expect(audit.rows).toEqual([{ source: 'onec_consumption_compensate', actor: admin.id }]);
    // Повтор с тем же ключом — сохранённый ответ, без новых документов; новый ключ — откатывать нечего.
    const docsAfter = await onecDocs();
    expect(await off.compensate({ ...ctx(), idempotencyKey: compensationKey }, warehouseId)).toEqual(result);
    expect(await onecDocs()).toBe(docsAfter);
    expect((await off.compensate(ctx(), warehouseId)).documents).toBe(0);
    // Фильтр журнала по плёнке находит и документы 1С (строк у них нет — плёнка в движениях).
    const journal = await inventory.listDocuments(admin, { type: null, status: null, from: null, to: null, filmId: film1, orderId: null, offset: 0, limit: 200 });
    const film1Docs = Number((await watcher.query<{ n: string }>(
      `SELECT count(DISTINCT d.document_id) AS n FROM stock_documents d JOIN stock_movements m ON m.document_id = d.document_id
        WHERE d.source = 'onec' AND m.film_id = $1`, [film1])).rows[0].n);
    expect(film1Docs).toBeGreaterThan(0);
    expect(journal.items.filter((item) => item.docType === 'onec').length).toBe(film1Docs);
  });

  it('real onec-sync reader and loader signal: a loaded shipment is applied once; package and unlinked lines are issues', async () => {
    await setSince(T0);
    const config = new ConfigService<BackendEnv, true>({
      DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 2, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 20000,
      BACKEND_INVENTORY_ENABLED: true, BACKEND_ENABLE_ONEC_AGENT: true, ONEC_CLIENT_CERT_HEADER: 'x-client-cert',
      BACKEND_ONEC_DOCUMENTS_LOAD: true,
      BACKEND_INVENTORY_ONEC_CONSUMPTION: true, BACKEND_INVENTORY_ONEC_AUTOSYNC_ACTOR_USER_ID: Number((await watcher.query<{ user_id: string }>(
        'SELECT user_id FROM users WHERE username = $1', [`${tag}-service`])).rows[0].user_id),
    });
    const events = new OnecDocumentsEvents();
    const live = new InventoryOnecProjectionService(database, config, inventory, new OnecCatalogReader(database, new OnecRuntimeConfigService(config)),
      new OnecDocumentsReader(database, config), alerts, events);
    // id документов тестового порта (1..3) не должны совпасть с настоящим документом.
    await watcher.query("SELECT setval(pg_get_serial_sequence('public.onec_documents', 'onec_document_id'), 1000000)");
    // Ключи 1С в верхнем регистре: порт возвращает нижний, сопоставление — без учёта регистра.
    const docId = Number((await watcher.query<{ onec_document_id: string }>(
      `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, doc_at, posted, applied_revision, currency, warehouse_ref_key)
       VALUES ($1, 'sales_shipment', $2, 'РН-77', '2026-09-27', $3, true, 1, 'KZT', $4) RETURNING onec_document_id`,
      [sourceA, randomUUID(), at(240), W.toUpperCase()],
    )).rows[0].onec_document_id);
    const lineSql = `INSERT INTO onec_document_lines (onec_document_id, line_no, nomenclature_ref_key, quantity, unit_code, unit_is_package, warehouse_ref_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`;
    await watcher.query(lineSql, [docId, 1, ITEM1.toUpperCase(), '2.500', 'lm', false, W.toUpperCase()]);
    await watcher.query(lineSql, [docId, 2, ITEM1, '1.000', 'lm', true, W]);
    await watcher.query(lineSql, [docId, 3, randomUUID(), '4.000', 'lm', false, W]);
    // МДФ упаковкой и фрезеровка в м² без плёнки ERP — не плёнка: ни движения, ни issue.
    await watcher.query(lineSql, [docId, 4, randomUUID(), '1.000', null, true, W]);
    await watcher.query(lineSql, [docId, 5, randomUUID(), '0.870', 'm2', false, W]);
    live.onModuleInit();
    try {
      events.emitDocumentsLoaded({ sourceId: sourceA, entityCode: 'documents', docKinds: ['purchase_receipt'], documentIds: [docId], requestId: 'r', correlationId: 'r' });
      events.emitDocumentsLoaded({ sourceId: sourceA, entityCode: 'documents', docKinds: ['sales_shipment'], documentIds: [docId], requestId: 'r', correlationId: 'r' });
      for (let i = 0; i < 100 && await balance(film1) !== 97.5; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await balance(film1)).toBe(97.5);
      // Дождаться фонового прохода (повторный запуск возвращает идущий) и убедиться, что новый ничего не пишет.
      await live.runPass('test');
      expect(await live.runPass('test')).toMatchObject({ status: 'done', documents: 0, failed: 0 });
    } finally { live.onModuleDestroy(); }
    const issues = await live.listIssues(admin.permissions, { warehouseId, code: null, includeBeforeCutoff: false, offset: 0, limit: 50 });
    expect(issues.items.filter((issue) => issue.onecDocumentId === docId).map((issue) => issue.code).sort()).toEqual(['FILM_UNLINKED', 'UNIT_PACKAGE']);
    const doc = await watcher.query<{ comment: string }>("SELECT comment FROM stock_documents WHERE source = 'onec' AND onec_document_id = $1", [docId]);
    expect(doc.rows.map((row) => row.comment)).toEqual(['1С: Реализация № РН-77 от 27.09.2026']);
    // Ключ завершённого отката после нового включения расхода — повтор ответа, а не новый откат.
    expect(await live.compensate({ ...ctx(), idempotencyKey: compensationKey }, warehouseId)).toEqual(compensationResult);
    expect(await balance(film1)).toBe(97.5);
    // Прерванный откат (ключ «в работе») при снова включённом расходе не продолжается.
    const stuck = randomUUID();
    await watcher.query(
      `INSERT INTO command_idempotency_keys (idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status)
       VALUES ($1, $2, $3, 'warehouse', $4, $5, 'processing')`,
      [stuck, ONEC_COMPENSATE_COMMAND, admin.id, String(warehouseId), requestHash({ command: ONEC_COMPENSATE_COMMAND, warehouseId })],
    );
    await expect(live.compensate({ ...ctx(), idempotencyKey: stuck }, warehouseId)).rejects.toMatchObject({ statusCode: 409, code: 'ONEC_COMPENSATION_SUPERSEDED' });
    expect(await balance(film1)).toBe(97.5);
  });

  it('a rollback overtaken by re-enabling consumption stops and leaves the new application alone', async () => {
    const applied = await watcher.query<{ onec_document_id: string }>(
      'SELECT onec_document_id FROM inventory_onec_applied WHERE warehouse_id = $1 AND quantity <> 0 ORDER BY onec_document_id', [warehouseId]);
    expect(applied.rows.length).toBe(1);
    const docId = Number(applied.rows[0].onec_document_id);
    const before = await balance(film1);
    const docsBefore = await onecDocs();
    const blocker = new Client({ connectionString: url });
    await blocker.connect();
    try {
      // Откат A очистит дату, возьмёт список документов и встанет на блокировке состояния документа.
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM inventory_onec_projection WHERE onec_document_id = $1 FOR UPDATE', [docId]);
      const run = projection.compensate({ ...ctx(), idempotencyKey: randomUUID() }, warehouseId);
      let waiting = 0;
      for (let i = 0; i < 200 && waiting === 0; i += 1) {
        waiting = Number((await watcher.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM inventory_onec_projection WHERE onec_document_id%'`)).rows[0].n);
        if (waiting === 0) await sleep(25);
      }
      expect(waiting).toBe(1);
      const cleared = await watcher.query<{ since: Date | null }>('SELECT onec_consumption_since AS since FROM warehouses WHERE warehouse_id = $1', [warehouseId]);
      expect(cleared.rows[0].since).toBeNull();
      // Пока A ждёт, расход по складу снова включают.
      await setSince(T0);
      await blocker.query('COMMIT');
      await expect(run).rejects.toMatchObject({ statusCode: 409, code: 'ONEC_COMPENSATION_SUPERSEDED' });
    } finally { await blocker.end(); }
    expect(await balance(film1)).toBe(before);
    expect(await onecDocs()).toBe(docsBefore);
    const still = await watcher.query<{ quantity: string }>(
      'SELECT quantity FROM inventory_onec_applied WHERE onec_document_id = $1 AND warehouse_id = $2', [docId, warehouseId]);
    expect(Number(still.rows[0].quantity)).toBeLessThan(0);
  });

  it('a pass that read applied before a concurrent inventory posting re-reads it under the balance lock (100, not 105)', async () => {
    const service = (await watcher.query<{ user_id: string; username: string }>('SELECT user_id, username FROM users WHERE username = $1', [`${tag}-service`])).rows[0];
    const actor = { id: Number(service.user_id), username: service.username };
    putDoc(30, { docAt: at(400), lines: [line({ quantity: '5.000' })] });
    expect(await projection.projectDocument(30, actor, 'race-setup')).toBe(1);
    expect(await balance(film1)).toBe(92.5);
    const blocker = new Client({ connectionString: url });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT quantity FROM stock_balances WHERE warehouse_id = $1 AND film_id = $2 FOR UPDATE', [warehouseId, film1]);
      const run = projection.projectDocument(30, actor, 'race');
      // Проход прочитал применённое (−5) и ждёт блокировку остатков.
      let waiting = 0;
      for (let i = 0; i < 200 && waiting === 0; i += 1) {
        waiting = Number((await watcher.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM stock_balances b%'`)).rows[0].n);
        if (waiting === 0) await sleep(25);
      }
      expect(waiting).toBe(1);
      // «Проведение инвентаризации» под той же блокировкой: остаток 100, применённое (w, f) — 0, отсечка — после документа.
      await blocker.query('UPDATE stock_balances SET quantity = 100 WHERE warehouse_id = $1 AND film_id = $2', [warehouseId, film1]);
      await blocker.query('UPDATE inventory_onec_applied SET quantity = 0 WHERE warehouse_id = $1 AND film_id = $2', [warehouseId, film1]);
      await blocker.query('UPDATE inventory_onec_generation SET gen = gen + 1, counted_at = $3 WHERE warehouse_id = $1 AND film_id = $2', [warehouseId, film1, at(500)]);
      await blocker.query('COMMIT');
      expect(await run).toBe(0);
    } finally { await blocker.end(); }
    expect(await balance(film1)).toBe(100);
  });
});
