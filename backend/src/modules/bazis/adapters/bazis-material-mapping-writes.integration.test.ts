import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import type { UpsertMaterialMappingDto } from '../dto/bazis.dto';
import {
  lockMillingMappingNames,
  syncMillingMappingSpellings,
  upsertMaterialMappingRow,
} from './bazis-material-mapping-writes';

const databaseUrl = process.env.TEST_DATABASE_URL;

/**
 * Сопоставления фрезеровок Базиса на настоящем PostgreSQL (изолированная схема, таблица из
 * migr 058 + migr 298). Два сохранения разных написаний одной фрезеровки идут параллельно:
 * с блокировкой по нормализованному имени второе ждёт первое и оба завершаются; без неё
 * (негативный контроль) строки блокируются крест-накрест — deadlock.
 */
describe.skipIf(!databaseUrl)('Bazis milling mapping writes (PostgreSQL, isolated schema)', () => {
  const schema = `e2e_bazis_milling_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;
  let setup: PoolClient;

  const db = (connection: PoolClient): DatabaseClient =>
    ({ query: (text: string, params: readonly unknown[] = []) => connection.query(text, [...params]) }) as unknown as DatabaseClient;
  const connect = async (): Promise<PoolClient> => {
    const connection = await pool.connect();
    await connection.query(`SET search_path TO ${schema}`);
    await connection.query("SET lock_timeout = '10s'");
    return connection;
  };
  const item = (bazisName: string, millingTypeId: number): UpsertMaterialMappingDto => ({
    sourceKind: 'milling',
    bazisName,
    targetKind: 'milling',
    millingTypeId,
  });
  const waitForLockWait = async (pid: number): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { rows } = await setup.query<{ waiting: boolean }>(
        "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
        [pid],
      );
      if (rows[0]?.waiting) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`backend ${pid} never waited on a lock`);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    setup = await pool.connect();
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(`SET search_path TO ${schema}`);
    await setup.query(`
      CREATE TABLE users (user_id bigint PRIMARY KEY);
      CREATE TABLE sheet_material_types (sheet_material_type_id bigint PRIMARY KEY);
      CREATE TABLE films (film_id bigint PRIMARY KEY);
      CREATE TABLE edge_types (edge_type_id bigint PRIMARY KEY);
      CREATE TABLE milling_types (milling_type_id bigint PRIMARY KEY, milling_type_name text NOT NULL);
      INSERT INTO milling_types VALUES (2, 'выборка'), (666, 'по фото/схеме');
    `);
    const migration058 = await readFile(
      new URL('../../../../db/migrations/058_bazis_import.sql', import.meta.url),
      'utf8',
    );
    const tableStart = migration058.indexOf('CREATE TABLE IF NOT EXISTS bazis_material_mappings');
    const indexEnd = migration058.indexOf(';', migration058.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS bazis_material_mappings_name_uniq'));
    await setup.query(migration058.slice(tableStart, indexEnd + 1));
    const migration298 = await readFile(
      new URL('../../../../db/migrations/298_bazis_milling_mappings.sql', import.meta.url),
      'utf8',
    );
    await setup.query(migration298.replaceAll('public.', ''));
  });

  afterAll(async () => {
    await setup?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    setup?.release();
    await pool?.end();
  });

  beforeEach(async () => {
    await setup.query('TRUNCATE bazis_material_mappings');
    await setup.query(`
      INSERT INTO bazis_material_mappings (source_kind, bazis_name, target_kind, milling_type_id)
      VALUES ('milling', 'Выборка по фото', 'milling', 2), ('milling', 'Выборка  по фото', 'milling', 2)
    `);
  });

  it('serializes concurrent saves of two spellings: no deadlock, the later choice wins for both', async () => {
    const first = await connect();
    const second = await connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      const firstItem = item('Выборка по фото', 666);
      const secondItem = item('Выборка  по фото', 2);

      await lockMillingMappingNames(db(first), [firstItem]);
      await upsertMaterialMappingRow(db(first), firstItem, null);

      const secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const secondSave = (async () => {
        await lockMillingMappingNames(db(second), [secondItem]);
        await upsertMaterialMappingRow(db(second), secondItem, null);
        await syncMillingMappingSpellings(db(second), secondItem, null);
        await second.query('COMMIT');
      })();
      await waitForLockWait(secondPid);

      await syncMillingMappingSpellings(db(first), firstItem, null);
      await first.query('COMMIT');
      await secondSave;

      const { rows } = await setup.query<{ bazis_name: string; milling_type_id: string }>(
        "SELECT bazis_name, milling_type_id::text FROM bazis_material_mappings WHERE source_kind = 'milling' ORDER BY bazis_name",
      );
      expect(rows).toEqual([
        { bazis_name: 'Выборка  по фото', milling_type_id: '2' },
        { bazis_name: 'Выборка по фото', milling_type_id: '2' },
      ]);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('negative control: without the name lock the same interleaving deadlocks', async () => {
    const first = await connect();
    const second = await connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      const firstItem = item('Выборка по фото', 666);
      const secondItem = item('Выборка  по фото', 2);

      await upsertMaterialMappingRow(db(first), firstItem, null);
      await upsertMaterialMappingRow(db(second), secondItem, null);

      const firstPid = (await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      // Жертва deadlock держит свои блокировки до ROLLBACK — откатываем её сразу, чтобы
      // второе соединение дошло до конца, а не ждало lock_timeout.
      const settle = (connection: PoolClient, run: Promise<void>) =>
        run.then(
          () => null,
          async (error: { code?: string }) => {
            await connection.query('ROLLBACK');
            return error.code ?? 'error';
          },
        );
      const firstSync = settle(first, syncMillingMappingSpellings(db(first), firstItem, null));
      await waitForLockWait(firstPid);
      const secondSync = settle(second, syncMillingMappingSpellings(db(second), secondItem, null));
      const outcomes = await Promise.all([firstSync, secondSync]);
      expect(outcomes).toContain('40P01');
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
  });
});
