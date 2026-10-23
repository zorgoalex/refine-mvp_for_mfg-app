import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../config/env.validation';
import type { PerformanceQueryTelemetryService } from '../performance/performance-query-telemetry.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { DatabaseService } from './database.service';

const state = vi.hoisted(() => ({ calls: [] as Array<{ sql: string; params?: unknown[] }> }));
vi.mock('pg', () => ({ Pool: class {
  async connect() { let queried = false; return {
    query: async (sql: string, params?: unknown[]) => {
      // Same rule as PostgreSQL: the isolation level is fixed by the first query.
      if (/ISOLATION LEVEL/.test(sql) && queried) throw new Error('SET TRANSACTION ISOLATION LEVEL must be called before any query');
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') queried = false;
      else if (!/^SET TRANSACTION/.test(sql)) queried = true;
      state.calls.push({ sql, params });
      return { rows: [], rowCount: 0, fields: [], command: 'SELECT', oid: 0 };
    }, release: () => undefined,
  }; }
  async end() {}
} }));
const telemetry = { measure: <T>(_sql: string, operation: () => Promise<T>) => operation() } as PerformanceQueryTelemetryService;
const values: Partial<BackendEnv> = { DATABASE_URL: 'postgresql://test.invalid/e2e_mock',
  DATABASE_QUERY_TIMEOUT_MS: 5000, DATABASE_SSL: false, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 1 };
const config = { get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>;

describe('DatabaseService request id for database-side audit', () => {
  beforeEach(() => { state.calls = []; });

  it('sets a transaction-local erp.request_id from the HTTP request context', async () => {
    const contexts = new RequestContextService();
    const db = new DatabaseService(config, telemetry, contexts);
    await contexts.run({ requestId: 'req_abc', method: 'PATCH', route: '/api/v1/*' },
      () => db.transaction(async (tx) => { await tx.query('SELECT work'); }));
    expect(state.calls.map((call) => call.sql)).toEqual([
      'BEGIN', "SELECT set_config('erp.request_id', $1, true)", 'SELECT work', 'COMMIT',
    ]);
    expect(state.calls[1].params).toEqual(['req_abc']);
  });

  it('lets the handler set its isolation level before the request id', async () => {
    const contexts = new RequestContextService();
    const db = new DatabaseService(config, telemetry, contexts);
    await contexts.run({ requestId: 'req_rr', method: 'GET', route: '/api/v1/*' }, () => db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await tx.query('SELECT work');
    }));
    expect(state.calls.map((call) => call.sql)).toEqual([
      'BEGIN', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      "SELECT set_config('erp.request_id', $1, true)", 'SELECT work', 'COMMIT',
    ]);
  });

  it('keeps the isolation level from options ahead of the request id', async () => {
    const contexts = new RequestContextService();
    const db = new DatabaseService(config, telemetry, contexts);
    await contexts.run({ requestId: 'req_opt', method: 'GET', route: '/api/v1/*' },
      () => db.transaction(async (tx) => { await tx.query('SELECT work'); }, { isolation: 'repeatable read' }));
    expect(state.calls.map((call) => call.sql)).toEqual([
      'BEGIN', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      "SELECT set_config('erp.request_id', $1, true)", 'SELECT work', 'COMMIT',
    ]);
  });

  it('sets the request id once and first when the handler queries concurrently', async () => {
    const contexts = new RequestContextService();
    const db = new DatabaseService(config, telemetry, contexts);
    await contexts.run({ requestId: 'req_par', method: 'GET', route: '/api/v1/*' }, () => db.transaction(async (tx) => {
      await Promise.all([tx.query('SELECT one'), tx.query('SELECT two')]);
    }));
    expect(state.calls.map((call) => call.sql)).toEqual([
      'BEGIN', "SELECT set_config('erp.request_id', $1, true)", 'SELECT one', 'SELECT two', 'COMMIT',
    ]);
  });

  it('adds nothing outside a request or for an unknown request id', async () => {
    const contexts = new RequestContextService();
    const db = new DatabaseService(config, telemetry, contexts);
    await db.transaction(async () => undefined);
    await contexts.run({ requestId: 'req_unknown', method: 'GET', route: '/' }, () => db.transaction(async () => undefined));
    // A handler without queries cannot fire audit triggers, so the request id is not needed.
    await contexts.run({ requestId: 'req_idle', method: 'GET', route: '/' }, () => db.transaction(async () => undefined));
    expect(state.calls.map((call) => call.sql)).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  });
});
