import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { OnecCatalogReader } from '../../onec-agent/onec-catalog-reader';
import { OnecRuntimeConfigService } from '../../onec-agent/onec-runtime-config.service';
import { InMemoryOnecStockSnapshots } from '../../onec-agent/onec-stock-snapshots.in-memory';
import { InventoryOnecSnapshotsService, type SnapshotStockFilter } from './inventory-onec-snapshots.service';
import { InventoryService } from './inventory.service';
import { UnavailableOnecStockSnapshots } from './onec-snapshots.port';

// Срезы остатков 1С на дату: настоящие InventoryOnecSnapshotsService + OnecCatalogReader на одноразовой БД
// film_catalog_it_* (схема stage); порт срезов — тестовая реализация владельца (InMemoryOnecStockSnapshots).
const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;

describe.skipIf(!url)('1C stock snapshots — inventory side', { timeout: 90000 }, () => {
  let database: DatabaseService;
  let watcher: Client;
  let reader: OnecCatalogReader;
  let inventory: InventoryService;
  let port: InMemoryOnecStockSnapshots;
  let service: InventoryOnecSnapshotsService;
  let config: ConfigService<BackendEnv, true>;
  let manager: CurrentUser;
  let viewer: CurrentUser;
  let source: number;
  let wh1: number;
  let wh2: number;
  let whMissing: number;
  let whUnlinked: number;
  const tag = 'E2E-Тест-срез-' + randomUUID().slice(0, 8);
  const key = () => randomUUID();
  const k = { wh1: key(), wh2: key(), wh3: key(), whMissing: key(), film: key(), mdf: key(), edge: key(), gone: key(), cat: key(), unitM: key(), unitL: key() };
  const t1 = '2026-09-30T10:00:00.000Z';
  const ZERO = '00000000-0000-0000-0000-000000000000';
  const filter = (over: Partial<SnapshotStockFilter> = {}): SnapshotStockFilter =>
    ({ warehouseIds: [], group: 'all', search: null, nonZero: false, negative: false, categoryKey: null, offset: 0, limit: 500, ...over });
  const ctx = (user: CurrentUser) => ({ currentUser: user, requestId: `req-${randomUUID()}`, idempotencyKey: randomUUID() });
  const row = (warehouse: string | null, item: string, quantity: number) => ({
    organizationRefKey: null, itemRefKey: item.toUpperCase(), characteristicRefKey: null, batchRefKey: null, warehouseRefKey: warehouse, cellRefKey: null, quantity,
  });
  const mirror = (entity: string, sourceKey: string, data: Record<string, unknown>) => watcher.query(
    `INSERT INTO onec_etl_mirror_rows (source_id, entity_code, source_key, deleted, data, row_hash, first_seen_run, last_run_id)
     VALUES ($1, $2, $3, false, $4::jsonb, md5($4::text), gen_random_uuid(), gen_random_uuid())`,
    [source, entity, sourceKey, JSON.stringify(data)],
  );
  const stock = (warehouse: string, item: string, quantity: number) => mirror('stock_balances', key(), {
    Номенклатура_Key: item, СтруктурнаяЕдиница_Key: warehouse, Организация_Key: key(), Характеристика_Key: ZERO, Партия_Key: ZERO, Ячейка_Key: ZERO, КоличествоBalance: quantity,
  });
  const ready = async (moment: string, rows: ReturnType<typeof row>[]) => {
    const view = await service.request(ctx(manager), { momentLocal: moment, force: false });
    port.start(view.id);
    port.complete(view.id, rows);
    return view.id;
  };
  const audits = async (requestId: string) => (await watcher.query<{ event: string; entity_type: string; entity_id: string; action: string; status: string }>(
    `SELECT event, entity_type, entity_id::text, metadata_json->>'action' AS action, status_code AS status FROM audit_log WHERE request_id = $1`, [requestId])).rows;

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    watcher = new Client({ connectionString: url });
    await watcher.connect();
    const role = await watcher.query<{ role_id: number }>('SELECT min(role_id) AS role_id FROM roles');
    const user = async (name: string, permissions: string[]): Promise<CurrentUser> => {
      const id = Number((await watcher.query<{ user_id: string }>(
        `INSERT INTO users (username, email, password_hash, role_id, full_name) VALUES ($1, $2, 'test-hash', $3, $4) RETURNING user_id`,
        [`${tag}-${name}`, `${randomUUID()}@example.invalid`, role.rows[0].role_id, `${tag} ${name}`],
      )).rows[0].user_id);
      return { id: String(id), username: `${tag}-${name}`, role: 'admin', roleId: role.rows[0].role_id, permissions };
    };
    manager = await user('manager', ['inventory.view', 'inventory.manage']);
    viewer = await user('viewer', ['inventory.view']);
    source = Number((await watcher.query<{ source_id: string }>(
      'INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id', [`it-${randomUUID().slice(0, 8)}`, `${tag} A`],
    )).rows[0].source_id);
    for (const entity of ['warehouses', 'items', 'units', 'item_categories']) {
      await watcher.query(`INSERT INTO onec_etl_entity_state (source_id, entity_code, last_completeness) VALUES ($1, $2, 'verified')`, [source, entity]);
    }
    await watcher.query(`INSERT INTO onec_etl_entity_state (source_id, entity_code, snapshot_version, last_completeness) VALUES ($1, 'stock_balances', $2, 'verified')`, [source, t1]);
    for (const [ref, name] of [[k.wh1, 'Склад распила'], [k.wh2, 'Склад фрезеровки'], [k.wh3, 'Склад только 1С']]) {
      await mirror('warehouses', ref, { Ref_Key: ref, Description: `${tag} ${name}`, DeletionMark: false, ТипСтруктурнойЕдиницы: 'Склад' });
    }
    await mirror('item_categories', k.cat, { Ref_Key: k.cat, Description: 'Плёнка ПВХ' });
    await mirror('units', k.unitM, { Ref_Key: k.unitM, Description: 'пог. м' });
    await mirror('units', k.unitL, { Ref_Key: k.unitL, Description: 'л.' });
    const item = (ref: string, name: string, unit: string, category: string | null) =>
      mirror('items', ref, { Ref_Key: ref, Code: name.slice(0, 3), Description: `${tag} ${name}`, ЕдиницаИзмерения_Key: unit, КатегорияНоменклатуры_Key: category ?? ZERO, IsFolder: false });
    await item(k.film, 'Айвори софт', k.unitM, k.cat);
    await item(k.mdf, 'МДФ 16 мм', k.unitL, null);
    await item(k.edge, 'Кромка', k.unitM, null);
    // Текущие остатки 1С: распил — плёнка 10 и МДФ 40; фрезеровка — кромка 5.
    await stock(k.wh1, k.film, 10);
    await stock(k.wh1, k.mdf, 40);
    await stock(k.wh2, k.edge, 5);
    const warehouse = async (name: string, ref: string | null) => Number((await watcher.query<{ warehouse_id: number }>(
      ref === null
        ? 'INSERT INTO warehouses (warehouse_name, ref_key_1c, is_active) VALUES ($1, gen_random_uuid(), false) RETURNING warehouse_id'
        : 'INSERT INTO warehouses (warehouse_name, ref_key_1c) VALUES ($1, $2) RETURNING warehouse_id',
      ref === null ? [`${tag} ${name}`] : [`${tag} ${name}`, ref.toUpperCase()],
    )).rows[0].warehouse_id);
    wh1 = await warehouse('ERP распил', k.wh1);
    wh2 = await warehouse('ERP фрезеровка', k.wh2);
    whMissing = await warehouse('ERP нет в 1С', k.whMissing);
    whUnlinked = await warehouse('ERP выключенный', null);
    const vendorId = Number((await watcher.query<{ id: number }>('SELECT min(vendor_id) AS id FROM vendors')).rows[0].id);
    const filmTypeId = Number((await watcher.query<{ id: number }>('SELECT min(film_type_id) AS id FROM film_types')).rows[0].id);
    await watcher.query('INSERT INTO films (film_name, vendor_id, film_type_id, ref_key_1c) VALUES ($1, $2, $3, $4)', [`${tag} Айвори`, vendorId, filmTypeId, k.film]);

    config = new ConfigService<BackendEnv, true>({
      DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 4, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 20000,
      BACKEND_INVENTORY_ENABLED: true, BACKEND_ENABLE_ONEC_AGENT: true, ONEC_CLIENT_CERT_HEADER: 'x-client-cert',
    });
    database = new DatabaseService(config, { measure: (_t: string, run: () => Promise<unknown>) => run() } as never);
    reader = new OnecCatalogReader(database, new OnecRuntimeConfigService(config));
    inventory = new InventoryService(database, config, reader);
    port = new InMemoryOnecStockSnapshots({ sourceId: source });
    service = new InventoryOnecSnapshotsService(database, config, inventory, reader, port);
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
    await watcher?.end();
  });

  it('commands need inventory.manage: the refusal is audited and the port is not called', async () => {
    const spyRequest = vi.spyOn(port, 'request');
    const spyDelete = vi.spyOn(port, 'delete');
    const denied = ctx(viewer);
    await expect(service.request(denied, { momentLocal: '2026-09-26T10:14:00', force: false })).rejects.toMatchObject({ statusCode: 403 });
    expect(await audits(denied.requestId)).toEqual([
      { event: 'inventory.onec_snapshot_command_denied', entity_type: 'onec_stock_snapshot_request', entity_id: denied.requestId, action: 'request', status: 'denied' },
    ]);
    const deniedDelete = ctx(viewer);
    await expect(service.remove(deniedDelete, 77)).rejects.toMatchObject({ statusCode: 403 });
    expect(await audits(deniedDelete.requestId)).toEqual([
      { event: 'inventory.onec_snapshot_command_denied', entity_type: 'onec_stock_snapshot', entity_id: '77', action: 'delete', status: 'denied' },
    ]);
    expect(spyRequest).not.toHaveBeenCalled();
    expect(spyDelete).not.toHaveBeenCalled();
    // Чтение без inventory.view — отказ без аудита; выключенный склад — 404 для всех маршрутов.
    await expect(service.list({ ...viewer, permissions: [] }, { status: null, offset: 0, limit: 10 })).rejects.toMatchObject({ statusCode: 403 });
    const off = new InventoryOnecSnapshotsService(database, new ConfigService<BackendEnv, true>({ BACKEND_INVENTORY_ENABLED: false }), inventory, reader, port);
    await expect(off.list(manager, { status: null, offset: 0, limit: 10 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(off.request(ctx(manager), { momentLocal: '2026-09-26T10:14:00', force: false })).rejects.toMatchObject({ statusCode: 404 });
    spyRequest.mockRestore();
    spyDelete.mockRestore();
  });

  it('capabilities: no implementation — nothing to read; commands off — the history stays readable', async () => {
    const stub = new InventoryOnecSnapshotsService(database, config, inventory, reader, new UnavailableOnecStockSnapshots());
    expect(await stub.list(viewer, { status: null, offset: 0, limit: 10 })).toEqual({ readAvailable: false, commandsAvailable: false, reason: 'MODULE_DISABLED', items: [], total: 0 });
    await expect(stub.request(ctx(manager), { momentLocal: '2026-09-26T10:14:00', force: false })).rejects.toMatchObject({ statusCode: 409, code: 'ONEC_STOCK_SNAPSHOTS_UNAVAILABLE' });
    const id = await ready('2026-09-20T00:00:00', [row(k.wh1, k.mdf, 1)]);
    // Модуль выключен флагом владельца: история читается, новые запросы — 409, удаление работает.
    port.enabled = false;
    try {
      const listed = await service.list(viewer, { status: 'ready', offset: 0, limit: 10 });
      expect(listed).toMatchObject({ readAvailable: true, commandsAvailable: false, reason: 'MODULE_DISABLED', total: 1 });
      expect(listed.items[0]).toMatchObject({ id, status: 'ready', rowsCount: 1, currentSource: true });
      expect(listed.items[0]).not.toHaveProperty('deletedAt');
      expect((await service.stockOf(viewer, id, filter())).total).toBe(1);
      await expect(service.request(ctx(manager), { momentLocal: '2026-09-21T00:00:00', force: false })).rejects.toMatchObject({ statusCode: 409, code: 'ONEC_STOCK_SNAPSHOTS_UNAVAILABLE' });
      await service.remove(ctx(manager), id);
    } finally { port.enabled = true; }
    await expect(service.card(viewer, id)).rejects.toMatchObject({ statusCode: 404, code: 'ONEC_STOCK_SNAPSHOT_NOT_FOUND' });
  });

  let snapshotA = 0;

  it('card: warehouses of the snapshot matched to ERP warehouses; a queued snapshot has none yet', async () => {
    const queued = await service.request(ctx(manager), { momentLocal: '2026-09-26T10:14:00', force: false });
    expect(queued).toMatchObject({ status: 'requested', queuePosition: 1, momentLocal: '2026-09-26T10:14:00', momentUtc: '2026-09-26T05:14:00.000Z' });
    expect(await service.card(viewer, queued.id)).toMatchObject({ snapshot: { status: 'requested' }, warehouses: [] });
    await expect(service.stockOf(viewer, queued.id, filter())).rejects.toMatchObject({ statusCode: 409, code: 'ONEC_STOCK_SNAPSHOT_NOT_READY' });
    port.start(queued.id);
    port.complete(queued.id, [
      row(k.wh1, k.film, 10), row(k.wh1, k.film, 2.5), row(k.wh1, k.mdf, 40), row(k.wh1, k.gone, 2),
      row(k.wh2, k.edge, 100), row(k.wh3, k.mdf, 7), row(null, k.mdf, 1),
    ]);
    snapshotA = queued.id;
    const card = await service.card(viewer, snapshotA);
    expect(card.snapshot).toMatchObject({ status: 'ready', rowsCount: 7 });
    expect(card.warehouses).toEqual([
      { warehouseRefKey: k.wh1, warehouseId: wh1, name: `${tag} ERP распил`, rows: 4, quantityTotal: 54.5 },
      { warehouseRefKey: k.wh2, warehouseId: wh2, name: `${tag} ERP фрезеровка`, rows: 1, quantityTotal: 100 },
      { warehouseRefKey: null, warehouseId: null, name: null, rows: 1, quantityTotal: 1 },
      { warehouseRefKey: k.wh3, warehouseId: null, name: `${tag} Склад только 1С`, rows: 1, quantityTotal: 7 },
    ]);
  });

  it('stock of the snapshot: all warehouses or the chosen ERP ones; film is a 1C item under «Плёнка»', async () => {
    const all = await service.stockOf(viewer, snapshotA, filter());
    const quantity = (items: typeof all.items, itemKey: string) => items.find((item) => item.itemRefKey === itemKey)?.quantity;
    expect(all.warehouses).toEqual([]);
    expect(quantity(all.items, k.mdf)).toBe(48);
    const one = await service.stockOf(viewer, snapshotA, filter({ warehouseIds: [wh1] }));
    expect(one.warehouses).toEqual([{ warehouseId: wh1, name: `${tag} ERP распил` }]);
    expect(one.tabs.find((tab) => tab.key === 'film')).toMatchObject({ count: 1 });
    expect(one.items.map((item) => [item.group, item.name, item.unitName, item.categoryName, item.quantity])).toEqual([
      ['film', `${tag} Айвори софт`, 'пог. м', 'Плёнка ПВХ', 12.5],
      ['unlinked', k.gone, null, null, 2],
      ['unlinked', `${tag} МДФ 16 мм`, 'л.', null, 40],
    ]);
    expect(one.other).toBeNull();
    expect((await service.stockOf(viewer, snapshotA, filter({ warehouseIds: [wh1, wh2], search: 'кромка' }))).items.map((item) => item.quantity)).toEqual([100]);
    await expect(service.stockOf(viewer, snapshotA, filter({ warehouseIds: [32000] }))).rejects.toMatchObject({ statusCode: 404, code: 'WAREHOUSE_NOT_FOUND' });
  });

  it('compare with the current 1C stock: delta = now − snapshot; unavailable current stock is a refusal, not zeros', async () => {
    const result = await service.compare(viewer, snapshotA, 'current', filter({ warehouseIds: [wh1] }));
    expect(result.other).toEqual({ kind: 'current', asOf: t1 });
    const byKey = new Map(result.items.map((item) => [item.itemRefKey, [item.quantity, item.otherQuantity, item.delta]]));
    expect(byKey.get(k.film)).toEqual([12.5, 10, -2.5]);
    expect(byKey.get(k.mdf)).toEqual([40, 40, 0]);
    expect(byKey.get(k.gone)).toEqual([2, 0, -2]);
    expect((await service.compare(viewer, snapshotA, 'current', filter({ warehouseIds: [wh1], changedOnly: true }))).total).toBe(2);
    // Склад ERP, которого нет в зеркале 1С: и при явном выборе, и без выбора (все активные склады ERP с ключом).
    await expect(service.compare(viewer, snapshotA, 'current', filter({ warehouseIds: [wh1, whMissing] }))).rejects.toMatchObject({
      statusCode: 409, code: 'ONEC_SNAPSHOT_COMPARE_UNAVAILABLE',
      details: { warehouses: [{ warehouseId: whMissing, name: `${tag} ERP нет в 1С`, reason: 'warehouse_not_in_onec' }] },
    });
    await expect(service.compare(viewer, snapshotA, 'current', filter())).rejects.toMatchObject({ code: 'ONEC_SNAPSHOT_COMPARE_UNAVAILABLE' });
    void whUnlinked;
  });

  it('the current side is read from one database snapshot: a mirror refresh between warehouses is not mixed in', async () => {
    const other = new Client({ connectionString: url });
    await other.connect();
    const original = reader.stockBalances.bind(reader);
    let calls = 0;
    const spy = vi.spyOn(reader, 'stockBalances').mockImplementation(async (...args) => {
      const rows = await original(...args);
      calls += 1;
      if (calls === 1) {
        // Между чтением первого и второго склада зеркало «обновилось»: новое время снимка и другое количество кромки.
        await other.query(`UPDATE onec_etl_entity_state SET snapshot_version = '2026-09-30T12:00:00Z' WHERE source_id = $1 AND entity_code = 'stock_balances'`, [source]);
        await other.query(
          `UPDATE onec_etl_mirror_rows SET data = jsonb_set(data, '{КоличествоBalance}', '999') WHERE source_id = $1 AND entity_code = 'stock_balances' AND data->>'СтруктурнаяЕдиница_Key' = $2`,
          [source, k.wh2]);
      }
      return rows;
    });
    try {
      const result = await service.compare(viewer, snapshotA, 'current', filter({ warehouseIds: [wh1, wh2] }));
      expect(calls).toBe(2);
      expect(result.other).toEqual({ kind: 'current', asOf: t1 });
      expect(result.items.find((item) => item.itemRefKey === k.edge)).toMatchObject({ quantity: 100, otherQuantity: 5, delta: -95 });
    } finally {
      spy.mockRestore();
      await other.query(`UPDATE onec_etl_entity_state SET snapshot_version = $2 WHERE source_id = $1 AND entity_code = 'stock_balances'`, [source, t1]);
      await other.query(
        `UPDATE onec_etl_mirror_rows SET data = jsonb_set(data, '{КоличествоBalance}', '5') WHERE source_id = $1 AND entity_code = 'stock_balances' AND data->>'СтруктурнаяЕдиница_Key' = $2`,
        [source, k.wh2]);
      await other.end();
    }
  });

  it('compares two large snapshots: item details are read in portions of the reader limit', async () => {
    // 15 000 + 15 000 непересекающихся позиций: каждая сторона в лимите среза, объединение — больше лимита reader.
    const many = (count: number) => Array.from({ length: count }, () => row(k.wh1, randomUUID(), 1));
    const left = await ready('2026-09-10T00:00:00', [...many(15000), row(k.wh1, k.film, 3)]);
    const right = await ready('2026-09-11T00:00:00', [...many(15000), row(k.wh1, k.film, 5)]);
    const spy = vi.spyOn(reader, 'itemsInfo');
    try {
      const result = await service.compare(viewer, left, right, filter({ warehouseIds: [wh1], group: 'film' }));
      expect(result.tabs.find((tab) => tab.key === 'all')?.count).toBe(30001);
      expect(result.items).toEqual([expect.objectContaining({ itemRefKey: k.film, name: `${tag} Айвори софт`, quantity: 3, otherQuantity: 5, delta: 2 })]);
      expect(spy.mock.calls.map((call) => call[1].length)).toEqual([20000, 10001]);
    } finally { spy.mockRestore(); }
    await service.remove(ctx(manager), left);
    await service.remove(ctx(manager), right);
  });

  it('compare two snapshots of the current base; a historical snapshot is viewable but never compared', async () => {
    const snapshotB = await ready('2026-10-01T00:00:00', [row(k.wh1, k.film, 20), row(k.wh1, k.edge, 3)]);
    const result = await service.compare(viewer, snapshotA, snapshotB, filter({ warehouseIds: [wh1] }));
    expect(result.other).toMatchObject({ kind: 'snapshot', snapshot: { id: snapshotB, momentLocal: '2026-10-01T00:00:00' } });
    const byKey = new Map(result.items.map((item) => [item.itemRefKey, [item.quantity, item.otherQuantity, item.delta]]));
    expect(byKey.get(k.film)).toEqual([12.5, 20, 7.5]);
    expect(byKey.get(k.edge)).toEqual([0, 3, 3]);
    expect(byKey.get(k.mdf)).toEqual([40, 0, -40]);
    await expect(service.compare(viewer, snapshotA, snapshotA, filter())).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.compare(viewer, snapshotA, 999999, filter())).rejects.toMatchObject({ statusCode: 404 });
    // База 1С заменена: оба среза исторические. Просмотр работает, с текущими остатками не сравниваются; между собой —
    // можно: они одной (прежней) базы.
    port.replaceBase();
    expect((await service.card(viewer, snapshotA)).snapshot.currentSource).toBe(false);
    expect((await service.stockOf(viewer, snapshotA, filter({ warehouseIds: [wh1] }))).total).toBe(3);
    await expect(service.compare(viewer, snapshotA, 'current', filter({ warehouseIds: [wh1] }))).rejects.toMatchObject({ statusCode: 409, code: 'ONEC_SNAPSHOT_HISTORICAL' });
    expect((await service.compare(viewer, snapshotA, snapshotB, filter({ warehouseIds: [wh1] }))).items.find((item) => item.itemRefKey === k.film)).toMatchObject({ delta: 7.5 });
    // Срез новой базы с историческим — нет (разные базы), в обе стороны.
    const fresh = await ready('2026-10-02T00:00:00', [row(k.wh1, k.film, 1)]);
    await expect(service.compare(viewer, fresh, snapshotA, filter())).rejects.toMatchObject({ statusCode: 409, code: 'ONEC_SNAPSHOT_SOURCE_MISMATCH' });
    await expect(service.compare(viewer, snapshotA, fresh, filter())).rejects.toMatchObject({ statusCode: 409, code: 'ONEC_SNAPSHOT_SOURCE_MISMATCH' });
    // Кандидаты для сравнения: только срезы той же базы; база фильтруется до пагинации — два исторических среза
    // находят друг друга и после 205 более новых срезов текущей базы.
    for (let i = 0; i < 205; i += 1) await ready(`2026-10-03T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`, []);
    const forOld = await service.comparable(viewer, snapshotA, { search: null, offset: 0, limit: 50 });
    expect(forOld).toMatchObject({ total: 1, items: [{ id: snapshotB, currentSource: false }] });
    expect((await service.comparable(viewer, snapshotB, { search: null, offset: 0, limit: 50 })).items.map((item) => item.id)).toEqual([snapshotA]);
    const forFresh = await service.comparable(viewer, fresh, { search: null, offset: 0, limit: 200 });
    expect(forFresh.total).toBe(205);
    expect(forFresh.items).toHaveLength(200);
    expect(forFresh.items.every((item) => item.currentSource && item.id !== fresh)).toBe(true);
    expect((await service.comparable(viewer, fresh, { search: null, offset: 200, limit: 200 })).items).toHaveLength(5);
    // Поиск — по номеру или по дате, как она показана на экране.
    expect((await service.comparable(viewer, snapshotA, { search: '01.10.2026', offset: 0, limit: 50 })).total).toBe(1);
    expect((await service.comparable(viewer, snapshotA, { search: '02.10.2026', offset: 0, limit: 50 })).total).toBe(0);
    expect((await service.comparable(viewer, fresh, { search: `№ ${fresh + 1} `, offset: 0, limit: 50 })).items.map((item) => item.id)).toEqual([fresh + 1]);
    await expect(service.comparable({ ...viewer, permissions: [] }, snapshotA, { search: null, offset: 0, limit: 50 })).rejects.toMatchObject({ statusCode: 403 });
    expect((await service.compare(viewer, fresh, 'current', filter({ warehouseIds: [wh1] }))).items.find((item) => item.itemRefKey === k.film)).toMatchObject({ quantity: 1, otherQuantity: 10, delta: 9 });
  });
});
