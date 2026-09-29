import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgInventoryRepository } from './pg-inventory-repository';
import { PgWarehouseRepository } from './pg-warehouse-repository';

// Справочник складов: зафиксированные транзакции, два соединения для гонок
// «отключение склада ↔ документ». Только собственная одноразовая БД film_catalog_it_*.
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)('warehouse reference — real PostgreSQL, committed fixtures', { timeout: 60000 }, () => {
  let pool: Pool;
  let connA: PoolClient;
  let connB: PoolClient;
  let watcher: PoolClient;
  let warehousesA: PgWarehouseRepository;
  let stockB: PgInventoryRepository;
  let admin: CurrentUser;
  let actorId: number;
  let filmId: number;
  const tag = 'E2E-Тест-склады-' + randomUUID().slice(0, 8);
  const ctx = (key = randomUUID()) => ({ currentUser: admin, requestId: `req-${randomUUID()}`, idempotencyKey: key });
  const today = new Date().toISOString().slice(0, 10);

  async function waitUntilWaiting(client: PoolClient): Promise<void> {
    const pid = (client as unknown as { processID: number }).processID;
    for (let i = 0; i < 50; i += 1) {
      const rows = await watcher.query<{ n: string }>(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
        [pid],
      );
      if (Number(rows.rows[0].n) > 0) return;
      await sleep(100);
    }
    throw new Error('session never waited on a lock');
  }

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    pool = new Pool({ connectionString: url, max: 3 });
    connA = await pool.connect();
    connB = await pool.connect();
    watcher = await pool.connect();
    const role = await watcher.query<{ role_id: number }>('SELECT min(role_id) AS role_id FROM roles');
    actorId = Number((await watcher.query<{ user_id: string }>(
      `INSERT INTO users (username, email, password_hash, role_id, full_name)
       VALUES ($1, $2, 'test-hash', $3, $4) RETURNING user_id`,
      [`${tag}-admin`, `${randomUUID()}@example.invalid`, role.rows[0].role_id, `${tag} admin`],
    )).rows[0].user_id);
    admin = { id: String(actorId), username: `${tag}-admin`, role: 'admin', roleId: role.rows[0].role_id, permissions: ['inventory.view', 'inventory.manage'] };
    for (const client of [connA, connB, watcher]) await client.query("SELECT set_config('app.user_id', $1, false)", [String(actorId)]);
    const material = await watcher.query<{ material_type_id: number }>('SELECT min(material_type_id) AS material_type_id FROM material_types');
    const vendorId = Number((await watcher.query<{ vendor_id: number }>(
      'INSERT INTO vendors (vendor_name, material_type_id, created_by) VALUES ($1, $2, $3) RETURNING vendor_id',
      [`${tag} поставщик`, material.rows[0].material_type_id, actorId],
    )).rows[0].vendor_id);
    const filmTypeId = Number((await watcher.query<{ film_type_id: number }>('SELECT min(film_type_id) AS film_type_id FROM film_types')).rows[0].film_type_id);
    filmId = Number((await watcher.query<{ film_id: string }>(
      'INSERT INTO films (film_name, vendor_id, film_type_id, created_by, edited_by) VALUES ($1, $2, $3, $4, $4) RETURNING film_id',
      [`${tag} плёнка`, vendorId, filmTypeId, actorId],
    )).rows[0].film_id);
    warehousesA = new PgWarehouseRepository(new CommittedDatabase(connA));
    stockB = new PgInventoryRepository(new CommittedDatabase(connB));
  });

  afterAll(async () => {
    for (const client of [connA, connB, watcher]) client?.release();
    await pool?.end();
  });

  it('creates a warehouse with audit and one outbox event; a replay returns the same result; names are unique ignoring case', async () => {
    const key = randomUUID();
    const refKey1c = randomUUID();
    const created = await warehousesA.create(ctx(key), { name: `${tag} Основной`, refKey1c, workshopId: null, responsibleEmployeeId: null });
    expect(created).toMatchObject({ name: `${tag} Основной`, isActive: true, filmsWithStock: 0, draftDocuments: 0, refKey1c });
    expect(created.version).toEqual(expect.any(String));
    const replay = await warehousesA.create(ctx(key), { name: `${tag} Основной`, refKey1c, workshopId: null, responsibleEmployeeId: null });
    expect(replay).toEqual(created);
    const audit = await watcher.query<{ event: string }>(
      "SELECT event FROM audit_log WHERE entity_type = 'warehouse' AND entity_id = $1", [String(created.warehouseId)],
    );
    expect(audit.rows.map((row) => row.event)).toEqual(['inventory.warehouse_created']);
    const outbox = await watcher.query<{ payload_json: { action: string } }>(
      "SELECT payload_json FROM outbox_events WHERE event_type = 'inventory.warehouse_changed' AND aggregate_id = $1", [String(created.warehouseId)],
    );
    expect(outbox.rows.map((row) => row.payload_json.action)).toEqual(['created']);
    await expectApiError(
      warehousesA.create(ctx(), { name: `  ${tag} основной `.toUpperCase(), refKey1c: randomUUID(), workshopId: null, responsibleEmployeeId: null }),
      409, 'WAREHOUSE_NAME_DUPLICATE',
    );
  });

  it('audits diff and keeps links to the previous workshop and responsible employee', async () => {
    const workshopId = Number((await watcher.query<{ workshop_id: number }>(
      'INSERT INTO workshops (workshop_name, is_active) VALUES ($1, true) RETURNING workshop_id', [`${tag} цех`],
    )).rows[0].workshop_id);
    const employees = await watcher.query<{ employee_id: string }>(
      `INSERT INTO employees (full_name, position, is_active) VALUES ($1, 'Кладовщик', true), ($2, 'Кладовщик', true) RETURNING employee_id`,
      [`${tag} сотрудник А`, `${tag} сотрудник Б`],
    );
    const [employeeA, employeeB] = employees.rows.map((row) => Number(row.employee_id));
    const created = await warehousesA.create(ctx(), { name: `${tag} Аудит`, refKey1c: randomUUID(), workshopId, responsibleEmployeeId: employeeA });
    const changed = await warehousesA.update(ctx(), { warehouseId: created.warehouseId, version: created.version, workshopId: null, responsibleEmployeeId: employeeB });
    expect(changed).toMatchObject({ workshopId: null, responsibleEmployeeId: employeeB });
    const audit = await watcher.query<{ audit_id: string; diff_json: Record<string, { from: unknown; to: unknown }> }>(
      "SELECT audit_id, diff_json FROM audit_log WHERE entity_type = 'warehouse' AND entity_id = $1 AND event = 'inventory.warehouse_updated'",
      [String(created.warehouseId)],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].diff_json.responsibleEmployeeId).toEqual({ from: employeeA, to: employeeB });
    expect(audit.rows[0].diff_json.workshopId).toEqual({ from: workshopId, to: null });
    const related = await watcher.query<{ entity_type: string; entity_id: string }>(
      'SELECT entity_type, entity_id FROM audit_log_related_entity WHERE audit_id = $1 ORDER BY entity_type, entity_id',
      [audit.rows[0].audit_id],
    );
    const links = related.rows.map((row) => `${row.entity_type}:${row.entity_id}`);
    expect(links).toContain(`employee:${employeeA}`);
    expect(links).toContain(`employee:${employeeB}`);
    expect(links).toContain(`workshop:${workshopId}`);
  });

  it('keeps the 1C key unique and required', async () => {
    const refKey1c = randomUUID();
    const first = await warehousesA.create(ctx(), { name: `${tag} Ключ-1`, refKey1c, workshopId: null, responsibleEmployeeId: null });
    await expectApiError(
      warehousesA.create(ctx(), { name: `${tag} Ключ-2`, refKey1c: refKey1c.toUpperCase().toLowerCase(), workshopId: null, responsibleEmployeeId: null }),
      409, 'WAREHOUSE_1C_KEY_TAKEN',
    );
    const second = await warehousesA.create(ctx(), { name: `${tag} Ключ-2`, refKey1c: randomUUID(), workshopId: null, responsibleEmployeeId: null });
    await expectApiError(warehousesA.update(ctx(), { warehouseId: second.warehouseId, version: second.version, refKey1c }), 409, 'WAREHOUSE_1C_KEY_TAKEN');
    // Миграция 205: новая строка без ключа не вставляется.
    await expect(watcher.query("INSERT INTO warehouses (warehouse_name) VALUES ($1)", [`${tag} без ключа`])).rejects.toMatchObject({ code: '23514' });
    expect(first.refKey1c).toBe(refKey1c);
  });

  it('an unlinked legacy warehouse must get a 1C key on any change (migration 205 + WAREHOUSE_1C_KEY_REQUIRED)', async () => {
    const legacy = (await warehousesA.list(true)).find((row) => row.name === 'Склад плёнки');
    expect(legacy?.refKey1c).toBeNull();
    // Прямое изменение строки без ключа отклоняет CHECK (NOT VALID действует на изменяемые строки).
    await watcher.query('BEGIN');
    await expect(watcher.query('UPDATE warehouses SET is_active = is_active WHERE warehouse_id = $1', [legacy!.warehouseId])).rejects.toMatchObject({ code: '23514' });
    await watcher.query('ROLLBACK');
    await expectApiError(
      warehousesA.update(ctx(), { warehouseId: legacy!.warehouseId, version: legacy!.version, workshopId: null, name: 'Склад плёнки ' + tag }),
      422, 'WAREHOUSE_1C_KEY_REQUIRED',
    );
  });

  it('syncs 1C warehouses: links an unlinked warehouse with the same name, creates the rest, skips a taken name; replay is identical', async () => {
    const taken = await warehousesA.create(ctx(), { name: `${tag} Занято`, refKey1c: randomUUID(), workshopId: null, responsibleEmployeeId: null });
    const keys = { legacy: randomUUID(), fresh: randomUUID(), taken: randomUUID() };
    const onec = [
      { refKey: keys.legacy, name: 'Склад плёнки' },
      { refKey: keys.fresh, name: `${tag} Цех из 1С` },
      { refKey: keys.taken, name: `${tag} занято ` },
    ];
    const key = randomUUID();
    const result = await warehousesA.syncFromOnec(ctx(key), async () => onec);
    expect(result.linked.map((row) => [row.name, row.refKey1c])).toEqual([['Склад плёнки', keys.legacy]]);
    expect(result.created.map((row) => [row.name, row.refKey1c])).toEqual([[`${tag} Цех из 1С`, keys.fresh]]);
    expect(result.skipped).toEqual([{ refKey: keys.taken, name: `${tag} занято`, reason: 'name_taken' }]);
    // Повтор с тем же ключом не зависит от зеркала: изменилось или недоступно — тот же ответ.
    expect(await warehousesA.syncFromOnec(ctx(key), async () => [{ refKey: randomUUID(), name: `${tag} появился позже` }])).toEqual(result);
    expect(await warehousesA.syncFromOnec(ctx(key), async () => { throw new Error('mirror unavailable'); })).toEqual(result);
    const again = await warehousesA.syncFromOnec(ctx(), async () => onec);
    expect(again.created).toEqual([]);
    expect(again.linked).toEqual([]);
    const audit = await watcher.query<{ event: string; stage_code: string }>(
      "SELECT event, stage_code FROM audit_log WHERE entity_type = 'warehouse' AND entity_id = $1", [String(result.linked[0].warehouseId)],
    );
    expect(audit.rows).toContainEqual({ event: 'inventory.warehouse_updated', stage_code: 'linked' });
    const created = await watcher.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_log WHERE entity_type = 'warehouse' AND entity_id = $1", [String(result.created[0].warehouseId)],
    );
    expect(Number(created.rows[0].n)).toBe(1);
    void taken;
  });

  it('checks the 1C key only on a new execution: a rejected key leaves no trace, a replay ignores the mirror', async () => {
    const key = randomUUID();
    const input = { name: `${tag} Зеркало`, refKey1c: randomUUID(), workshopId: null, responsibleEmployeeId: null };
    const reject = async (_tx: unknown, _key: string) => { throw Object.assign(new Error('Склад 1С не найден'), { statusCode: 422, code: 'WAREHOUSE_1C_NOT_FOUND' }); };
    await expectApiError(warehousesA.create(ctx(key), input, reject), 422, 'WAREHOUSE_1C_NOT_FOUND');
    expect((await watcher.query('SELECT 1 FROM warehouses WHERE warehouse_name = $1', [input.name])).rows).toHaveLength(0);
    // Тот же ключ после отказа свободен: транзакция с записью идемпотентности откатилась.
    let validated = 0;
    const created = await warehousesA.create(ctx(key), input, async () => { validated += 1; });
    expect(validated).toBe(1);
    // Повтор: склад 1С «исчез» из зеркала — возвращается сохранённый результат, проверка не вызывается.
    expect(await warehousesA.create(ctx(key), input, reject)).toEqual(created);
    const audit = await watcher.query("SELECT 1 FROM audit_log WHERE entity_type = 'warehouse' AND entity_id = $1", [String(created.warehouseId)]);
    expect(audit.rows).toHaveLength(1);
  });

  it('rollback path: dropping the 205 check lets the previous backend insert a warehouse without a 1C key', async () => {
    await watcher.query('BEGIN');
    try {
      await watcher.query('ALTER TABLE public.warehouses DROP CONSTRAINT IF EXISTS chk_warehouses_ref_key_1c_required');
      const legacy = await watcher.query('INSERT INTO warehouses (warehouse_name, workshop_id, responsible_employee_id, is_active, created_by, edited_by) VALUES ($1, NULL, NULL, true, $2, $2) RETURNING warehouse_id', [`${tag} старый backend`, actorId]);
      expect(legacy.rows).toHaveLength(1);
    } finally {
      await watcher.query('ROLLBACK');
    }
    const check = await watcher.query("SELECT convalidated FROM pg_constraint WHERE conname = 'chk_warehouses_ref_key_1c_required'");
    expect(check.rows).toHaveLength(1);
  });

  it('renames with the current version and rejects a stale version', async () => {
    const created = await warehousesA.create(ctx(), { name: `${tag} Цеховой`, refKey1c: randomUUID(), workshopId: null, responsibleEmployeeId: null });
    const renamed = await warehousesA.update(ctx(), { warehouseId: created.warehouseId, version: created.version, name: `${tag} Цеховой-2` });
    expect(renamed.name).toBe(`${tag} Цеховой-2`);
    expect(renamed.version).not.toBe(created.version);
    await expectApiError(
      warehousesA.update(ctx(), { warehouseId: created.warehouseId, version: created.version, name: `${tag} Цеховой-3` }),
      409, 'WAREHOUSE_VERSION_CONFLICT',
    );
    const audit = await watcher.query<{ event: string; diff: unknown }>(
      "SELECT event FROM audit_log WHERE entity_type = 'warehouse' AND entity_id = $1 ORDER BY created_at, event",
      [String(created.warehouseId)],
    );
    expect(audit.rows.map((row) => row.event).sort()).toEqual(['inventory.warehouse_created', 'inventory.warehouse_updated']);
  });

  it('refuses to deactivate a warehouse with stock or drafts; an empty one is deactivated and takes no documents', async () => {
    const wh = await warehousesA.create(ctx(), { name: `${tag} Отключаемый`, refKey1c: randomUUID(), workshopId: null, responsibleEmployeeId: null });
    const receipt = await stockB.createManual(ctx(), {
      docType: 'receipt', warehouseId: wh.warehouseId, docDate: today, orderId: null, comment: tag,
      lines: [{ filmId, quantity: 4 }], post: true, allowNegative: false,
    });
    expect(receipt.status).toBe('posted');
    let current = (await warehousesA.list(true)).find((row) => row.warehouseId === wh.warehouseId)!;
    expect(current).toMatchObject({ filmsWithStock: 1, totalQuantity: 4 });
    await expectApiError(warehousesA.update(ctx(), { warehouseId: wh.warehouseId, version: current.version, isActive: false }), 409, 'WAREHOUSE_HAS_STOCK');

    await stockB.createManual(ctx(), {
      docType: 'writeoff', warehouseId: wh.warehouseId, docDate: today, orderId: null, comment: tag,
      lines: [{ filmId, quantity: 4 }], post: true, allowNegative: false,
    });
    const draft = await stockB.createManual(ctx(), {
      docType: 'receipt', warehouseId: wh.warehouseId, docDate: today, orderId: null, comment: tag,
      lines: [{ filmId, quantity: 1 }], post: false, allowNegative: false,
    });
    current = (await warehousesA.list(true)).find((row) => row.warehouseId === wh.warehouseId)!;
    expect(current).toMatchObject({ filmsWithStock: 0, draftDocuments: 1 });
    await expectApiError(warehousesA.update(ctx(), { warehouseId: wh.warehouseId, version: current.version, isActive: false }), 409, 'WAREHOUSE_HAS_DRAFTS');

    await stockB.cancel(ctx(), draft.documentId, draft.version);
    current = (await warehousesA.list(true)).find((row) => row.warehouseId === wh.warehouseId)!;
    const off = await warehousesA.update(ctx(), { warehouseId: wh.warehouseId, version: current.version, isActive: false });
    expect(off.isActive).toBe(false);
    expect((await warehousesA.list(false)).some((row) => row.warehouseId === wh.warehouseId)).toBe(false);
    await expectApiError(stockB.createManual(ctx(), {
      docType: 'receipt', warehouseId: wh.warehouseId, docDate: today, orderId: null, comment: tag,
      lines: [{ filmId, quantity: 1 }], post: true, allowNegative: false,
    }), 422, 'WAREHOUSE_NOT_FOUND');
    const events = await watcher.query<{ event: string }>(
      "SELECT event FROM audit_log WHERE entity_type = 'warehouse' AND entity_id = $1", [String(wh.warehouseId)],
    );
    expect(events.rows.map((row) => row.event)).toContain('inventory.warehouse_deactivated');
  });

  it('race: a document started while the warehouse is being deactivated is rejected after the deactivation commits', async () => {
    const wh = await warehousesA.create(ctx(), { name: `${tag} Гонка-1`, refKey1c: randomUUID(), workshopId: null, responsibleEmployeeId: null });
    // Отключение держит строку склада FOR UPDATE и ещё не зафиксировано.
    await connA.query('BEGIN');
    await connA.query('SELECT warehouse_id FROM warehouses WHERE warehouse_id = $1 FOR UPDATE', [wh.warehouseId]);
    await connA.query('UPDATE warehouses SET is_active = false WHERE warehouse_id = $1', [wh.warehouseId]);
    const pending = stockB.createManual(ctx(), {
      docType: 'receipt', warehouseId: wh.warehouseId, docDate: today, orderId: null, comment: tag,
      lines: [{ filmId, quantity: 2 }], post: true, allowNegative: false,
    }).then(() => null, (error: unknown) => error);
    await waitUntilWaiting(connB);
    await connA.query('COMMIT');
    expect(await pending).toMatchObject({ statusCode: 422, code: 'WAREHOUSE_NOT_FOUND' });
    const docs = await watcher.query('SELECT 1 FROM stock_documents WHERE warehouse_id = $1', [wh.warehouseId]);
    expect(docs.rows).toHaveLength(0);
  });

  it('race: deactivation waits for a document in progress and then refuses because of its draft', async () => {
    const wh = await warehousesA.create(ctx(), { name: `${tag} Гонка-2`, refKey1c: randomUUID(), workshopId: null, responsibleEmployeeId: null });
    const version = wh.version;
    // Документ (как в assertWarehouse) держит склад FOR KEY SHARE и вставляет черновик.
    await connB.query('BEGIN');
    await connB.query('SELECT 1 FROM warehouses WHERE warehouse_id = $1 AND is_active = true FOR KEY SHARE', [wh.warehouseId]);
    await connB.query(
      `INSERT INTO stock_documents (doc_type, status, warehouse_id, doc_date, source, created_by, request_id, correlation_id)
       VALUES ('receipt', 'draft', $1, CURRENT_DATE, 'manual', $2, $3, $3)`,
      [wh.warehouseId, actorId, `req-${randomUUID()}`],
    );
    const pending = warehousesA.update(ctx(), { warehouseId: wh.warehouseId, version, isActive: false })
      .then(() => null, (error: unknown) => error);
    await waitUntilWaiting(connA);
    await connB.query('COMMIT');
    expect(await pending).toMatchObject({ statusCode: 409, code: 'WAREHOUSE_HAS_DRAFTS' });
    const row = await watcher.query<{ is_active: boolean }>('SELECT is_active FROM warehouses WHERE warehouse_id = $1', [wh.warehouseId]);
    expect(row.rows[0].is_active).toBe(true);
  });
});
