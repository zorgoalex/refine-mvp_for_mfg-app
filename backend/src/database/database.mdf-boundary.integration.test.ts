import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../config/env.validation';
import type { PerformanceQueryTelemetryService } from '../performance/performance-query-telemetry.service';
import { requireMdfCommandBoundary } from '../modules/mdf-board/application/mdf-command-boundary';
import { MdfJobRunner } from '../modules/mdf-board/application/mdf-job-runner';
import { DatabaseService } from './database.service';

describe.skipIf(process.env.MDF_ENGINE_INTEGRATION !== '1')('MDF command/cutover PostgreSQL serialization', () => {
  const schema = `e2e_mdf_boundary_${randomUUID().replaceAll('-', '')}`;
  const name = `e2e-mdf-boundary-${randomUUID()}`;
  const config = { host: process.env.PG_TAILSCALE_BIND_IP || process.env.PG_BIND_IP || '127.0.0.1',
    database: process.env.PG_DB, user: process.env.PG_USER, password: process.env.PG_PASSWORD,
    connectionTimeoutMillis: 5000, options: '-c statement_timeout=10000 -c lock_timeout=3000' };
  const control = new Client(config);
  let database: DatabaseService;
  const writer = { writer: 'e2e-command', capability: 'queued' as const };
  const fence = "hashtextextended('mdf-engine-cutover',0)";
  beforeAll(async () => {
    await control.connect();
    await control.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public;
      CREATE TABLE mdf_engine_state(singleton boolean PRIMARY KEY,mode text NOT NULL);
      INSERT INTO mdf_engine_state VALUES(true,'legacy');
      CREATE TABLE command_effect(id int PRIMARY KEY)`);
    const url = new URL('postgresql://localhost');
    url.hostname = config.host; url.pathname = `/${config.database}`;
    url.username = config.user ?? ''; url.password = config.password ?? '';
    url.searchParams.set('application_name', name);
    // A stricter server default must never leak into tagged command mode reads.
    url.searchParams.set('options', `-c search_path=${schema},public -c default_transaction_isolation=serializable`);
    const values: Partial<BackendEnv> = { DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: 10000,
      DATABASE_SSL: false, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 1 };
    database = new DatabaseService({ get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>,
      { measure: <T>(_sql: string, operation: () => Promise<T>) => operation() } as PerformanceQueryTelemetryService);
  });
  beforeEach(async () => {
    await control.query("UPDATE mdf_engine_state SET mode='legacy'; DELETE FROM command_effect");
  });
  afterAll(async () => {
    await database?.onModuleDestroy();
    try {
      await control.query(`ROLLBACK; SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await control.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toHaveLength(0);
    } finally { await control.end(); }
  });

  it('waits for cutover then sees committed active mode, despite serializable pool default', async () => {
    await control.query('BEGIN');
    await control.query(`SELECT pg_advisory_xact_lock(${fence})`);
    await control.query("UPDATE mdf_engine_state SET mode='active'");
    let entered = false;
    const command = database.transaction(async tx => {
      entered = true;
      expect((await tx.query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe('read committed');
      return requireMdfCommandBoundary(tx, writer);
    }, { mdf: writer });
    // Attach a handler now, including failure paths during lock observation.
    const outcome = command.then(value => ({ value }), error => ({ error }));
    try {
      await vi.waitFor(async () => {
        await control.query('SELECT pg_stat_clear_snapshot()');
        const waiting = await control.query(`SELECT 1 FROM pg_stat_activity
          WHERE application_name=$1 AND wait_event='advisory'`, [name]);
        expect(waiting.rows).toHaveLength(1);
      }, { timeout: 2000, interval: 20 });
      expect(entered).toBe(false);
      await control.query('COMMIT');
      expect(await outcome).toEqual({ value: { mode: 'active', queued: true } });
    } finally { await control.query('ROLLBACK'); await outcome; }
  });

  it('keeps the shared cutover lock until command commit and releases after rollback', async () => {
    const result = await database.transaction(async tx => {
      await tx.query('INSERT INTO command_effect VALUES(1)');
      expect((await control.query(`SELECT pg_try_advisory_xact_lock(${fence}) locked`)).rows[0].locked).toBe(false);
      return requireMdfCommandBoundary(tx, writer);
    }, { mdf: writer });
    expect(result.mode).toBe('legacy');
    expect((await control.query(`SELECT pg_try_advisory_xact_lock(${fence}) locked`)).rows[0].locked).toBe(true);
    await expect(database.transaction(async tx => {
      await tx.query('INSERT INTO command_effect VALUES(2)');
      throw new Error('E2E_ROLLBACK');
    }, { mdf: writer })).rejects.toThrow('E2E_ROLLBACK');
    expect((await control.query('SELECT id FROM command_effect ORDER BY id')).rows).toEqual([{ id: 1 }]);
    expect((await control.query(`SELECT pg_try_advisory_xact_lock(${fence}) locked`)).rows[0].locked).toBe(true);
  });

  it('read_only rejects ordinary commands before any domain effect', async () => {
    await control.query("UPDATE mdf_engine_state SET mode='read_only'");
    const callback = vi.fn(async tx => tx.query('INSERT INTO command_effect VALUES(1)'));
    await expect(database.transaction(callback, { mdf: writer })).rejects.toMatchObject({ code: 'MDF_ENGINE_READ_ONLY' });
    expect(callback).not.toHaveBeenCalled();
    expect((await control.query('SELECT * FROM command_effect')).rows).toEqual([]);
  });

  it('queue also sees read_only after a waiting cutover, with a stricter pool default', async () => {
    await control.query("UPDATE mdf_engine_state SET mode='active'; BEGIN");
    await control.query(`SELECT pg_advisory_xact_lock(${fence})`);
    await control.query("UPDATE mdf_engine_state SET mode='read_only'");
    const handler = vi.fn();
    const outcome = new MdfJobRunner(database, handler).processOne()
      .then(value => ({ value }), error => ({ error }));
    try {
      await vi.waitFor(async () => {
        await control.query('SELECT pg_stat_clear_snapshot()');
        expect((await control.query(`SELECT 1 FROM pg_stat_activity
          WHERE application_name=$1 AND wait_event='advisory'`, [name])).rows).toHaveLength(1);
      }, { timeout: 2000, interval: 20 });
      await control.query('COMMIT');
      // No job table in this fixture: any stale active read would also fail SQL.
      expect(await outcome).toEqual({ value: { status: 'disabled' } });
      expect(handler).not.toHaveBeenCalled();
    } finally { await control.query('ROLLBACK'); await outcome; }
  });
});
