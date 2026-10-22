import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../config/env.validation';
import type { PerformanceQueryTelemetryService } from '../performance/performance-query-telemetry.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { DatabaseService } from './database.service';

const state = vi.hoisted(() => ({ calls: [] as Array<{ sql: string; params?: unknown[] }> }));
vi.mock('pg', () => ({ Pool: class {
  async connect() { return {
    query: async (sql: string, params?: unknown[]) => {
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

  it('adds nothing outside a request or for an unknown request id', async () => {
    const contexts = new RequestContextService();
    const db = new DatabaseService(config, telemetry, contexts);
    await db.transaction(async () => undefined);
    await contexts.run({ requestId: 'req_unknown', method: 'GET', route: '/' }, () => db.transaction(async () => undefined));
    expect(state.calls.map((call) => call.sql)).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  });
});
