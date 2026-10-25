import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../config/env.validation';
import type { PerformanceQueryTelemetryService } from '../performance/performance-query-telemetry.service';
import { DatabaseService } from './database.service';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('DatabaseService.readSnapshot, PostgreSQL', () => {
  const schema = `e2e_read_snapshot_${randomUUID().replaceAll('-', '')}`;
  const config = { host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5000, options: '-c statement_timeout=10000 -c lock_timeout=3000' };
  const control = new Client(config);
  const services: DatabaseService[] = [];
  const service = (poolMax: number) => {
    const url = new URL('postgresql://localhost');
    url.hostname = config.host; url.pathname = `/${config.database}`;
    url.username = config.user ?? ''; url.password = config.password ?? '';
    url.searchParams.set('options', `-c search_path=${schema},public`);
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 10000,
      DATABASE_SSL: false, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: poolMax };
    const database = new DatabaseService({ get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>,
      { measure: <T>(_sql: string, operation: () => Promise<T>) => operation() } as PerformanceQueryTelemetryService);
    services.push(database);
    return database;
  };
  const concurrentReads = (client: { query: DatabaseService['query'] }, count: number) => Promise.all(
    Array.from({ length: count }, () => client.query<{ rows: number; pid: number; isolation: string; readOnly: string }>(
      `SELECT (SELECT count(*) FROM snapshot_probe)::int "rows", pg_backend_pid() pid,
        current_setting('transaction_isolation') isolation, current_setting('transaction_read_only') "readOnly",
        pg_sleep(0.2) IS NULL AS slept`).then(result => result.rows[0])));

  beforeAll(async () => {
    await control.connect();
    await control.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.snapshot_probe(v int)`);
  });
  beforeEach(async () => {
    await control.query(`TRUNCATE ${schema}.snapshot_probe; INSERT INTO ${schema}.snapshot_probe VALUES (1)`);
  });
  afterAll(async () => {
    for (const database of services) await database.onModuleDestroy();
    try {
      await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await control.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toHaveLength(0);
    } finally { await control.end(); }
  });

  it('runs concurrent queries on several sessions that all see the one snapshot taken first', async () => {
    const database = service(10);
    const reads = await database.readSnapshot(async snapshot => {
      const first = (await snapshot.query<{ n: number }>('SELECT count(*)::int n FROM snapshot_probe')).rows[0].n;
      await control.query(`INSERT INTO ${schema}.snapshot_probe VALUES (2)`); // committed after the snapshot
      return { first, rows: await concurrentReads(snapshot, 4) };
    }, { parallelism: 4 });
    expect(reads.first).toBe(1);
    expect(new Set(reads.rows.map(row => row.pid)).size).toBeGreaterThan(1);
    for (const row of reads.rows) {
      expect(row).toMatchObject({ rows: 1, isolation: 'repeatable read', readOnly: 'on' });
    }
    expect((await database.query<{ n: number }>('SELECT count(*)::int n FROM snapshot_probe')).rows[0].n).toBe(2);
  });

  it('takes no follower from a pool without spare capacity and stays on the leader session', async () => {
    const database = service(3);
    const rows = await database.readSnapshot(snapshot => concurrentReads(snapshot, 3), { parallelism: 4 });
    expect(new Set(rows.map(row => row.pid)).size).toBe(1);
    expect(rows.every(row => row.rows === 1 && row.readOnly === 'on')).toBe(true);
  });

  it('closes on a handler failure: a sibling branch still chaining gets no query after the end', async () => {
    const database = service(10);
    let secondRan = false;
    let secondError: unknown;
    let sibling: Promise<void> | undefined;
    await expect(database.readSnapshot(async snapshot => {
      sibling = (async () => {
        await snapshot.query('SELECT pg_sleep(0.3)');
        await snapshot.query('SELECT 1').then(() => { secondRan = true; }, error => { secondError = error; });
      })();
      await snapshot.query('SELECT 1');
      throw new Error('handler failed');
    }, { parallelism: 4 })).rejects.toThrow('handler failed');
    await sibling;
    expect(secondRan).toBe(false);
    expect(secondError).toMatchObject({ code: 'DATABASE_SNAPSHOT_CLOSED' });
    const open = await control.query(`SELECT count(*)::int n FROM pg_stat_activity
      WHERE datname=current_database() AND state LIKE 'idle in transaction%' AND pid<>pg_backend_pid()`);
    expect(open.rows[0].n).toBe(0);
  });

  it('never waits for a follower and keeps the reserve free under concurrent snapshot reads', async () => {
    const database = service(8);
    const pool = (database as unknown as { pool: { waitingCount: number; totalCount: number; idleCount: number } }).pool;
    let maxWaiting = 0;
    let maxBusy = 0;
    const sampler = setInterval(() => {
      maxWaiting = Math.max(maxWaiting, pool.waitingCount);
      maxBusy = Math.max(maxBusy, pool.totalCount - pool.idleCount);
    }, 5);
    try {
      const results = await Promise.all(Array.from({ length: 4 }, () =>
        database.readSnapshot(snapshot => concurrentReads(snapshot, 4), { parallelism: 4 })));
      expect(results.flat().every(row => row.rows === 1 && row.readOnly === 'on')).toBe(true);
    } finally { clearInterval(sampler); }
    expect(maxWaiting).toBe(0);
    // Followers only take capacity above the reserve (3): even if the first leader takes its 3 followers before
    // the other leaders connect (1 + 3 + 3 = 7), one connection of 8 stays free for unrelated requests.
    expect(maxBusy).toBeLessThan(8);
  });

  it('rejects writes, rolls every session back and returns all connections to the pool', async () => {
    const database = service(10);
    await expect(database.readSnapshot(async snapshot => {
      await concurrentReads(snapshot, 4);
      await snapshot.query('INSERT INTO snapshot_probe VALUES (3)');
    }, { parallelism: 4 })).rejects.toMatchObject({ code: '25006' });
    expect((await database.query<{ n: number }>('SELECT count(*)::int n FROM snapshot_probe')).rows[0].n).toBe(1);
    const open = await control.query(`SELECT count(*)::int n FROM pg_stat_activity
      WHERE datname=current_database() AND state LIKE 'idle in transaction%' AND pid<>pg_backend_pid()
        AND query ILIKE '%snapshot_probe%'`);
    expect(open.rows[0].n).toBe(0);
    const again = await database.readSnapshot(snapshot => concurrentReads(snapshot, 2), { parallelism: 4 });
    expect(again.every(row => row.rows === 1)).toBe(true);
  });
});
