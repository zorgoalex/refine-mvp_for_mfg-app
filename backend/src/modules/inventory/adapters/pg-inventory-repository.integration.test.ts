import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgInventoryRepository } from './pg-inventory-repository';

// Committed fixtures + separate connections for races: ONLY an owned disposable
// database "film_catalog_it_*" created and dropped by the Ф1/Ф2 runner.
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

async function expectApiError(promise: Promise<unknown>, status: number, code: string): Promise<Record<string, unknown> | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { statusCode?: number; code?: string; details?: Record<string, unknown> };
    expect({ status: e.statusCode, code: e.code }).toEqual({ status, code });
    return e.details;
  }
  throw new Error(`expected ${status} ${code}`);
}

describe.skipIf(!url)('inventory repository — real PostgreSQL, committed fixtures', { timeout: 60000 }, () => {
  let pool: Pool;
  let connA: PoolClient;
  let connB: PoolClient;
  let repoA: PgInventoryRepository;
  let repoB: PgInventoryRepository;
  let admin: CurrentUser;
  let warehouseId: number;
  let vendorName: string;
  const tag = 'E2E-Тест-склад-' + randomUUID().slice(0, 8);
  const films: Record<'A' | 'B' | 'D' | 'S', number> = { A: 0, B: 0, D: 0, S: 0 };
  const ctx = (key = randomUUID()) => ({ currentUser: admin, requestId: `req-${randomUUID()}`, idempotencyKey: key });
  const balance = async (filmId: number) => {
    const rows = await connA.query<{ quantity: string }>('SELECT quantity FROM stock_balances WHERE warehouse_id = $1 AND film_id = $2', [warehouseId, filmId]);
    return rows.rows[0] ? Number(rows.rows[0].quantity) : null;
  };

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    pool = new Pool({ connectionString: url, max: 2 });
    connA = await pool.connect();
    connB = await pool.connect();
    repoA = new PgInventoryRepository(new CommittedDatabase(connA));
    repoB = new PgInventoryRepository(new CommittedDatabase(connB));
    const role = await connA.query<{ role_id: number }>("SELECT role_id FROM roles WHERE role_code = 'admin' OR role_name ILIKE 'admin%' ORDER BY role_id LIMIT 1").catch(
      () => connA.query<{ role_id: number }>('SELECT min(role_id) AS role_id FROM roles'),
    );
    const user = await connA.query<{ user_id: string }>(
      `INSERT INTO users (username, email, password_hash, role_id, full_name)
       VALUES ($1, $2, 'test-hash', $3, $4) RETURNING user_id`,
      [`${tag}-admin`, `${randomUUID()}@example.invalid`, role.rows[0].role_id, `${tag} admin`],
    );
    admin = {
      id: user.rows[0].user_id, username: `${tag}-admin`, role: 'admin', roleId: role.rows[0].role_id,
      permissions: ['inventory.view', 'inventory.manage', 'orders.view'],
    };
    await connA.query("SELECT set_config('app.user_id', $1, false)", [admin.id]);
    const warehouse = await connA.query<{ warehouse_id: number }>("SELECT warehouse_id FROM warehouses WHERE is_active ORDER BY warehouse_id LIMIT 1");
    warehouseId = Number(warehouse.rows[0].warehouse_id);
    const vendor = await connA.query<{ vendor_id: number; vendor_name: string }>("SELECT vendor_id, vendor_name FROM vendors WHERE vendor_name = 'ADILET'");
    vendorName = vendor.rows[0].vendor_name;
    const filmType = await connA.query<{ film_type_id: number }>('SELECT min(film_type_id) AS film_type_id FROM film_types');
    const insertFilm = async (name: string) => (await connA.query<{ film_id: string }>(
      'INSERT INTO films (film_name, vendor_id, film_type_id, created_by, edited_by) VALUES ($1, $2, $3, $4, $4) RETURNING film_id',
      [name, vendor.rows[0].vendor_id, filmType.rows[0].film_type_id, admin.id],
    )).rows[0].film_id;
    films.A = Number(await insertFilm(`${tag} Брауни; ADILET`));
    films.B = Number(await insertFilm(`${tag} Чага; ADILET`));
    films.D = Number(await insertFilm(`${tag} брауни адилет`));
    films.S = Number(await insertFilm(`${tag} Санд сноу 0,18; ADILET`));
    await connA.query('BEGIN');
    await connA.query("SET LOCAL erp.film_catalog = 'on'");
    await connA.query('UPDATE films SET canonical_film_id = $1, is_active = false WHERE film_id = $2', [films.A, films.D]);
    await connA.query('COMMIT');
  });

  afterAll(async () => {
    connA?.release();
    connB?.release();
    await pool?.end();
  });

  it('posts a manual receipt, records movement, audit and one outbox event', async () => {
    const key = randomUUID();
    const doc = await repoA.createManual(ctx(key), {
      docType: 'receipt', warehouseId, docDate: '2026-09-29', orderId: null, comment: 'E2E',
      lines: [{ filmId: films.A, quantity: 5.2 }, { filmId: films.A, quantity: 2.1 }], post: true, allowNegative: false,
    });
    expect(doc.status).toBe('posted');
    expect(await balance(films.A)).toBe(7.3);
    expect(doc.movements).toEqual([expect.objectContaining({ filmId: films.A, delta: 7.3, balanceBefore: 0, balanceAfter: 7.3 })]);
    const outbox = await connA.query('SELECT 1 FROM outbox_events WHERE idempotency_key = $1', [`inventory:document:${doc.documentId}:posted`]);
    expect(outbox.rows).toHaveLength(1);
    const audit = await connA.query<{ event: string }>(
      "SELECT event FROM audit_log WHERE entity_type = 'stock_document' AND entity_id = $1 ORDER BY audit_id",
      [String(doc.documentId)],
    );
    // audit_id — UUID: сравниваем набор событий без порядка.
    expect(audit.rows.map((row) => row.event).sort()).toEqual(['inventory.document_created', 'inventory.document_posted']);

    // Повтор с тем же ключом — тот же ответ, без второго движения.
    const replay = await repoA.createManual(ctx(key), {
      docType: 'receipt', warehouseId, docDate: '2026-09-29', orderId: null, comment: 'E2E',
      lines: [{ filmId: films.A, quantity: 5.2 }, { filmId: films.A, quantity: 2.1 }], post: true, allowNegative: false,
    });
    expect(replay.documentId).toBe(doc.documentId);
    expect(await balance(films.A)).toBe(7.3);
    await expectApiError(repoA.createManual(ctx(key), {
      docType: 'receipt', warehouseId, docDate: '2026-09-29', orderId: null, comment: 'E2E',
      lines: [{ filmId: films.A, quantity: 1 }], post: true, allowNegative: false,
    }), 422, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('rejects a duplicate (merged) film', async () => {
    await expectApiError(repoA.createManual(ctx(), {
      docType: 'receipt', warehouseId, docDate: '2026-09-29', orderId: null, comment: null,
      lines: [{ filmId: films.D, quantity: 1 }], post: true, allowNegative: false,
    }), 422, 'STOCK_FILM_NOT_CANONICAL');
  });

  it('requires allowNegative to go below zero; inventory sets the counted value', async () => {
    const details = await expectApiError(repoA.createManual(ctx(), {
      docType: 'writeoff', warehouseId, docDate: '2026-09-29', orderId: null, comment: null,
      lines: [{ filmId: films.A, quantity: 10 }], post: true, allowNegative: false,
    }), 409, 'STOCK_WOULD_GO_NEGATIVE');
    expect(details?.negativeAfter).toEqual([expect.objectContaining({ filmId: films.A, after: -2.7 })]);
    expect(await balance(films.A)).toBe(7.3);
    await repoA.createManual(ctx(), {
      docType: 'writeoff', warehouseId, docDate: '2026-09-29', orderId: null, comment: null,
      lines: [{ filmId: films.A, quantity: 10 }], post: true, allowNegative: true,
    });
    expect(await balance(films.A)).toBe(-2.7);
    const inventory = await repoA.createManual(ctx(), {
      docType: 'inventory', warehouseId, docDate: '2026-09-29', orderId: null, comment: null,
      lines: [{ filmId: films.A, quantity: 3.1 }], post: true, allowNegative: false,
    });
    expect(inventory.movements[0]).toMatchObject({ movementType: 'inventory_adjustment', delta: 5.8, balanceAfter: 3.1 });
  });

  it('imports a draft, blocks unresolved lines, resolves and posts; stale version is rejected', async () => {
    const draft = await repoA.createImport(ctx(), {
      docType: 'receipt', warehouseId, docDate: '2026-09-29', fileName: 'E2E.xlsx', fileSha256: 'b'.repeat(64), sheetName: 'Исходные данные',
      rows: [
        { rowNo: 2, name: `${tag} брауни адилет 2,1`, supplier: vendorName, quantity: null },
        { rowNo: 3, name: `${tag} Чага 101,1`, supplier: vendorName, quantity: null },
        { rowNo: 4, name: 'Совсем другое 1,1', supplier: vendorName, quantity: null },
      ],
    });
    expect(draft.lines.map((line) => [line.matchStatus, line.quantityStatus])).toEqual([
      ['exact', 'ok'], [expect.stringMatching(/exact|suggested/), 'needs_review'], ['unmatched', 'ok'],
    ]);
    expect(draft.lines[0].filmId).toBe(films.A);
    await expectApiError(repoA.post(ctx(), draft.documentId, draft.version, false), 422, 'STOCK_DOCUMENT_UNRESOLVED');
    await expectApiError(repoA.post(ctx(), draft.documentId, draft.version + 5, false), 409, 'STOCK_DOCUMENT_STALE');
    let current = await repoA.updateLine(ctx(), { documentId: draft.documentId, lineId: draft.lines[2].lineId, version: draft.version, skip: true });
    // Выбор плёнки не подтверждает подозрительное количество.
    current = await repoA.updateLine(ctx(), { documentId: draft.documentId, lineId: draft.lines[1].lineId, version: current.version, filmId: films.B });
    await expectApiError(repoA.post(ctx(), draft.documentId, current.version, false), 422, 'STOCK_DOCUMENT_UNRESOLVED');
    current = await repoA.updateLine(ctx(), { documentId: draft.documentId, lineId: draft.lines[1].lineId, version: current.version, quantity: 10.1 });
    const posted = await repoA.post(ctx(), draft.documentId, current.version, false);
    expect(posted.status).toBe('posted');
    expect(posted.previousPostedDocumentId).toBeNull();
    // Повторная загрузка того же файла (тот же SHA) — предупреждение со ссылкой на проведённый документ.
    const again = await repoA.createImport(ctx(), {
      docType: 'receipt', warehouseId, docDate: '2026-09-29', fileName: 'E2E.xlsx', fileSha256: 'b'.repeat(64), sheetName: 'Исходные данные',
      rows: [{ rowNo: 2, name: `${tag} брауни адилет 2,1`, supplier: vendorName, quantity: null }],
    });
    expect(again.previousPostedDocumentId).toBe(draft.documentId);
    const alias = await connA.query('SELECT film_id FROM stock_import_aliases WHERE film_id = $1', [films.B]);
    expect(alias.rows.length).toBeGreaterThan(0);
  });

  it('serializes concurrent write-offs and does not deadlock on crossed film order', async () => {
    await repoA.createManual(ctx(), {
      docType: 'inventory', warehouseId, docDate: '2026-09-29', orderId: null, comment: null,
      lines: [{ filmId: films.A, quantity: 10 }, { filmId: films.B, quantity: 10 }], post: true, allowNegative: false,
    });
    const [first, second] = await Promise.all([
      repoA.createManual(ctx(), { docType: 'writeoff', warehouseId, docDate: '2026-09-29', orderId: null, comment: null,
        lines: [{ filmId: films.A, quantity: 1 }, { filmId: films.B, quantity: 2 }], post: true, allowNegative: false }),
      repoB.createManual(ctx(), { docType: 'writeoff', warehouseId, docDate: '2026-09-29', orderId: null, comment: null,
        lines: [{ filmId: films.B, quantity: 3 }, { filmId: films.A, quantity: 4 }], post: true, allowNegative: false }),
    ]);
    expect([first.status, second.status]).toEqual(['posted', 'posted']);
    expect(await balance(films.A)).toBe(5);
    expect(await balance(films.B)).toBe(5);
    const chain = await connA.query<{ balance_before: string; balance_after: string }>(
      'SELECT balance_before, balance_after FROM stock_movements WHERE film_id = $1 ORDER BY movement_id DESC LIMIT 2',
      [films.A],
    );
    expect(Number(chain.rows[1].balance_after)).toBe(Number(chain.rows[0].balance_before));
  });
});
