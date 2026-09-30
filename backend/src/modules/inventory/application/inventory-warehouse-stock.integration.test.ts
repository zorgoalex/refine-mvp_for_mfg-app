import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { OnecCatalogReader, type OnecStockState } from '../../onec-agent/onec-catalog-reader';
import { OnecRuntimeConfigService } from '../../onec-agent/onec-runtime-config.service';
import { InventoryService } from './inventory.service';
import type { WarehouseStockFilter } from './inventory.types';

// «Остатки на складах»: настоящие InventoryService + OnecCatalogReader на одноразовой БД
// film_catalog_it_* (схема stage). Плёнка — учёт ERP, остальное — зеркало 1С одного снимка.
const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;

describe.skipIf(!url)('warehouse stock — ERP film + 1C mirror balances', { timeout: 90000 }, () => {
  let database: DatabaseService;
  let watcher: Client;
  let service: InventoryService;
  let admin: CurrentUser;
  let warehouseId: number;
  let otherWarehouseId: number;
  let emptyWarehouseId: number;
  let sourceA: number;
  let materialTypeId: number;
  let sheetId: number;
  let filmId: number;
  let hook: (() => Promise<void>) | null = null;
  const tag = 'E2E-Тест-остатки-' + randomUUID().slice(0, 8);
  const key = () => randomUUID();
  const k = {
    wh: key(), whOther: key(), whEmpty: key(), catFilm: key(), catRaw: key(), catCons: key(), unitL: key(), unitPcs: key(), unitM: key(),
    mdf: key(), mdfRaw: key(), filmLinked: key(), filmCatalog: key(), filmInvalid: key(), gloves: key(), marked: key(),
  };
  const t1 = '2026-09-30T10:00:00.000Z';
  const t2 = '2026-09-30T11:00:00.000Z';
  const base = (over: Partial<WarehouseStockFilter> = {}): WarehouseStockFilter => ({
    warehouseId, group: 'all', search: null, nonZero: false, negative: false, categoryKey: null, offset: 0, limit: 500, ...over,
  });

  const mirror = async (client: Client, source: number, entity: string, sourceKey: string, data: Record<string, unknown>, opts: { deleted?: boolean; missing?: boolean } = {}) =>
    client.query(
      `INSERT INTO onec_etl_mirror_rows (source_id, entity_code, source_key, deleted, data, row_hash, first_seen_run, last_run_id, missing_in_source_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, md5($5::text), gen_random_uuid(), gen_random_uuid(), CASE WHEN $6 THEN now() END)`,
      [source, entity, sourceKey, opts.deleted ?? false, JSON.stringify(data), opts.missing ?? false],
    );
  const stock = (client: Client, source: number, wh: string, item: string, quantity: number, opts: { deleted?: boolean; missing?: boolean } = {}) =>
    mirror(client, source, 'stock_balances', key(), {
      Номенклатура_Key: item, СтруктурнаяЕдиница_Key: wh, Организация_Key: key(), Характеристика_Key: key(),
      Партия_Key: '00000000-0000-0000-0000-000000000000', Ячейка_Key: '00000000-0000-0000-0000-000000000000', КоличествоBalance: quantity,
    }, opts);
  const newSource = async (client: Client, label: string) => Number((await client.query<{ source_id: string }>(
    'INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id', [`it-${randomUUID().slice(0, 8)}`, `${tag} ${label}`],
  )).rows[0].source_id);
  const state = (client: Client, source: number, entity: string, snapshot: string | null = null) => client.query(
    `INSERT INTO onec_etl_entity_state (source_id, entity_code, snapshot_version, last_completeness) VALUES ($1, $2, $3, 'verified')`,
    [source, entity, snapshot],
  );

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    watcher = new Client({ connectionString: url });
    await watcher.connect();
    const role = await watcher.query<{ role_id: number }>('SELECT min(role_id) AS role_id FROM roles');
    const actorId = Number((await watcher.query<{ user_id: string }>(
      `INSERT INTO users (username, email, password_hash, role_id, full_name) VALUES ($1, $2, 'test-hash', $3, $4) RETURNING user_id`,
      [`${tag}-admin`, `${randomUUID()}@example.invalid`, role.rows[0].role_id, `${tag} admin`],
    )).rows[0].user_id);
    admin = { id: String(actorId), username: `${tag}-admin`, role: 'admin', roleId: role.rows[0].role_id, permissions: ['inventory.view'] };

    sourceA = await newSource(watcher, 'A');
    for (const entity of ['warehouses', 'items', 'units', 'item_categories']) await state(watcher, sourceA, entity);
    await state(watcher, sourceA, 'stock_balances', t1);
    await mirror(watcher, sourceA, 'warehouses', k.wh, { Ref_Key: k.wh, Code: 'НФ-9', Description: `${tag} Склад фрезировки`, DeletionMark: false, ТипСтруктурнойЕдиницы: 'Склад' });
    await mirror(watcher, sourceA, 'warehouses', k.whOther, { Ref_Key: k.whOther, Description: `${tag} Другой`, DeletionMark: false, ТипСтруктурнойЕдиницы: 'Склад' });
    await mirror(watcher, sourceA, 'warehouses', k.whEmpty, { Ref_Key: k.whEmpty, Description: `${tag} Пустой`, DeletionMark: false, ТипСтруктурнойЕдиницы: 'Склад' });
    for (const [cat, name] of [[k.catFilm, 'ПЛЕНКА ПВХ ДЛЯ МДФ'], [k.catRaw, 'Сырье'], [k.catCons, 'Раходные материалы']]) {
      await mirror(watcher, sourceA, 'item_categories', cat, { Ref_Key: cat, Description: name });
    }
    for (const [unit, name] of [[k.unitL, 'л.'], [k.unitPcs, 'шт'], [k.unitM, 'пог. м']]) await mirror(watcher, sourceA, 'units', unit, { Ref_Key: unit, Description: name });
    const item = (ref: string, name: string, cat: string, unit: string, extra: Record<string, unknown> = {}) =>
      mirror(watcher, sourceA, 'items', ref, { Ref_Key: ref, Code: `C-${name.length}`, Description: name, КатегорияНоменклатуры_Key: cat, ЕдиницаИзмерения_Key: unit, ТипНоменклатуры: 'Запас', DeletionMark: false, ...extra });
    await item(k.mdf, `${tag} МДФ 16 мм`, k.catCons, k.unitL);
    await item(k.mdfRaw, `${tag} МДФ 16 мм .`, k.catRaw, k.unitL);
    await item(k.filmLinked, `${tag} Айвори ; Алер`, k.catFilm, k.unitM);
    await item(k.filmCatalog, `${tag} Софт белый ; Kira`, k.catFilm, k.unitM);
    await item(k.filmInvalid, `${tag} Серый камень AIFАлимжан`, k.catFilm, k.unitM);
    await item(k.gloves, `${tag} Перчатки`, k.catCons, k.unitPcs);
    await item(k.marked, `${tag} Помеченная`, k.catCons, k.unitPcs, { DeletionMark: true });
    await stock(watcher, sourceA, k.wh, k.mdf, 100);
    await stock(watcher, sourceA, k.wh, k.mdf, 12.5);
    await stock(watcher, sourceA, k.wh, k.mdfRaw, -255.781);
    await stock(watcher, sourceA, k.wh, k.filmLinked, 30);
    await stock(watcher, sourceA, k.wh, k.filmCatalog, -4);
    await stock(watcher, sourceA, k.wh, k.filmInvalid, 7);
    await stock(watcher, sourceA, k.wh, k.gloves, 468);
    await stock(watcher, sourceA, k.wh, k.marked, 5);
    await stock(watcher, sourceA, k.wh, k.gloves, 1000, { deleted: true });
    await stock(watcher, sourceA, k.wh, k.gloves, 2000, { missing: true });
    await stock(watcher, sourceA, k.wh, '00000000-0000-0000-0000-000000000000', 9);
    await stock(watcher, sourceA, k.whOther, k.gloves, 1);

    // ERP: склад с ключом 1С, плёнка со связью и остатком учёта ERP, листовой материал со связью.
    warehouseId = Number((await watcher.query<{ warehouse_id: number }>(
      'INSERT INTO warehouses (warehouse_name, ref_key_1c) VALUES ($1, $2) RETURNING warehouse_id', [`${tag} Склад фрезеровки`, k.wh.toUpperCase()],
    )).rows[0].warehouse_id);
    otherWarehouseId = Number((await watcher.query<{ warehouse_id: number }>(
      'INSERT INTO warehouses (warehouse_name, ref_key_1c) VALUES ($1, $2) RETURNING warehouse_id', [`${tag} Склад вне 1С`, key()],
    )).rows[0].warehouse_id);
    emptyWarehouseId = Number((await watcher.query<{ warehouse_id: number }>(
      'INSERT INTO warehouses (warehouse_name, ref_key_1c) VALUES ($1, $2) RETURNING warehouse_id', [`${tag} Склад без остатков 1С`, k.whEmpty],
    )).rows[0].warehouse_id);
    const vendorId = Number((await watcher.query<{ vendor_id: number }>('SELECT min(vendor_id) AS vendor_id FROM vendors')).rows[0].vendor_id);
    const filmTypeId = Number((await watcher.query<{ id: number }>('SELECT min(film_type_id) AS id FROM film_types')).rows[0].id);
    filmId = Number((await watcher.query<{ film_id: string }>(
      'INSERT INTO films (film_name, vendor_id, film_type_id, ref_key_1c) VALUES ($1, $2, $3, $4) RETURNING film_id', [`${tag} Айвори; Алер`, vendorId, filmTypeId, k.filmLinked],
    )).rows[0].film_id);
    await watcher.query('INSERT INTO stock_balances (warehouse_id, film_id, quantity) VALUES ($1, $2, 12.5)', [warehouseId, filmId]);
    materialTypeId = Number((await watcher.query<{ material_type_id: number }>(
      'INSERT INTO material_types (material_type_name) VALUES ($1) RETURNING material_type_id', [`${tag} МДФ`],
    )).rows[0].material_type_id);
    const unitId = Number((await watcher.query<{ unit_id: number }>('SELECT min(unit_id) AS unit_id FROM units')).rows[0].unit_id);
    sheetId = Number((await watcher.query<{ id: number }>(
      `INSERT INTO sheet_material_types (name, material_type_id, thickness_mm, width_mm, height_mm, unit_id, ref_key_1c)
       VALUES ($1, $2, 16, 2800, 2070, $3, $4) RETURNING sheet_material_type_id AS id`, [`${tag} МДФ 16мм`, materialTypeId, unitId, k.mdf],
    )).rows[0].id);
    // Пакеты импорта каталога плёнок: принятая строка → «Плёнка 1С без привязки»; invalid — нет;
    // черновик чужой категории со skipped-строкой признака плёнки не даёт (plan review R2-1).
    const batch = async (category: string, rows: Array<[string, string]>) => {
      const id = Number((await watcher.query<{ batch_id: string }>(
        `INSERT INTO catalog_import_batches (reference_kind, status, source_kind, onec_source_id, onec_category_key, created_by, request_id)
         VALUES ('films', 'draft', 'onec_mirror', $1, $2, $3, $4) RETURNING batch_id`, [sourceA, category, actorId, `req-${randomUUID()}`],
      )).rows[0].batch_id);
      let rowNo = 1;
      for (const [itemKey, status] of rows) {
        rowNo += 1;
        await watcher.query(
          `INSERT INTO catalog_import_rows (batch_id, row_no, name_original, name_full, supplier, target_name, catalog_key, row_status, onec_source_key)
           VALUES ($1, $2, 'n', 'n ; s', 's', 'n; s', $3, $4, $5)`, [id, rowNo, `ck-${randomUUID()}`, status, itemKey],
        );
      }
    };
    await batch(k.catFilm, [[k.filmCatalog, 'ok'], [k.filmInvalid, 'invalid']]);
    await batch(k.catRaw, [[k.mdfRaw, 'skipped']]);

    const config = new ConfigService<BackendEnv, true>({
      DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 2, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 10000,
      BACKEND_INVENTORY_ENABLED: true, BACKEND_ENABLE_ONEC_AGENT: true, ONEC_CLIENT_CERT_HEADER: 'x-client-cert',
    });
    const telemetry = { measure: (_text: string, run: () => Promise<unknown>) => run() };
    database = new DatabaseService(config, telemetry as never);
    // Reader с точкой вмешательства между чтением состояния и строк (тест согласованности снимка).
    class HookedReader extends OnecCatalogReader {
      async stockState(sourceId: number, client?: DatabaseClient): Promise<OnecStockState> {
        const result = await super.stockState(sourceId, client);
        if (hook) await hook();
        return result;
      }
    }
    service = new InventoryService(database, config, new HookedReader(database, new OnecRuntimeConfigService(config)));
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
    await watcher?.end();
  });

  it('shows ERP film, typed 1C items by ERP links, sums rows of one item and never counts film twice', async () => {
    const result = await service.warehouseStock(admin, base());
    expect(result.onec).toMatchObject({ available: true, reason: null, onecWarehouseName: `${tag} Склад фрезировки`, snapshotVersion: t1, completeness: 'verified', directoriesRevoked: false });
    expect(result.tabs).toEqual([
      { key: 'all', label: 'Все материалы', count: 1 + 1 + 4 },
      { key: 'film', label: 'Плёнка', count: 1 },
      { key: `material:${materialTypeId}`, label: `${tag} МДФ`, count: 1 },
      { key: 'film_unlinked', label: 'Плёнка 1С без привязки', count: 1 },
      { key: 'unlinked', label: 'Не сопоставлено с ERP', count: 4 },
    ]);
    const byName = new Map(result.items.map((item) => [item.name, item]));
    expect(byName.get(`${tag} Айвори; Алер`)).toMatchObject({ source: 'erp', group: 'film', filmId, quantity: 12.5, unitName: 'пог. м' });
    expect(byName.get(`${tag} МДФ 16 мм`)).toMatchObject({ source: '1c', group: `material:${materialTypeId}`, quantity: 112.5, unitName: 'л.', sheetMaterialTypeId: sheetId, categoryName: 'Раходные материалы' });
    // Связанная с плёнкой ERP позиция 1С скрыта; принятая импортом плёнка — отдельная группа, не во «Все».
    expect(byName.has(`${tag} Айвори ; Алер`)).toBe(false);
    expect(byName.has(`${tag} Софт белый ; Kira`)).toBe(false);
    // Удалённые/пропавшие строки остатка и нулевой GUID не считаются; помеченная позиция — считается.
    expect(byName.get(`${tag} Перчатки`)).toMatchObject({ quantity: 468, unitName: 'шт' });
    expect(byName.get(`${tag} Помеченная`)).toMatchObject({ quantity: 5, group: 'unlinked' });
    expect(byName.get(`${tag} МДФ 16 мм .`)).toMatchObject({ quantity: -255.781, group: 'unlinked', categoryName: 'Сырье' });
    expect(byName.get(`${tag} Серый камень AIFАлимжан`)).toMatchObject({ group: 'unlinked', quantity: 7 });
    expect(result.items.some((item) => item.itemRefKey === '00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('opens «Плёнка 1С без привязки», filters by 1C category (incl. the raw-material batch) and search', async () => {
    const film = await service.warehouseStock(admin, base({ group: 'film_unlinked' }));
    expect(film.items.map((item) => [item.name, item.quantity])).toEqual([[`${tag} Софт белый ; Kira`, -4]]);
    const unlinked = await service.warehouseStock(admin, base({ group: 'unlinked' }));
    expect(unlinked.categories.map((category) => [category.name, category.count])).toEqual([['ПЛЕНКА ПВХ ДЛЯ МДФ', 1], ['Раходные материалы', 2], ['Сырье', 1]]);
    const raw = await service.warehouseStock(admin, base({ group: 'unlinked', categoryKey: k.catRaw }));
    expect(raw.items.map((item) => item.name)).toEqual([`${tag} МДФ 16 мм .`]);
    const search = await service.warehouseStock(admin, base({ search: 'мдф', negative: true }));
    expect(search.items.map((item) => item.name)).toEqual([`${tag} МДФ 16 мм .`]);
    expect(search.tabs.find((tab) => tab.key === 'film')?.count).toBe(0);
  });

  it('a revoked directory keeps balances without names; a revoked stock entity makes 1C unavailable', async () => {
    await watcher.query("UPDATE onec_etl_entity_state SET revoked_at = now() WHERE source_id = $1 AND entity_code = 'items'", [sourceA]);
    try {
      const result = await service.warehouseStock(admin, base({ group: `material:${materialTypeId}` }));
      expect(result.onec.directoriesRevoked).toBe(true);
      expect(result.items).toEqual([expect.objectContaining({ name: k.mdf, code: null, unitName: null, categoryName: null, quantity: 112.5 })]);
    } finally {
      await watcher.query("UPDATE onec_etl_entity_state SET revoked_at = NULL WHERE source_id = $1 AND entity_code = 'items'", [sourceA]);
    }
    await watcher.query("UPDATE onec_etl_entity_state SET revoked_at = now() WHERE source_id = $1 AND entity_code = 'stock_balances'", [sourceA]);
    try {
      const result = await service.warehouseStock(admin, base());
      expect(result.onec).toMatchObject({ available: false, reason: 'revoked' });
      expect(result.tabs).toEqual([{ key: 'all', label: 'Все материалы', count: 1 }, { key: 'film', label: 'Плёнка', count: 1 }]);
    } finally {
      await watcher.query("UPDATE onec_etl_entity_state SET revoked_at = NULL WHERE source_id = $1 AND entity_code = 'stock_balances'", [sourceA]);
    }
  });

  it('refuses to pick one of two sources with the same warehouse key; a key outside the mirror is reported', async () => {
    const sourceB = await newSource(watcher, 'B');
    await state(watcher, sourceB, 'warehouses');
    await state(watcher, sourceB, 'stock_balances', t2);
    await mirror(watcher, sourceB, 'warehouses', k.wh, { Ref_Key: k.wh, Description: `${tag} Копия`, DeletionMark: false, ТипСтруктурнойЕдиницы: 'Склад' });
    await stock(watcher, sourceB, k.wh, k.gloves, 999);
    try {
      const result = await service.warehouseStock(admin, base());
      expect(result.onec).toMatchObject({ available: false, reason: 'ambiguous_source', snapshotVersion: null });
      expect(result.items.every((item) => item.source === 'erp')).toBe(true);
    } finally {
      await watcher.query('DELETE FROM onec_etl_mirror_rows WHERE source_id = $1', [sourceB]);
      await watcher.query('DELETE FROM onec_etl_entity_state WHERE source_id = $1', [sourceB]);
      await watcher.query('DELETE FROM onec_sources WHERE source_id = $1', [sourceB]);
    }
    const outside = await service.warehouseStock(admin, base({ warehouseId: otherWarehouseId }));
    expect(outside.onec).toMatchObject({ available: false, reason: 'warehouse_not_in_onec' });
    await expect(service.warehouseStock(admin, base({ warehouseId: 32000 }))).rejects.toMatchObject({ statusCode: 404, code: 'WAREHOUSE_NOT_FOUND' });
  });

  it('without an applied snapshot 1C is «not loaded» (revoked wins); an applied empty snapshot is available', async () => {
    const empty = await service.warehouseStock(admin, base({ warehouseId: emptyWarehouseId }));
    expect(empty.onec).toMatchObject({ available: true, reason: null, snapshotVersion: t1 });
    expect(empty.items).toEqual([]);
    // Строка состояния есть, применённого снимка нет (первое завершение отклонено).
    await watcher.query("UPDATE onec_etl_entity_state SET snapshot_version = NULL, snapshot_rejected_reason = 'rows_mismatch' WHERE source_id = $1 AND entity_code = 'stock_balances'", [sourceA]);
    try {
      const notLoaded = await service.warehouseStock(admin, base());
      expect(notLoaded.onec).toMatchObject({ available: false, reason: 'not_loaded' });
      expect(notLoaded.items.every((item) => item.source === 'erp')).toBe(true);
      await watcher.query("UPDATE onec_etl_entity_state SET revoked_at = now() WHERE source_id = $1 AND entity_code = 'stock_balances'", [sourceA]);
      expect((await service.warehouseStock(admin, base())).onec.reason).toBe('revoked');
    } finally {
      await watcher.query("UPDATE onec_etl_entity_state SET snapshot_version = $2, snapshot_rejected_reason = NULL, revoked_at = NULL WHERE source_id = $1 AND entity_code = 'stock_balances'", [sourceA, t1]);
    }
  });

  it('reads state and rows of one snapshot even when a new snapshot commits in between', async () => {
    const newer = new Client({ connectionString: url });
    await newer.connect();
    try {
      hook = async () => {
        hook = null;
        // «Применение снимка» другой транзакцией между чтением состояния и строк.
        await newer.query('BEGIN');
        await newer.query(
          `UPDATE onec_etl_mirror_rows SET data = jsonb_set(data, '{КоличествоBalance}', '999'::jsonb)
            WHERE source_id = $1 AND entity_code = 'stock_balances' AND data->>'Номенклатура_Key' = $2 AND (data->>'КоличествоBalance')::numeric = 100`,
          [sourceA, k.mdf],
        );
        await newer.query("UPDATE onec_etl_entity_state SET snapshot_version = $2 WHERE source_id = $1 AND entity_code = 'stock_balances'", [sourceA, t2]);
        await newer.query('COMMIT');
      };
      const during = await service.warehouseStock(admin, base({ group: `material:${materialTypeId}` }));
      expect(hook).toBeNull();
      expect(during.onec.snapshotVersion).toBe(t1);
      expect(during.items.map((item) => item.quantity)).toEqual([112.5]);
      const after = await service.warehouseStock(admin, base({ group: `material:${materialTypeId}` }));
      expect(after.onec.snapshotVersion).toBe(t2);
      expect(after.items.map((item) => item.quantity)).toEqual([1011.5]);
    } finally {
      hook = null;
      await newer.end();
    }
  });

  it('with the 1C module off the film tab still works and 1C reports onec_disabled', async () => {
    const config = new ConfigService<BackendEnv, true>({
      DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 1, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 10000,
      BACKEND_INVENTORY_ENABLED: true, BACKEND_ENABLE_ONEC_AGENT: false, ONEC_CLIENT_CERT_HEADER: 'x-client-cert',
    });
    const off = new InventoryService(database, config, new OnecCatalogReader(database, new OnecRuntimeConfigService(config)));
    const result = await off.warehouseStock(admin, base());
    expect(result.onec).toMatchObject({ available: false, reason: 'onec_disabled' });
    expect(result.items.map((item) => item.filmId)).toEqual([filmId]);
  });
});
