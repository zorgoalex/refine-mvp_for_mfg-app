import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { OnecCatalogReader } from '../../onec-agent/onec-catalog-reader';
import { CatalogImportService } from '../../reference-catalog-import/application/catalog-import.service';
import { PgInventoryRepository } from './pg-inventory-repository';

// Межмодульные гонки «склад ↔ импорт каталога» (code review R1-6/R2-4/R2-5): два соединения,
// зафиксированные транзакции, только собственная одноразовая БД film_catalog_it_*.
const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)('inventory ↔ catalog import races — real PostgreSQL', { timeout: 90000 }, () => {
  let pool: Pool;
  let connA: PoolClient;
  let connB: PoolClient;
  let watcher: PoolClient;
  let stockA: PgInventoryRepository;
  let stockB: PgInventoryRepository;
  let catalogB: CatalogImportService;
  let admin: CurrentUser;
  let actorId: number;
  let warehouseId: number;
  let vendorId: number;
  let filmTypeId: number;
  const tag = 'E2E-Тест-гонки-' + randomUUID().slice(0, 8);
  const supplier = `${tag} поставщик`;
  const ctx = () => ({ currentUser: admin, requestId: `req-${randomUUID()}`, idempotencyKey: randomUUID() });

  async function film(name: string): Promise<number> {
    const rows = await watcher.query<{ film_id: string }>(
      'INSERT INTO films (film_name, vendor_id, film_type_id, created_by, edited_by) VALUES ($1, $2, $3, $4, $4) RETURNING film_id',
      [name, vendorId, filmTypeId, actorId],
    );
    return Number(rows.rows[0].film_id);
  }

  async function blockedPids(): Promise<number> {
    const rows = await watcher.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );
    return Number(rows.rows[0].n);
  }

  async function waitForLockWait(): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      if ((await blockedPids()) > 0) return;
      await sleep(100);
    }
    throw new Error('second session never waited on a lock');
  }

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    pool = new Pool({ connectionString: url, max: 3 });
    connA = await pool.connect();
    connB = await pool.connect();
    watcher = await pool.connect();
    const role = await watcher.query<{ role_id: number }>('SELECT min(role_id) AS role_id FROM roles');
    const user = await watcher.query<{ user_id: string }>(
      `INSERT INTO users (username, email, password_hash, role_id, full_name)
       VALUES ($1, $2, 'test-hash', $3, $4) RETURNING user_id`,
      [`${tag}-admin`, `${randomUUID()}@example.invalid`, role.rows[0].role_id, `${tag} admin`],
    );
    actorId = Number(user.rows[0].user_id);
    admin = { id: String(actorId), username: `${tag}-admin`, role: 'admin', roleId: role.rows[0].role_id, permissions: ['inventory.view', 'inventory.manage', 'orders.view'] };
    for (const client of [connA, connB, watcher]) await client.query("SELECT set_config('app.user_id', $1, false)", [String(actorId)]);
    const material = await watcher.query<{ material_type_id: number }>('SELECT min(material_type_id) AS material_type_id FROM material_types');
    vendorId = Number((await watcher.query<{ vendor_id: number }>(
      'INSERT INTO vendors (vendor_name, material_type_id, created_by) VALUES ($1, $2, $3) RETURNING vendor_id',
      [supplier, material.rows[0].material_type_id, actorId],
    )).rows[0].vendor_id);
    filmTypeId = Number((await watcher.query<{ film_type_id: number }>('SELECT min(film_type_id) AS film_type_id FROM film_types')).rows[0].film_type_id);
    warehouseId = Number((await watcher.query<{ warehouse_id: number }>("SELECT warehouse_id FROM warehouses WHERE warehouse_name = 'Склад плёнки'")).rows[0].warehouse_id);
    stockA = new PgInventoryRepository(new CommittedDatabase(connA));
    stockB = new PgInventoryRepository(new CommittedDatabase(connB));
    catalogB = new CatalogImportService(new CommittedDatabase(connB), {} as unknown as OnecCatalogReader);
  });

  afterAll(async () => {
    for (const client of [connA, connB, watcher]) client?.release();
    await pool?.end();
  });

  async function draftMerge(name: string, members: number[], canonical: number) {
    const batch = await catalogB.create({
      kind: 'films', source: 'file', fileName: 'race.xlsx', fileSha256: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      sheetName: 'Пленки',
      rows: [{ rowNo: 2, nameOriginal: name, nameFull: `${name}; ${supplier}`, supplier, nomenclatureType: 'Запас', unit: 'пог. м', nomenclatureCategory: 'ПЛЕНКА ПВХ ДЛЯ МДФ' }],
    }, actorId, randomUUID(), randomUUID());
    const row = (await catalogB.rows(batch.id, [], {})).items[0]!;
    const others: number[] = [];
    for (const status of ['suggested', 'auto']) {
      for (const item of (await catalogB.matches(batch.id, [], { status, limit: '500' })).items) {
        if (!members.includes(item.filmId)) others.push(item.filmId);
      }
    }
    await catalogB.patch(batch.id, [], {
      version: 1,
      actions: [
        ...others.map((filmId) => ({ type: 'setMatch' as const, filmId, rowId: null })),
        ...members.map((filmId) => ({ type: 'setMatch' as const, filmId, rowId: row.rowId })),
        { type: 'setCanonical' as const, rowId: row.rowId, filmId: canonical },
      ],
    }, actorId, randomUUID(), randomUUID());
    return batch.id;
  }

  it('stock first: catalog apply waits, then refuses to merge a film that got a stock reference', async () => {
    const x = await film(`${tag} склад-первым икс`);
    const y = await film(`${tag} склад-первым игрек`);
    const batchId = await draftMerge(`${tag} склад-первым`, [x, y], y);
    // Сессия A: складской писатель держит FOR SHARE на X и сохраняет строку документа (не закоммичено).
    await connA.query('BEGIN');
    await connA.query('SELECT film_id FROM films WHERE film_id = $1 FOR SHARE', [x]);
    const doc = await connA.query<{ document_id: string }>(
      `INSERT INTO stock_documents (doc_type, status, warehouse_id, doc_date, source, file_name, file_sha256, sheet_name, created_by, request_id)
       VALUES ('receipt', 'draft', $1, '2026-09-29', 'import', 'race.xlsx', $2, 'Лист', $3, 'race') RETURNING document_id`,
      [warehouseId, 'c'.repeat(64), actorId],
    );
    await connA.query(
      `INSERT INTO stock_document_lines (document_id, line_no, raw_name, film_id, quantity, match_status, quantity_status)
       VALUES ($1, 1, 'race', $2, 1.1, 'manual', 'confirmed')`,
      [doc.rows[0].document_id, x],
    );
    const apply = catalogB.apply(batchId, [], 2, actorId, randomUUID(), randomUUID())
      .then(() => null, (error: { statusCode?: number; code?: string; details?: { conflicts?: Array<{ reason: string }> } }) => error);
    await waitForLockWait();
    await connA.query('COMMIT');
    const failure = await apply;
    expect({ statusCode: failure?.statusCode, code: failure?.code }).toEqual({ statusCode: 409, code: 'CATALOG_IMPORT_CONFLICT' });
    const state = await watcher.query<{ canonical_film_id: string | null; is_active: boolean }>('SELECT canonical_film_id, is_active FROM films WHERE film_id = $1', [x]);
    expect(state.rows[0]).toEqual({ canonical_film_id: null, is_active: true });
  });

  it('catalog first: stock import waits, then does not reference the merged duplicate', async () => {
    const x = await film(`${tag} каталог-первым икс`);
    const y = await film(`${tag} каталог-первым игрек`);
    await watcher.query(
      `INSERT INTO stock_import_aliases (source_name_norm, source_supplier_norm, film_id, created_by) VALUES ($1, $2, $3, $4)`,
      [`${tag} алиас`.toLowerCase(), supplier.toLowerCase(), x, actorId],
    );
    // Сессия B: слияние X → Y держит FOR NO KEY UPDATE (не закоммичено).
    await connB.query('BEGIN');
    await connB.query("SET LOCAL erp.film_catalog = 'on'");
    await connB.query('SELECT film_id FROM films WHERE film_id = ANY($1::bigint[]) ORDER BY film_id FOR NO KEY UPDATE', [[x, y]]);
    await connB.query('UPDATE films SET canonical_film_id = $1, is_active = false WHERE film_id = $2', [y, x]);
    const importing = stockA.createImport(ctx(), {
      docType: 'receipt', warehouseId, docDate: '2026-09-29', fileName: 'race.xlsx', fileSha256: 'd'.repeat(64), sheetName: 'Лист',
      rows: [{ rowNo: 2, name: `${tag} алиас 2,1`, supplier, quantity: null }],
    });
    await waitForLockWait();
    await connB.query('COMMIT');
    const draft = await importing;
    expect(draft.lines[0]).toMatchObject({ filmId: null, matchStatus: 'unmatched' });
    expect(draft.lines[0].issue).toContain('объединённую');
  });

  it('posts two documents with the same aliases in opposite order on different warehouses without deadlock', async () => {
    const p = await film(`${tag} алиас-пэ`);
    const q = await film(`${tag} алиас-ку`);
    const second = Number((await watcher.query<{ warehouse_id: number }>(
      'INSERT INTO warehouses (warehouse_name, is_active, ref_key_1c) VALUES ($1, true, gen_random_uuid()) RETURNING warehouse_id', [`${tag} склад 2`],
    )).rows[0].warehouse_id);
    const makeDraft = async (repo: PgInventoryRepository, wh: number, names: string[], films: number[]) => {
      let doc = await repo.createImport(ctx(), {
        docType: 'receipt', warehouseId: wh, docDate: '2026-09-29', fileName: 'alias.xlsx', fileSha256: randomUUID().replaceAll('-', '').padEnd(64, 'e').slice(0, 64), sheetName: 'Лист',
        rows: names.map((name, index) => ({ rowNo: index + 2, name, supplier, quantity: '1,5' })),
      });
      for (const [index, line] of doc.lines.entries()) {
        doc = await repo.updateLine(ctx(), { documentId: doc.documentId, lineId: line.lineId, version: doc.version, filmId: films[index] });
      }
      return doc;
    };
    const d1 = await makeDraft(stockA, warehouseId, [`${tag} первый`, `${tag} второй`], [p, q]);
    const d2 = await makeDraft(stockB, second, [`${tag} второй`, `${tag} первый`], [q, p]);
    const [r1, r2] = await Promise.all([
      stockA.post(ctx(), d1.documentId, d1.version, false),
      stockB.post(ctx(), d2.documentId, d2.version, false),
    ]);
    expect([r1.status, r2.status]).toEqual(['posted', 'posted']);
    const aliases = await watcher.query('SELECT 1 FROM stock_import_aliases WHERE film_id = ANY($1::bigint[])', [[p, q]]);
    expect(aliases.rows).toHaveLength(2);
  });
});
