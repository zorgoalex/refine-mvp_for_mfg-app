import { ConfigService } from '@nestjs/config';
import { afterAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import { bulkQuery } from './pg-onec-etl-repository';

// A full 1C run publishes whole sets in one statement each; under load that exceeded the common per-query limit and
// `complete` failed with «Query read timeout» (stage 27.10). One statement gets its own limit; the rest keep the common.
// Owned disposable database film_catalog_it_* only (no tables needed). The common limit is 1.5 s and the long
// statement 3 s: with 300 ms / 0.6 s a loaded host made an ordinary query of the test miss the common limit (28.10).
const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;

describe.skipIf(!url)('1C ETL bulk statement timeout — real PostgreSQL', () => {
  const values: Partial<BackendEnv> = {
    DATABASE_URL: url, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 1, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 1500,
  };
  const database = new DatabaseService(new ConfigService<BackendEnv, true>(values as BackendEnv),
    { measure: (_text: string, run: () => Promise<unknown>) => run() } as never);
  afterAll(() => database.onModuleDestroy());

  it('a statement longer than the common limit fails; through bulkQuery it passes, and the common limit is back after it', async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    expect(dbName.startsWith('film_catalog_it_')).toBe(true);
    const common = async () => (await database.query<{ value: string }>(`SELECT current_setting('statement_timeout') AS value`)).rows[0].value;
    expect(await common()).toBe('1500ms');
    // Without bulkQuery: the common limit stops it.
    await expect(database.transaction((tx) => tx.query('SELECT pg_sleep(3)'))).rejects.toThrow();
    // Through bulkQuery: it passes, and the transaction-local limit is restored right after it.
    const inside = await database.transaction(async (tx) => {
      const slow = await bulkQuery(tx, 'SELECT true AS slept FROM pg_sleep(3)', []);
      const setting = (await tx.query<{ value: string }>(`SELECT current_setting('statement_timeout') AS value`)).rows[0].value;
      return { slept: slow.rows[0].slept, setting };
    });
    expect(inside).toEqual({ slept: true, setting: '1500ms' });
    // A long statement after the bulk one in the same transaction is stopped again — the error propagates.
    await expect(database.transaction(async (tx) => {
      await bulkQuery(tx, 'SELECT true AS slept FROM pg_sleep(3)', []);
      await tx.query('SELECT pg_sleep(3)');
    })).rejects.toThrow();
    // The pooled connection (pool of 1) is reused after the rollback with the common limit.
    expect(await common()).toBe('1500ms');
  }, 30_000);
});
