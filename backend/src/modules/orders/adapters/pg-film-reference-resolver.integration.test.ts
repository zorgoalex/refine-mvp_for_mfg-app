import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import { resolveFilmReferencesForWrite } from './pg-film-reference-resolver';

// Запись заказа ↔ слияние и откат каталога (code review R3-2): канон сменился между чтением
// и блокировкой — команда отклоняется 409 без повторной блокировки в той же транзакции.
// Только собственная одноразовая БД film_catalog_it_*.
const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)('film reference resolution vs catalog merge/revert — real PostgreSQL', { timeout: 60000 }, () => {
  let pool: Pool;
  let order: PoolClient;
  let merge: PoolClient;
  let revert: PoolClient;
  let watcher: PoolClient;
  let actorId: number;
  let vendorId: number;
  let filmTypeId: number;
  const tag = 'E2E-Тест-канон-' + randomUUID().slice(0, 8);

  const txOf = (client: PoolClient): TransactionClient => ({
    raw: client,
    query: (sql, params = []) => client.query(sql, [...params]),
  });

  async function film(name: string): Promise<number> {
    const rows = await watcher.query<{ film_id: string }>(
      'INSERT INTO films (film_name, vendor_id, film_type_id, created_by, edited_by) VALUES ($1, $2, $3, $4, $4) RETURNING film_id',
      [name, vendorId, filmTypeId, actorId],
    );
    return Number(rows.rows[0].film_id);
  }

  async function lockWaiters(): Promise<number[]> {
    const rows = await watcher.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );
    return rows.rows.map((row) => row.pid);
  }

  async function waitUntilWaiting(client: PoolClient): Promise<void> {
    const target = (client as unknown as { processID: number }).processID;
    for (let i = 0; i < 50; i += 1) {
      if ((await lockWaiters()).includes(target)) return;
      await sleep(100);
    }
    throw new Error('session never waited on a lock');
  }

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    pool = new Pool({ connectionString: url, max: 4 });
    order = await pool.connect();
    merge = await pool.connect();
    revert = await pool.connect();
    watcher = await pool.connect();
    const role = await watcher.query<{ role_id: number }>('SELECT min(role_id) AS role_id FROM roles');
    actorId = Number((await watcher.query<{ user_id: string }>(
      `INSERT INTO users (username, email, password_hash, role_id, full_name)
       VALUES ($1, $2, 'test-hash', $3, $4) RETURNING user_id`,
      [`${tag}-admin`, `${randomUUID()}@example.invalid`, role.rows[0].role_id, `${tag} admin`],
    )).rows[0].user_id);
    for (const client of [order, merge, revert, watcher]) {
      await client.query("SELECT set_config('app.user_id', $1, false)", [String(actorId)]);
    }
    const material = await watcher.query<{ material_type_id: number }>('SELECT min(material_type_id) AS material_type_id FROM material_types');
    vendorId = Number((await watcher.query<{ vendor_id: number }>(
      'INSERT INTO vendors (vendor_name, material_type_id, created_by) VALUES ($1, $2, $3) RETURNING vendor_id',
      [`${tag} поставщик`, material.rows[0].material_type_id, actorId],
    )).rows[0].vendor_id);
    filmTypeId = Number((await watcher.query<{ film_type_id: number }>('SELECT min(film_type_id) AS film_type_id FROM film_types')).rows[0].film_type_id);
  });

  afterAll(async () => {
    for (const client of [order, merge, revert, watcher]) client?.release();
    await pool?.end();
  });

  it('rejects with 409 instead of re-locking when the film is merged while the order waits for it', async () => {
    // Канон слияния создаётся первым (меньший film_id), как в сценарии R3-2 «100 → 50».
    const target = await film(`${tag} новый канон`);
    const ordered = await film(`${tag} выбран в заказе`);

    await merge.query('BEGIN');
    await merge.query("SET LOCAL erp.film_catalog = 'on'");
    await merge.query('SELECT film_id FROM films WHERE film_id = ANY($1::bigint[]) ORDER BY film_id FOR NO KEY UPDATE', [[target, ordered]]);
    await merge.query('UPDATE films SET canonical_film_id = $1, is_active = false WHERE film_id = $2', [target, ordered]);

    // Заказ видит «ordered» каноном (слияние не зафиксировано) и ждёт блокировку строки.
    await order.query('BEGIN');
    await order.query("SET LOCAL lock_timeout = '10s'");
    const pending = resolveFilmReferencesForWrite(txOf(order), null, { headerFilmId: ordered, details: [] })
      .then(() => null, (error: unknown) => error);
    await waitUntilWaiting(order);

    // Откат каталога ждёт блокировку канона, пока слияние не зафиксировано.
    await revert.query('BEGIN');
    await revert.query("SET LOCAL lock_timeout = '10s'");
    const revertTarget = revert.query('SELECT film_id FROM films WHERE film_id = $1 FOR NO KEY UPDATE', [target]);
    await waitUntilWaiting(revert);

    await merge.query('COMMIT');

    const error = await pending;
    expect(error).toMatchObject({ statusCode: 409, code: 'FILM_REFERENCE_CONFLICT' });
    // Заказ не брал FOR SHARE на новый канон: откат получил FOR NO KEY UPDATE на него,
    // пока транзакция заказа ещё открыта (эти режимы конфликтуют).
    await revertTarget;
    await order.query('ROLLBACK');

    // Откат доходит до дубля (его держал заказ под FOR SHARE до ROLLBACK) — без deadlock.
    await revert.query('SELECT film_id FROM films WHERE film_id = $1 FOR NO KEY UPDATE', [ordered]);
    await revert.query("SET LOCAL erp.film_catalog = 'on'");
    await revert.query('UPDATE films SET canonical_film_id = NULL, is_active = true WHERE film_id = $1', [ordered]);
    await revert.query('COMMIT');

    // Повтор команды после отката каталога разрешается в исходную плёнку.
    await order.query('BEGIN');
    const retried = await resolveFilmReferencesForWrite(txOf(order), null, { headerFilmId: ordered, details: [] });
    await order.query('ROLLBACK');
    expect(retried.headerFilmId).toBe(ordered);
    expect(retried.replacements).toEqual([]);
  });

  it('resolves a merged duplicate to its canonical film under lock when nothing changes concurrently', async () => {
    const target = await film(`${tag} канон-2`);
    const duplicate = await film(`${tag} дубль-2`);
    await merge.query('BEGIN');
    await merge.query("SET LOCAL erp.film_catalog = 'on'");
    await merge.query('UPDATE films SET canonical_film_id = $1, is_active = false WHERE film_id = $2', [target, duplicate]);
    await merge.query('COMMIT');

    await order.query('BEGIN');
    const resolved = await resolveFilmReferencesForWrite(txOf(order), null, { headerFilmId: duplicate, details: [] });
    await order.query('ROLLBACK');
    expect(resolved.headerFilmId).toBe(target);
  });
});
