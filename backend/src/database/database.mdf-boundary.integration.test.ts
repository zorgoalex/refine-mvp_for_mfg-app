import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../config/env.validation';
import type { PerformanceQueryTelemetryService } from '../performance/performance-query-telemetry.service';
import { enterMdfSerializableLegacyCommand, requireMdfCommandBoundary } from '../modules/mdf-board/application/mdf-command-boundary';
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
  // §5.7b: lets a test pause the SUT transaction right after one of its queries resolves,
  // by returning a promise from the hook that only settles when the test releases it.
  let onQuery: ((sql: string) => Promise<void> | void) | undefined;
  beforeAll(async () => {
    await control.connect();
    await control.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public;
      CREATE TABLE mdf_engine_state(singleton boolean PRIMARY KEY,mode text NOT NULL);
      INSERT INTO mdf_engine_state VALUES(true,'legacy');
      CREATE TABLE mdf_freeze_guard(singleton boolean PRIMARY KEY,freeze_run_id uuid);
      INSERT INTO mdf_freeze_guard VALUES(true,NULL);
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
      { measure: async <T>(sql: string, operation: () => Promise<T>) => {
        const result = await operation();
        await onQuery?.(sql);
        return result;
      } } as PerformanceQueryTelemetryService);
  });
  beforeEach(async () => {
    onQuery = undefined;
    await control.query(`UPDATE mdf_engine_state SET mode='legacy';
      UPDATE mdf_freeze_guard SET freeze_run_id=NULL; DELETE FROM command_effect`);
  });
  afterAll(async () => {
    await database?.onModuleDestroy();
    try {
      await control.query(`ROLLBACK; SET search_path=public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await control.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows).toHaveLength(0);
    } finally { await control.end(); }
  });

  it('fails fast while the cutover fence is held, then sees committed active mode on retry, despite serializable pool default', async () => {
    await control.query('BEGIN');
    await control.query(`SELECT pg_advisory_xact_lock(${fence})`);
    await control.query("UPDATE mdf_engine_state SET mode='active'");
    let entered = false;
    // §5.7b: never wait behind the exclusive fence — fail fast instead.
    await expect(database.transaction(async tx => {
      entered = true;
      return requireMdfCommandBoundary(tx, writer);
    }, { mdf: writer })).rejects.toMatchObject({ code: 'MDF_CUTOVER_IN_PROGRESS' });
    expect(entered).toBe(false);
    await control.query('COMMIT');
    const retry = await database.transaction(async tx => {
      expect((await tx.query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe('read committed');
      return requireMdfCommandBoundary(tx, writer);
    }, { mdf: writer });
    expect(retry).toEqual({ mode: 'active', queued: true });
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

  it.each(['active', 'read_only'])('serializable legacy snapshot predating %s cutover fails stale before writes', async mode => {
    // §5.7b: the try-lock no longer blocks, but it is still a real SELECT — the first one
    // in the transaction — so it still fixes the serializable snapshot. Pause the SUT right
    // after that SELECT resolves (lock free, snapshot now fixed), commit a cutover mode
    // change with no lock contention at all, then resume: the FOR SHARE mode read must
    // still detect the now-stale snapshot and fail closed, exactly as when the old blocking
    // call used to provide this same window while waiting.
    let releasePause: (() => void) | undefined;
    const reached = new Promise<void>(resolveReached => {
      onQuery = sql => {
        if (!sql.includes('pg_try_advisory_xact_lock_shared')) return;
        onQuery = undefined;
        resolveReached();
        return new Promise<void>(resolveResume => { releasePause = resolveResume; });
      };
    });
    const outcome = database.transaction(async tx => {
      await enterMdfSerializableLegacyCommand(tx, 'mdf.production_return');
      await tx.query('INSERT INTO command_effect VALUES(1)');
    }, { isolation: 'serializable' }).then(value => ({ value }), error => ({ error }));
    await reached;
    await control.query('UPDATE mdf_engine_state SET mode=$1', [mode]);
    releasePause?.();
    expect(await outcome).toMatchObject({ error: { code: '40001' } });
    expect((await control.query('SELECT * FROM command_effect')).rows).toEqual([]);
    expect((await control.query(`SELECT pg_try_advisory_xact_lock(${fence}) locked`)).rows[0].locked).toBe(true);
  });

  it('serializable legacy entrance holds cutover until commit and releases all locks on rollback', async () => {
    const command = (fail: boolean) => database.transaction(async tx => {
      expect(await enterMdfSerializableLegacyCommand(tx, 'mdf.production_return')).toEqual({ mode: 'legacy', queued: false });
      expect((await control.query(`SELECT pg_try_advisory_xact_lock(${fence}) locked`)).rows[0].locked).toBe(false);
      await tx.query('INSERT INTO command_effect VALUES($1)', [fail ? 2 : 1]);
      if (fail) throw new Error('E2E_RETURN_ROLLBACK');
    }, { isolation: 'serializable' });
    await command(false);
    await expect(command(true)).rejects.toThrow('E2E_RETURN_ROLLBACK');
    expect((await control.query('SELECT * FROM command_effect')).rows).toEqual([{ id: 1 }]);
    expect((await control.query(`SELECT pg_try_advisory_xact_lock(${fence}) locked`)).rows[0].locked).toBe(true);
    await control.query("UPDATE mdf_engine_state SET mode='active'");
    await expect(command(false)).rejects.toMatchObject({ code: 'MDF_WRITER_NOT_CONNECTED' });
  });

  it('reports disabled immediately when the exclusive cutover fence is currently held, without reading mode', async () => {
    // §5.7b: MdfJobRunner never waits behind a population run (or any cutover) holding
    // the exclusive fence; it reports disabled right away so the caller retries on the next tick.
    await control.query("UPDATE mdf_engine_state SET mode='active'; BEGIN");
    await control.query(`SELECT pg_advisory_xact_lock(${fence})`);
    const handler = vi.fn();
    const outcome = await new MdfJobRunner(database, handler).processOne();
    expect(outcome).toEqual({ status: 'disabled' });
    expect(handler).not.toHaveBeenCalled();
    await control.query('ROLLBACK');
  });
});
