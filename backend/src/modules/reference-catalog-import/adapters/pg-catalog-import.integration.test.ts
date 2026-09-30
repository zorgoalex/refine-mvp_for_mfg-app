import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it, beforeEach } from 'vitest';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { OnecCatalogReader } from '../../onec-agent/onec-catalog-reader';
import { CatalogImportService } from '../application/catalog-import.service';
import type { BackendEnv } from '../../../config/env.validation';

const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;
const prefix = 'E2E-Тест';

describe.skipIf(!url)('film catalog import PostgreSQL transactions', () => {
  let pool: Pool;
  let client: PoolClient;
  let actorId: number;
  let vendorId: number;
  let supplierName = '';
  let materialTypeId = 0;
  let filmTypeId: number;
  let service: CatalogImportService;
  const query = async <
    T extends import('pg').QueryResultRow = import('pg').QueryResultRow
  >(
    text: string,
    params: readonly unknown[] = []
  ) => client.query<T>(text, [...params]);
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
  const catalog = () =>
    new CatalogImportService(
      new CommittedDatabase(client),
      {} as unknown as OnecCatalogReader
    );
  const key = () => randomUUID();
  async function createFilm(
    name: string,
    catalogKey: string | null = null,
    canonicalFilmId: number | null = null
  ) {
    // Служебные колонки пишет только backend-транзакция импорта (guard-триггер миграции 202).
    const backendOwned = catalogKey !== null || canonicalFilmId !== null;
    if (backendOwned) await query("SELECT set_config('erp.film_catalog', 'on', false)");
    const { rows } = await query<{ film_id: string }>(
      `INSERT INTO films(film_name,vendor_id,film_type_id,film_texture,is_active,created_by,edited_by,catalog_key,canonical_film_id) VALUES($1,$2,$3,false,$4,$5,$5,$6,$7) RETURNING film_id`,
      [
        name,
        vendorId,
        filmTypeId,
        canonicalFilmId === null,
        actorId,
        catalogKey,
        canonicalFilmId,
      ]
    );
    if (backendOwned) await query("SELECT set_config('erp.film_catalog', '', false)");
    return Number(rows[0].film_id);
  }
  async function draft(name: string) {
    return catalog().create(
      {
        kind: 'films',
        source: 'file',
        fileName: 'fixture.xlsx',
        fileSha256: randomUUID()
          .replaceAll('-', '')
          .padEnd(64, '0')
          .slice(0, 64),
        sheetName: 'Пленки',
        rows: [
          {
            rowNo: 2,
            nameOriginal: name,
            nameFull: `${name}; ${supplierName}`,
            supplier: supplierName,
            nomenclatureType: 'Пленка',
            unit: 'пог. м',
            nomenclatureCategory: 'ПЛЕНКА ПВХ ДЛЯ МДФ',
          },
        ],
      },
      actorId,
      randomUUID(),
      key()
    );
  }
  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    pool = new Pool({ connectionString: url, max: 1 });
    client = await pool.connect();
    const col = await client.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='films' AND column_name='canonical_film_id') present`
    );
    if (!col.rows[0].present) {
      const sql = await readFile(
        new URL(
          '../../../../db/migrations/202_film_catalog_import.sql',
          import.meta.url
        ),
        'utf8'
      );
      await client.query(sql);
    }
    const base = await client.query<{
      user_id: string;
      role_id: number;
      material_type_id: number;
    }>(
      `SELECT (SELECT min(user_id) FROM users)::text user_id,(SELECT min(role_id) FROM roles) role_id,(SELECT min(material_type_id) FROM material_types) material_type_id`
    );
    // Собственный пользователь фикстуры (в одноразовой БД пользователей нет).
    const actor = await client.query<{ user_id: string }>(
      `INSERT INTO users (username, email, password_hash, role_id, full_name)
       VALUES ($1, $2, 'test-hash', $3, $4) RETURNING user_id`,
      [`${prefix}-actor-${randomUUID()}`, `${randomUUID()}@example.invalid`, base.rows[0].role_id, `${prefix} actor`],
    );
    actorId = Number(actor.rows[0].user_id);
    materialTypeId = base.rows[0].material_type_id;
    const type = await client.query<{ film_type_id: number }>(
      `INSERT INTO film_types(film_type_name,created_by) VALUES($1,$2) RETURNING film_type_id`,
      [`${prefix} тип`, actorId]
    );
    filmTypeId = type.rows[0].film_type_id;
    await client.query("SELECT set_config('app.user_id',$1,false)", [
      String(actorId),
    ]);
    service = catalog();
  }, 30000);
  // Закоммиченные фикстуры: у каждого сценария свой поставщик, чтобы плёнки других
  // сценариев не становились кандидатами сопоставления.
  async function newSupplier() {
    supplierName = `${prefix} поставщик ${randomUUID().slice(0, 8)}`;
    const vendor = await client.query<{ vendor_id: number }>(
      `INSERT INTO vendors(vendor_name,material_type_id,created_by) VALUES($1,$2,$3) RETURNING vendor_id`,
      [supplierName, materialTypeId, actorId]
    );
    vendorId = vendor.rows[0].vendor_id;
  }
  beforeEach(newSupplier);
  afterAll(async () => {
    if (client) {
      client.release();
    }
    await pool?.end();
  });

  it('renames canonical, merges duplicates, records history and edited_by', async () => {
    const canonical = await createFilm(`${prefix} старое имя`);
    const duplicate = await createFilm(`${prefix} старое имя 2`);
    await query(`UPDATE films SET note='Своя заметка' WHERE film_id=$1`, [duplicate]);
    const batch = await draft(`${prefix} новое имя`);
    const rows = await service.rows(batch.id, [], {});
    const rowId = rows.items[0]!.rowId;
    await service.patch(
      batch.id,
      [],
      {
        version: 1,
        actions: [
          { type: 'setMatch', filmId: canonical, rowId },
          { type: 'setMatch', filmId: duplicate, rowId },
          { type: 'setCanonical', rowId, filmId: canonical },
        ],
      },
      actorId,
      randomUUID(),
      key()
    );
    await service.apply(batch.id, [], 2, actorId, randomUUID(), key());
    const films = await query<{
      film_name: string;
      canonical_film_id: number | null;
      is_active: boolean;
      edited_by: number;
    }>(
      `SELECT film_name,canonical_film_id,is_active,edited_by FROM films WHERE film_id=ANY($1::bigint[]) ORDER BY film_id`,
      [[canonical, duplicate]]
    );
    // bigint из pg приходит строкой — сравниваем числа.
    expect(films.rows.map((row) => ({
      ...row,
      canonical_film_id: row.canonical_film_id === null ? null : Number(row.canonical_film_id),
      edited_by: Number(row.edited_by),
    }))).toEqual([
      {
        film_name: `${prefix} новое имя; ${supplierName}`,
        canonical_film_id: null,
        is_active: true,
        edited_by: actorId,
      },
      {
        film_name: `${prefix} новое имя; ${supplierName}`,
        canonical_film_id: canonical,
        is_active: false,
        edited_by: actorId,
      },
    ]);
    const history = await query<{
      source: string;
      batch_id: string;
      changed_by: number;
    }>(
      `SELECT source,batch_id,changed_by FROM film_name_history WHERE film_id=ANY($1::bigint[]) ORDER BY film_id`,
      [[canonical, duplicate]]
    );
    expect(history.rows).toHaveLength(2);
    expect(
      history.rows.every(
        (item) =>
          item.source === 'catalog_import' &&
          Number(item.batch_id) === batch.id &&
          Number(item.changed_by) === actorId
      )
    ).toBe(true);
    // Прежние названия — в примечании (канон и дубль); пользовательский текст сохраняется.
    const notes = await query<{ film_id: string; note: string | null }>(
      `SELECT film_id,note FROM films WHERE film_id=ANY($1::bigint[]) ORDER BY film_id`,
      [[canonical, duplicate]]
    );
    expect(notes.rows.map((row) => row.note)).toEqual([
      `Прежнее название: ${prefix} старое имя`,
      `Своя заметка\nПрежнее название: ${prefix} старое имя 2`,
    ]);
    // Индекс имён для импорта заказов: прежние имена ведут к канону, индекс полный.
    const index = await service.nameIndex();
    expect(index.truncated).toBe(false);
    expect(index.items.filter((item) => item.name === `${prefix} старое имя 2`)).toEqual([
      expect.objectContaining({ filmId: duplicate, canonicalFilmId: canonical, source: 'history' }),
    ]);
    expect(index.items).toContainEqual(expect.objectContaining({
      name: `${prefix} старое имя`, filmId: canonical, canonicalFilmId: canonical, source: 'history',
    }));
    const repeated = await draft(`${prefix} новое имя`);
    await expect(service.apply(repeated.id, [], 1, actorId, randomUUID(), key())).resolves.toMatchObject({ status: 'applied' });
    await service.revert(repeated.id, [], actorId, randomUUID(), key());
    await service.revert(batch.id, [], actorId, randomUUID(), key());
    const restored = await query<{ note: string | null }>(
      `SELECT note FROM films WHERE film_id=ANY($1::bigint[]) ORDER BY film_id`,
      [[canonical, duplicate]]
    );
    expect(restored.rows.map((row) => row.note)).toEqual([null, 'Своя заметка']);
  });

  it('setVendor keeps name-derived matches (DECOR 777, vendor without own films) and a user «no pair»', async () => {
    const nd = (await query<{ vendor_id: number }>(`SELECT vendor_id FROM vendors WHERE lower(trim(vendor_name))='нд' ORDER BY vendor_id LIMIT 1`)).rows[0];
    const decor = (await query<{ vendor_id: number }>(`SELECT vendor_id FROM vendors WHERE lower(trim(vendor_name))='decor777' ORDER BY vendor_id LIMIT 1`)).rows[0];
    expect(nd && decor).toBeTruthy();
    expect((await query<{ n: number }>(`SELECT count(*)::int n FROM films WHERE vendor_id=$1`, [decor.vendor_id])).rows[0].n).toBe(0);
    // Уникальное кириллическое слово: цифры в названии разбор принял бы за код.
    const word = [...randomUUID().replaceAll('-', '').slice(0, 8)].map((c) => 'абвгдежзиклмнопр'['0123456789abcdef'.indexOf(c)]).join('');
    const film = Number((await query<{ film_id: string }>(
      `INSERT INTO films(film_name,vendor_id,film_type_id,film_texture,is_active,created_by,edited_by) VALUES($1,$2,$3,false,true,$4,$4) RETURNING film_id`,
      [`${prefix} ${word} супермат декор777`, nd.vendor_id, filmTypeId, actorId],
    )).rows[0].film_id);
    const row = (name: string, supplier: string, rowNo: number) => ({
      rowNo, nameOriginal: name, nameFull: `${name}; ${supplier}`, supplier,
      nomenclatureType: 'Пленка', unit: 'пог. м', nomenclatureCategory: 'ПЛЕНКА ПВХ ДЛЯ МДФ',
    });
    const unknownSupplier = `${prefix} неизвестный ${word}`;
    const batch = await catalog().create({
      kind: 'films', source: 'file', fileName: 'fixture.xlsx', fileSha256: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64), sheetName: 'Пленки',
      rows: [row(`${prefix} ${word} супермат`, 'DECOR 777', 2), row(`${prefix} ${word} другая`, unknownSupplier, 3)],
    }, actorId, randomUUID(), key());
    const matchOf = async () => (await query<{ match_status: string; row_id: string | null }>(
      `SELECT match_status,row_id FROM catalog_import_matches WHERE batch_id=$1 AND film_id=$2`, [batch.id, film],
    )).rows[0];
    const before = await matchOf();
    const decorRow = (await query<{ row_id: string }>(`SELECT row_id FROM catalog_import_rows WHERE batch_id=$1 AND supplier='DECOR 777'`, [batch.id])).rows[0];
    expect(before.match_status).not.toBe('unchanged');
    expect(before.row_id).toBe(decorRow.row_id);
    // Сопоставление ДРУГОГО поставщика пересчитывает неявные плёнки — плёнка DECOR 777 не теряет строку.
    await service.patch(batch.id, [], { version: 1, actions: [{ type: 'setVendor', supplierNorm: unknownSupplier.trim().toLowerCase(), vendorId }] }, actorId, randomUUID(), key());
    expect(await matchOf()).toEqual(before);
    // «Нет пары» пользователя поверх сопоставления переживает следующий пересчёт (setVendor).
    await service.patch(batch.id, [], { version: 2, actions: [{ type: 'setMatch', filmId: film, rowId: null }] }, actorId, randomUUID(), key());
    const rejected = await matchOf();
    expect(rejected).toEqual({ match_status: 'none', row_id: null });
    await service.patch(batch.id, [], { version: 3, actions: [{ type: 'setVendor', supplierNorm: unknownSupplier.trim().toLowerCase(), vendorId }] }, actorId, randomUUID(), key());
    expect(await matchOf()).toEqual(rejected);
  });

  it('a cancelled stock document does not block merging a duplicate; a draft still does', async () => {
    const warehouseId = Number((await query<{ id: number }>(`SELECT min(warehouse_id) AS id FROM warehouses`)).rows[0].id);
    const stockLine = async (filmId: number, status: 'draft' | 'cancelled') => {
      const doc = Number((await query<{ document_id: string }>(
        `INSERT INTO stock_documents(doc_type,status,warehouse_id,doc_date,source,created_by,request_id,cancelled_by,cancelled_at)
         VALUES('inventory',$1,$2,current_date,'manual',$3,$4,CASE WHEN $1='cancelled' THEN $3::bigint END,CASE WHEN $1='cancelled' THEN now() END) RETURNING document_id`,
        [status, warehouseId, actorId, `req-${randomUUID()}`],
      )).rows[0].document_id);
      await query(`INSERT INTO stock_document_lines(document_id,line_no,film_id,quantity,match_status,quantity_status) VALUES($1,1,$2,1.1,'manual','confirmed')`, [doc, filmId]);
    };
    const mergeInto = async (label: string, lineStatus: 'draft' | 'cancelled') => {
      await newSupplier();
      const canonical = await createFilm(`${prefix} ${label} основная`);
      const duplicate = await createFilm(`${prefix} ${label} дубль`);
      await stockLine(duplicate, lineStatus);
      const batch = await draft(`${prefix} ${label} каталог`);
      const row = (await service.rows(batch.id, [], {})).items[0]!;
      await service.patch(batch.id, [], { version: 1, actions: [
        { type: 'setMatch', filmId: canonical, rowId: row.rowId }, { type: 'setMatch', filmId: duplicate, rowId: row.rowId },
        { type: 'setCanonical', rowId: row.rowId, filmId: canonical },
      ] }, actorId, randomUUID(), key());
      return { batch, duplicate, canonical };
    };
    const cancelled = await mergeInto('отменённый', 'cancelled');
    await service.apply(cancelled.batch.id, [], 2, actorId, randomUUID(), key());
    expect((await query<{ canonical_film_id: string }>(`SELECT canonical_film_id FROM films WHERE film_id=$1`, [cancelled.duplicate])).rows[0].canonical_film_id)
      .toBe(String(cancelled.canonical));
    const drafted = await mergeInto('черновик', 'draft');
    const failure = await service.apply(drafted.batch.id, [], 2, actorId, randomUUID(), key())
      .then(() => null, (error: { statusCode?: number; code?: string; details?: { conflicts?: Array<{ reason: string }> } }) => error);
    expect({ statusCode: failure?.statusCode, code: failure?.code }).toEqual({ statusCode: 409, code: 'CATALOG_IMPORT_CONFLICT' });
    expect(failure?.details?.conflicts?.map((c) => c.reason)).toContain('stock_dependency:stock_document_lines');
  });

  it('creates absent film and rejects stale business fingerprint atomically', async () => {
    const newBatch = await draft(`${prefix} отсутствующая`);
    await service.apply(newBatch.id, [], 1, actorId, randomUUID(), key());
    const created = await query<{ created_by: number }>(
      `SELECT film_id,created_by FROM films WHERE film_name=$1 AND vendor_id=$2`,
      [`${prefix} отсутствующая; ${supplierName}`, vendorId]
    );
    expect(created.rows).toHaveLength(1);
    expect(Number(created.rows[0]?.created_by)).toBe(actorId);
    const createdFilmId = Number((created.rows[0] as { film_id: string }).film_id);
    const related = await query(
      `SELECT 1 FROM audit_log a JOIN audit_log_related_entity r USING(audit_id) WHERE a.event='catalog_import.applied' AND a.entity_id=$1 AND r.entity_type='film' AND r.entity_id=$2`,
      [String(newBatch.id), createdFilmId]
    );
    expect(related.rows).toHaveLength(1);
    // Отдельный поставщик: плёнка, созданная выше, не должна становиться кандидатом.
    await newSupplier();
    const existing = await createFilm(`${prefix} fingerprint`);
    const next = await draft(`${prefix} fingerprint target`);
    const row = (await service.rows(next.id, [], {})).items[0]!;
    await service.patch(
      next.id,
      [],
      {
        version: 1,
        actions: [{ type: 'setMatch', filmId: existing, rowId: row.rowId }],
      },
      actorId,
      randomUUID(),
      key()
    );
    await query(`UPDATE films SET film_texture=true WHERE film_id=$1`, [
      existing,
    ]);
    const failure = await service.apply(next.id, [], 2, actorId, randomUUID(), key())
      .then(() => null, (error: { statusCode?: number; code?: string; details?: unknown }) => error);
    expect({ statusCode: failure?.statusCode, code: failure?.code, details: failure?.details }).toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_CONFLICT',
    });
    const untouched = await query<{ film_name: string; is_active: boolean }>(
      `SELECT film_name,is_active FROM films WHERE film_id=$1`,
      [existing]
    );
    expect(untouched.rows[0]).toEqual({
      film_name: `${prefix} fingerprint`,
      is_active: true,
    });
  });

  it('links repeated catalog import without adding same-name history', async () => {
    const name = `${prefix} повторный импорт`;
    const first = await draft(name);
    await service.apply(first.id, [], 1, actorId, randomUUID(), key());
    const film = await query<{ film_id: number }>(
      `SELECT film_id FROM films WHERE film_name=$1 AND vendor_id=$2`,
      [`${name}; ${supplierName}`, vendorId]
    );
    const filmId = Number(film.rows[0]!.film_id);
    const second = await draft(name);
    const matches = await service.matches(second.id, [], {});
    expect(
      matches.items.find((item) => item.filmId === filmId)?.matchStatus
    ).toBe('linked');
    await service.apply(second.id, [], 1, actorId, randomUUID(), key());
    const history = await query(
      `SELECT 1 FROM film_name_history WHERE film_id=$1`,
      [filmId]
    );
    expect(history.rows).toHaveLength(0);
  });

  it('note: a manual edit after apply survives revert; a legacy package (no note snapshot) never touches the note', async () => {
    const film = await createFilm(`${prefix} примечание`);
    const batch = await draft(`${prefix} примечание новое`);
    await matchAndApply(batch.id, [film]);
    const applied = await query<{ note: string | null }>(`SELECT note FROM films WHERE film_id=$1`, [film]);
    expect(applied.rows[0].note).toBe(`Прежнее название: ${prefix} примечание`);
    await query(`UPDATE films SET note='ручная правка' WHERE film_id=$1`, [film]);
    await service.revert(batch.id, [], actorId, randomUUID(), key());
    const reverted = await query<{ film_name: string; note: string | null }>(`SELECT film_name,note FROM films WHERE film_id=$1`, [film]);
    expect(reverted.rows[0]).toEqual({ film_name: `${prefix} примечание`, note: 'ручная правка' });

    // Пакет «до миграции 212»: в снимках нет note — откат работает и примечание не меняет.
    const legacy = await draft(`${prefix} примечание legacy`);
    await matchAndApply(legacy.id, [film]);
    await query(`UPDATE catalog_import_matches SET before=before-'note', after=after-'note' WHERE batch_id=$1`, [legacy.id]);
    await query(`UPDATE films SET note='после применения' WHERE film_id=$1`, [film]);
    await service.revert(legacy.id, [], actorId, randomUUID(), key());
    const legacyReverted = await query<{ film_name: string; note: string | null }>(`SELECT film_name,note FROM films WHERE film_id=$1`, [film]);
    expect(legacyReverted.rows[0]).toEqual({ film_name: `${prefix} примечание`, note: 'после применения' });
  });

  it('reverts latest package first and blocks after manual edit', async () => {
    const filmId = await createFilm(
      `${prefix} revert base`,
      `revert:${randomUUID()}`
    );
    const first = await draft(`${prefix} revert one`);
    const firstRow = (await service.rows(first.id, [], {})).items[0]!;
    await service.patch(
      first.id,
      [],
      {
        version: 1,
        actions: [
          { type: 'setMatch', filmId, rowId: firstRow.rowId },
          { type: 'setCanonical', rowId: firstRow.rowId, filmId },
        ],
      },
      actorId,
      randomUUID(),
      key()
    );
    await service.apply(first.id, [], 2, actorId, randomUUID(), key());
    const second = await draft(`${prefix} revert two`);
    const secondRow = (await service.rows(second.id, [], {})).items[0]!;
    await service.patch(
      second.id,
      [],
      {
        version: 1,
        actions: [
          { type: 'setMatch', filmId, rowId: secondRow.rowId },
          { type: 'setCanonical', rowId: secondRow.rowId, filmId },
        ],
      },
      actorId,
      randomUUID(),
      key()
    );
    await service.apply(second.id, [], 2, actorId, randomUUID(), key());
    await expect(
      service.revert(first.id, [], actorId, randomUUID(), key())
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_REVERT_BLOCKED',
    });
    await service.revert(second.id, [], actorId, randomUUID(), key());
    await query(`UPDATE films SET sort_order=sort_order+1 WHERE film_id=$1`, [
      filmId,
    ]);
    await expect(
      service.revert(first.id, [], actorId, randomUUID(), key())
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_REVERT_BLOCKED',
    });
  });

  async function matchAndApply(batchId: number, filmIds: number[], canonical?: number) {
    const row = (await service.rows(batchId, [], {})).items[0]!;
    // Остальные кандидаты этого пакета (плёнки других сценариев) — «нет соответствия».
    const others: number[] = [];
    for (const status of ['suggested', 'auto']) {
      const page = await service.matches(batchId, [], { status, limit: '500' });
      for (const item of page.items) if (!filmIds.includes(item.filmId)) others.push(item.filmId);
    }
    await service.patch(batchId, [], {
      version: 1,
      actions: [
        ...others.map((filmId) => ({ type: 'setMatch' as const, filmId, rowId: null })),
        ...filmIds.map((filmId) => ({ type: 'setMatch' as const, filmId, rowId: row.rowId })),
        ...(canonical ? [{ type: 'setCanonical' as const, rowId: row.rowId, filmId: canonical }] : []),
      ],
    }, actorId, randomUUID(), key());
    const applyKey = key();
    await service.apply(batchId, [], 2, actorId, randomUUID(), applyKey);
    return applyKey;
  }

  it('writes exactly one outbox event per apply and per revert (R2-1)', async () => {
    const film = await createFilm(`${prefix} outbox base`);
    const batch = await draft(`${prefix} outbox target`);
    const applyKey = await matchAndApply(batch.id, [film]);
    // повтор применения с тем же ключом не пишет второе событие
    await service.apply(batch.id, [], 2, actorId, randomUUID(), applyKey);
    await service.revert(batch.id, [], actorId, randomUUID(), key());
    const events = await query<{ payload_json: { action: string; actorUserId: number; filmIds: { canonical: number[] } }; idempotency_key: string }>(
      `SELECT payload_json, idempotency_key FROM outbox_events
        WHERE event_type='films.catalog_import_changed' AND aggregate_id=$1 ORDER BY created_at, idempotency_key`,
      [String(batch.id)],
    );
    expect(events.rows.map((row) => row.payload_json.action)).toEqual(['applied', 'reverted']);
    expect(events.rows.map((row) => row.idempotency_key)).toEqual([
      `catalog-import:${batch.id}:applied`, `catalog-import:${batch.id}:reverted`,
    ]);
    expect(Number(events.rows[0].payload_json.actorUserId)).toBe(actorId);
    expect(events.rows[0].payload_json.filmIds.canonical).toEqual([film]);
  });

  it('reverts a merge whose canonical took the name of a lower-id member (R2-2)', async () => {
    const name = `${prefix} коллизия`;
    const holder = await createFilm(`${name}; ${supplierName}`); // уже носит итоговое название, меньший ID
    const chosen = await createFilm(`${prefix} коллизия старое`); // канон с большим ID
    const batch = await draft(name);
    await matchAndApply(batch.id, [holder, chosen], chosen);
    const merged = await query<{ film_id: string; film_name: string; canonical_film_id: string | null }>(
      'SELECT film_id, film_name, canonical_film_id FROM films WHERE film_id = ANY($1::bigint[]) ORDER BY film_id', [[holder, chosen]],
    );
    expect(merged.rows.map((row) => [Number(row.film_id), row.film_name, row.canonical_film_id === null ? null : Number(row.canonical_film_id)]))
      .toEqual([[holder, `${name}; ${supplierName}`, chosen], [chosen, `${name}; ${supplierName}`, null]]);
    await service.revert(batch.id, [], actorId, randomUUID(), key());
    const restored = await query<{ film_id: string; film_name: string; canonical_film_id: string | null; is_active: boolean }>(
      'SELECT film_id, film_name, canonical_film_id, is_active FROM films WHERE film_id = ANY($1::bigint[]) ORDER BY film_id', [[holder, chosen]],
    );
    expect(restored.rows.map((row) => [Number(row.film_id), row.film_name, row.canonical_film_id, row.is_active])).toEqual([
      [holder, `${name}; ${supplierName}`, null, true],
      [chosen, `${prefix} коллизия старое`, null, true],
    ]);
  });

  it('does not let an unrelated later package block a revert (R2-3)', async () => {
    const a = await createFilm(`${prefix} независимая А`);
    const b = await createFilm(`${prefix} независимая Б`);
    const p1 = await draft(`${prefix} независимая А новая`);
    await matchAndApply(p1.id, [a]);
    const p2 = await draft(`${prefix} независимая Б новая`);
    await matchAndApply(p2.id, [b]);
    await service.revert(p1.id, [], actorId, randomUUID(), key());
    const rows = await query<{ film_name: string }>('SELECT film_name FROM films WHERE film_id=$1', [a]);
    expect(rows.rows[0].film_name).toBe(`${prefix} независимая А`);
  });
});
