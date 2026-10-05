import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { buildTargetName, catalogKeyOf } from '../../../shared/film-catalog';
import type { OnecCatalogReader } from '../../onec-agent/onec-catalog-reader';
import { CatalogImportService } from '../application/catalog-import.service';
import { DECISIONS_FORMAT, DECISIONS_VERSION, FINGERPRINT_VERSION, withSha, type DecisionsFile } from '../domain/catalog-decisions';

// Файл решений: строгий повтор решений stage (план §C). «Прод» — та же одноразовая БД после
// отката пакета stage (плёнки возвращены к состоянию черновика). Только film_catalog_it_*.
const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;
const p = 'E2E-Тест-решения';

describe.skipIf(!url)('film catalog decisions file — strict replay, real PostgreSQL', { timeout: 60000 }, () => {
  let pool: Pool;
  let client: PoolClient;
  let actorId: number;
  let vendorId: number;
  let supplierName = '';
  let materialTypeId = 0;
  let filmTypeId: number;
  let service: CatalogImportService;
  const query = <T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => client.query<T>(text, [...params]);
  class CommittedDatabase extends DatabaseService {
    readonly tx: TransactionClient;
    constructor(readonly connection: PoolClient) {
      super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 15000 }), {} as never);
      this.tx = { raw: connection, query: this.query.bind(this) };
    }
    override async query<T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) {
      return this.connection.query<T>(text, [...params]);
    }
    override async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
      await this.connection.query('BEGIN');
      await this.connection.query("SET LOCAL lock_timeout='10s'");
      try {
        const result = await handler(this.tx);
        await this.connection.query('COMMIT');
        return result;
      } catch (error) {
        await this.connection.query('ROLLBACK');
        throw error;
      }
    }
  }
  const key = () => randomUUID();
  const asCatalog = <T>(value: T) => value;

  async function backendOwned<T>(run: () => Promise<T>): Promise<T> {
    await query("SELECT set_config('erp.film_catalog', 'on', false)");
    try { return await run(); } finally { await query("SELECT set_config('erp.film_catalog', '', false)"); }
  }
  async function film(name: string): Promise<number> {
    const { rows } = await query<{ film_id: string }>(
      `INSERT INTO films(film_name,vendor_id,film_type_id,film_texture,is_active,created_by,edited_by) VALUES($1,$2,$3,false,true,$4,$4) RETURNING film_id`,
      [name, vendorId, filmTypeId, actorId],
    );
    return Number(rows[0].film_id);
  }
  async function draftRows(names: string[]) {
    return service.create({
      kind: 'films', source: 'file', fileName: 'decisions-fixture.xlsx',
      fileSha256: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64), sheetName: 'Пленки',
      rows: names.map((name, index) => ({
        rowNo: index + 2, nameOriginal: name, nameFull: `${name}; ${supplierName}`, supplier: supplierName,
        nomenclatureType: 'Пленка', unit: 'пог. м', nomenclatureCategory: 'ПЛЕНКА ПВХ ДЛЯ МДФ',
      })),
    }, actorId, randomUUID(), key());
  }
  async function decide(batchId: number, mapping: Array<{ filmId: number; row: number | null }>, canonical: Array<{ row: number; filmId: number }>) {
    const rows = (await service.rows(batchId, [], {})).items;
    const others: number[] = [];
    for (const status of ['suggested', 'auto']) {
      for (const item of (await service.matches(batchId, [], { status, limit: '500' })).items) {
        if (!mapping.some((m) => m.filmId === item.filmId)) others.push(item.filmId);
      }
    }
    await service.patch(batchId, [], {
      version: 1,
      actions: [
        ...others.map((filmId) => ({ type: 'setMatch' as const, filmId, rowId: null })),
        ...mapping.map((m) => ({ type: 'setMatch' as const, filmId: m.filmId, rowId: m.row === null ? null : rows[m.row].rowId })),
        ...canonical.map((c) => ({ type: 'setCanonical' as const, rowId: rows[c.row].rowId, filmId: c.filmId })),
      ],
    }, actorId, randomUUID(), key());
    await service.apply(batchId, [], 2, actorId, randomUUID(), key());
  }
  async function importFile(file: DecisionsFile, idempotencyKey = key()) {
    return service.create(asCatalog({ kind: 'films' as const, source: 'decisions' as const, decisions: file }), actorId, randomUUID(), idempotencyKey);
  }
  async function errorOf(promise: Promise<unknown>) {
    return promise.then(() => null, (error: { statusCode?: number; code?: string; details?: unknown }) => error);
  }

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    pool = new Pool({ connectionString: url, max: 2 });
    client = await pool.connect();
    const base = await query<{ role_id: number; material_type_id: number }>(
      'SELECT (SELECT min(role_id) FROM roles) role_id,(SELECT min(material_type_id) FROM material_types) material_type_id',
    );
    actorId = Number((await query<{ user_id: string }>(
      `INSERT INTO users (username, email, password_hash, role_id, full_name) VALUES ($1, $2, 'test-hash', $3, $4) RETURNING user_id`,
      [`${p}-actor-${randomUUID()}`, `${randomUUID()}@example.invalid`, base.rows[0].role_id, `${p} actor`],
    )).rows[0].user_id);
    materialTypeId = base.rows[0].material_type_id;
    filmTypeId = (await query<{ film_type_id: number }>(
      'INSERT INTO film_types(film_type_name,created_by) VALUES($1,$2) RETURNING film_type_id', [`${p} тип ${randomUUID().slice(0, 6)}`, actorId],
    )).rows[0].film_type_id;
    await query("SELECT set_config('app.user_id',$1,false)", [String(actorId)]);
    service = new CatalogImportService(new CommittedDatabase(client), {} as unknown as OnecCatalogReader);
  }, 30000);
  beforeEach(async () => {
    supplierName = `${p} поставщик ${randomUUID().slice(0, 8)}`;
    vendorId = (await query<{ vendor_id: number }>(
      'INSERT INTO vendors(vendor_name,material_type_id,created_by) VALUES($1,$2,$3) RETURNING vendor_id', [supplierName, materialTypeId, actorId],
    )).rows[0].vendor_id;
  });
  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  it('round-trip: export from an applied batch, strict replay after the stage state is rolled back, read-only draft', async () => {
    const a1 = await film(`${p} орех`);
    const a2 = await film(`${p} орех 2`);
    const b = await film(`${p} другое`);
    const stage = await draftRows([`${p} Орех Милано`, `${p} Новинка`]);
    await decide(stage.id, [{ filmId: a1, row: 0 }, { filmId: a2, row: 0 }, { filmId: b, row: null }], [{ row: 0, filmId: a1 }]);
    const created = (await query<{ film_id: string }>('SELECT film_id FROM films WHERE film_name=$1', [buildTargetName(`${p} Новинка`, supplierName)])).rows[0];
    expect(created).toBeDefined();

    // Поставщика переименовали ПОСЛЕ применения: выгрузка берёт снимок на момент apply.
    await query('UPDATE vendors SET vendor_name=$2 WHERE vendor_id=$1', [vendorId, `${supplierName} B`]);
    const file = await service.exportDecisions(stage.id, []);
    expect(file.format).toBe(DECISIONS_FORMAT);
    expect(file.rows.map((row) => [row.targetName, row.outcome, row.films.map((f) => [f.filmId, f.role])])).toEqual([
      [buildTargetName(`${p} Орех Милано`, supplierName), 'existing', [[a1, 'canonical'], [a2, 'duplicate']]],
      [buildTargetName(`${p} Новинка`, supplierName), 'create', []],
    ]);
    expect(file.vendors).toEqual([expect.objectContaining({ vendorId, vendorName: supplierName, created: false })]);
    expect(await errorOf(service.exportDecisions(stage.id + 100000, []))).toMatchObject({ statusCode: 404 });

    // «Прод» = состояние до применения: откат пакета stage; созданная stage-плёнка «отсутствует на проде»;
    // у «прода» поставщик со старым именем и ДРУГОЙ поставщик с новым именем stage.
    await service.revert(stage.id, [], actorId, randomUUID(), key());
    await query('UPDATE vendors SET vendor_name=$2 WHERE vendor_id=$1', [vendorId, supplierName]);
    const other = (await query<{ vendor_id: string }>(
      'INSERT INTO vendors(vendor_name,material_type_id,created_by) VALUES($1,$2,$3) RETURNING vendor_id', [`${supplierName} B`, materialTypeId, actorId],
    )).rows[0].vendor_id;
    await backendOwned(() => query('UPDATE films SET catalog_key=NULL, ref_key_1c=NULL, film_name=$2 WHERE film_id=$1', [created.film_id, `${p} удалено ${randomUUID().slice(0, 6)}`]));

    const replay = await importFile(file);
    expect(replay.status).toBe('draft');
    expect(replay.counters).toMatchObject({ confirmed: 2, toCreate: 1, decisionsSkipped: 0 });
    expect(await errorOf(service.patch(replay.id, [], { version: 1, actions: [{ type: 'acceptAllAuto' }] }, actorId, randomUUID(), key())))
      .toMatchObject({ statusCode: 409, code: 'CATALOG_IMPORT_READ_ONLY' });
    await service.apply(replay.id, [], replay.version, actorId, randomUUID(), key());
    const after = await query<{ film_id: string; film_name: string; canonical_film_id: string | null; is_active: boolean }>(
      'SELECT film_id,film_name,canonical_film_id,is_active FROM films WHERE film_id=ANY($1::bigint[]) ORDER BY film_id', [[a1, a2, b]],
    );
    expect(after.rows.map((row) => [Number(row.film_id), row.film_name, row.canonical_film_id === null ? null : Number(row.canonical_film_id), row.is_active])).toEqual([
      [a1, buildTargetName(`${p} Орех Милано`, supplierName), null, true],
      [a2, buildTargetName(`${p} Орех Милано`, supplierName), a1, false],
      [b, `${p} другое`, null, true],
    ]);
    const vendorOfA1 = (await query<{ vendor_id: string }>('SELECT vendor_id FROM films WHERE film_id=$1', [a1])).rows[0].vendor_id;
    expect(Number(vendorOfA1)).toBe(vendorId);
    expect(Number(vendorOfA1)).not.toBe(Number(other));
        const createdOnProd = await query<{ film_id: string; catalog_key: string }>(
      'SELECT film_id,catalog_key FROM films WHERE film_name=$1 AND is_active', [buildTargetName(`${p} Новинка`, supplierName)],
    );
    expect(createdOnProd.rows).toHaveLength(1);
    expect(Number(createdOnProd.rows[0].film_id)).not.toBe(Number(created.film_id));
    expect(createdOnProd.rows[0].catalog_key).toBe(catalogKeyOf(`${p} Новинка; ${supplierName}`));
    // Повтор загрузки того же файла тем же ключом — тот же черновик.
  });

  it('skips a film changed on prod and never falls back to automatic matching; a lost canonical skips the row', async () => {
    const c1 = await film(`${p} клён`);
    const c2 = await film(`${p} клён 2`);
    const stage = await draftRows([`${p} Клён Эталон`]);
    await decide(stage.id, [{ filmId: c1, row: 0 }, { filmId: c2, row: 0 }], [{ row: 0, filmId: c1 }]);
    const file = await service.exportDecisions(stage.id, []);
    await service.revert(stage.id, [], actorId, randomUUID(), key());

    await query('UPDATE films SET film_texture=true WHERE film_id=$1', [c2]);
    const replay = await importFile(file);
    expect(replay.counters).toMatchObject({ confirmed: 1, decisionsSkipped: 1 });
    expect((replay.options as { decisions: { skipped: unknown[] } }).decisions.skipped).toEqual([{ filmId: c2, catalogKey: file.rows[0].catalogKey, reason: 'changed' }]);
    await service.apply(replay.id, [], replay.version, actorId, randomUUID(), key());
    const rows = await query<{ film_id: string; canonical_film_id: string | null; film_name: string }>(
      'SELECT film_id,canonical_film_id,film_name FROM films WHERE film_id=ANY($1::bigint[]) ORDER BY film_id', [[c1, c2]],
    );
    expect(rows.rows.map((row) => [Number(row.film_id), row.canonical_film_id])).toEqual([[c1, null], [c2, null]]);
    expect(rows.rows[1].film_name).toBe(`${p} клён 2`);

    // Основная плёнка изменена → строка не применяется и не создаётся.
    await service.revert(replay.id, [], actorId, randomUUID(), key());
    await query('UPDATE films SET film_texture=true WHERE film_id=$1', [c1]);
    const lost = await importFile(file);
    expect(lost.counters).toMatchObject({ confirmed: 0, toCreate: 0, rowsSkipped: 1 });
    expect(lost.canApply).toBe(true);
    await service.apply(lost.id, [], lost.version, actorId, randomUUID(), key());
    const untouched = await query<{ n: string }>('SELECT count(*) AS n FROM films WHERE film_name=$1', [buildTargetName(`${p} Клён Эталон`, supplierName)]);
    expect(Number(untouched.rows[0].n)).toBe(0);
  });

  it('never overwrites an existing 1C key of a film (ref_key_conflict), for any import', async () => {
    const k = await film(`${p} ключ`);
    await backendOwned(() => query('UPDATE films SET ref_key_1c=$2 WHERE film_id=$1', [k, randomUUID()]));
    const keyBefore = (await query<{ ref_key_1c: string }>('SELECT ref_key_1c::text FROM films WHERE film_id=$1', [k])).rows[0].ref_key_1c;
    const stage = await draftRows([`${p} Ключ Эталон`]);
    const rows = (await service.rows(stage.id, [], {})).items;
    await service.patch(stage.id, [], { version: 1, actions: [{ type: 'setMatch', filmId: k, rowId: rows[0].rowId }] }, actorId, randomUUID(), key());
    expect(await errorOf(service.apply(stage.id, [], 2, actorId, randomUUID(), key()))).toMatchObject({
      statusCode: 409, code: 'CATALOG_IMPORT_CONFLICT', details: { conflicts: expect.arrayContaining([expect.objectContaining({ filmId: k, reason: 'ref_key_conflict' })]) },
    });
    expect((await query<{ ref_key_1c: string }>('SELECT ref_key_1c::text FROM films WHERE film_id=$1', [k])).rows[0].ref_key_1c).toBe(keyBefore);
  });

  it('vendors: a stage-created vendor is created with the exported name and type; a concurrent same-name insert yields one vendor; repeats reuse it', async () => {
    const types = await query<{ material_type_id: number }>('SELECT material_type_id FROM material_types ORDER BY material_type_id DESC LIMIT 1');
    const exportedType = types.rows[0].material_type_id;
    const newVendorName = `${p} новый поставщик ${randomUUID().slice(0, 8)}`;
    const name = `${p} Позиция нового поставщика`;
    const file = withSha({
      format: DECISIONS_FORMAT, version: DECISIONS_VERSION, fingerprintVersion: FINGERPRINT_VERSION, sourceBatchId: 999999,
      exportedAt: new Date().toISOString(),
      rows: [{
        catalogKey: catalogKeyOf(`${name}; ${newVendorName}`), onecRefKey: null, rowNo: 2, nameOriginal: name, nameFull: `${name}; ${newVendorName}`,
        supplier: newVendorName, nomenclatureType: 'Пленка', unit: 'пог. м', nomenclatureCategory: 'ПЛЕНКА ПВХ ДЛЯ МДФ',
        targetName: buildTargetName(name, newVendorName), supplierNorm: newVendorName.toLowerCase(), canonicalFilmTexture: null,
        canonicalFilmTypeId: null, outcome: 'create', films: [],
      }],
      vendors: [{ supplierNorm: newVendorName.toLowerCase(), vendorId: 32000, vendorName: newVendorName, materialTypeId: exportedType, created: true }],
    });
    const replay = await importFile(file);
    expect(replay.vendorMappings).toEqual([expect.objectContaining({ createVendor: true })]);
    // Параллельная вставка того же поставщика (как через справочник Hasura) — до apply.
    await query('INSERT INTO vendors(vendor_name,material_type_id,created_by) VALUES($1,$2,$3)', [newVendorName, exportedType, actorId]);
    await service.apply(replay.id, [], replay.version, actorId, randomUUID(), key());
    const vendors = await query<{ vendor_id: string; material_type_id: number }>('SELECT vendor_id,material_type_id FROM vendors WHERE vendor_name=$1', [newVendorName]);
    expect(vendors.rows).toHaveLength(1);
    expect(vendors.rows[0].material_type_id).toBe(exportedType);
    const created = await query<{ vendor_id: string }>('SELECT vendor_id FROM films WHERE film_name=$1', [buildTargetName(name, newVendorName)]);
    expect(Number(created.rows[0].vendor_id)).toBe(Number(vendors.rows[0].vendor_id));
    // Повтор файла: поставщик найден по названию и типу (не создаётся), позиция уже есть.
    const again = await importFile(file);
    expect(again.vendorMappings).toEqual([expect.objectContaining({ createVendor: false, vendorId: Number(vendors.rows[0].vendor_id) })]);
    expect(again.counters).toMatchObject({ toCreate: 0, rowsSkipped: 1 });

    // Переименование поставщика, начатое другой транзакцией до apply: apply ждёт его (FOR SHARE),
    // перепроверяет имя и отказывает без частичной записи.
    const { sha256: _signed, ...unsigned } = file;
    const race = withSha({ ...unsigned, rows: [{ ...file.rows[0], catalogKey: `${file.rows[0].catalogKey} гонка`, targetName: `${file.rows[0].targetName} гонка` }], vendors: [{ ...file.vendors[0], created: false, vendorId: Number(vendors.rows[0].vendor_id) }] });
    const raceDraft = await importFile(race);
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('UPDATE vendors SET vendor_name=$2 WHERE vendor_id=$1', [vendors.rows[0].vendor_id, `${newVendorName} переименован`]);
      const applyPid = (client as unknown as { processID: number }).processID;
      const pending = errorOf(service.apply(raceDraft.id, [], raceDraft.version, actorId, randomUUID(), key()));
      // Ждём, пока apply действительно встанет в ожидание блокировки строки поставщика.
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        const rows = await other.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [applyPid]);
        waiting = Number(rows.rows[0].n) > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      await other.query('COMMIT');
      expect(await pending).toMatchObject({ statusCode: 409, code: 'CATALOG_IMPORT_CONFLICT' });
    } finally {
      other.release();
    }
    const raceFilm = await query('SELECT 1 FROM films WHERE film_name=$1', [`${file.rows[0].targetName} гонка`]);
    expect(raceFilm.rows).toHaveLength(0);

    const unknown = withSha({ ...unsigned, vendors: [{ ...file.vendors[0], created: false, vendorName: `${p} нет такого` }] });
    expect(await errorOf(importFile(unknown))).toMatchObject({ statusCode: 422, code: 'CATALOG_DECISIONS_VENDOR_UNRESOLVED' });
    expect(await errorOf(importFile({ ...file, sha256: '0'.repeat(64) }))).toMatchObject({ statusCode: 422, code: 'CATALOG_DECISIONS_INVALID' });
  });

  it('a vendor inserted concurrently by another transaction is used but not recorded as created by the package', async () => {
    const types = await query<{ material_type_id: number }>('SELECT material_type_id FROM material_types ORDER BY material_type_id LIMIT 1');
    const typeId = types.rows[0].material_type_id;
    const vendorName = `${p} гонка поставщика ${randomUUID().slice(0, 8)}`;
    const name = `${p} Позиция гонки`;
    const file = withSha({
      format: DECISIONS_FORMAT, version: DECISIONS_VERSION, fingerprintVersion: FINGERPRINT_VERSION, sourceBatchId: 999998,
      exportedAt: new Date().toISOString(),
      rows: [{
        catalogKey: catalogKeyOf(`${name}; ${vendorName}`), onecRefKey: null, rowNo: 2, nameOriginal: name, nameFull: `${name}; ${vendorName}`,
        supplier: vendorName, nomenclatureType: 'Пленка', unit: 'пог. м', nomenclatureCategory: 'ПЛЕНКА ПВХ ДЛЯ МДФ',
        targetName: buildTargetName(name, vendorName), supplierNorm: vendorName.toLowerCase(), canonicalFilmTexture: null,
        canonicalFilmTypeId: null, outcome: 'create', films: [],
      }],
      vendors: [{ supplierNorm: vendorName.toLowerCase(), vendorId: 31999, vendorName, materialTypeId: typeId, created: true }],
    });
    const replay = await importFile(file);
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('INSERT INTO vendors(vendor_name,material_type_id,created_by) VALUES($1,$2,$3)', [vendorName, typeId, actorId]);
      const applyPid = (client as unknown as { processID: number }).processID;
      const pending = service.apply(replay.id, [], replay.version, actorId, randomUUID(), key());
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        const rows = await other.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [applyPid]);
        waiting = Number(rows.rows[0].n) > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      await other.query('COMMIT');
      const applied = await pending;
      const snapshot = (applied.options as { appliedVendors?: Array<{ vendorName: string; created: boolean }> }).appliedVendors ?? [];
      expect(snapshot).toEqual([expect.objectContaining({ vendorName, created: false })]);
    } finally {
      other.release();
    }
    const vendors = await query('SELECT 1 FROM vendors WHERE vendor_name=$1', [vendorName]);
    expect(vendors.rows).toHaveLength(1);
  });
});
