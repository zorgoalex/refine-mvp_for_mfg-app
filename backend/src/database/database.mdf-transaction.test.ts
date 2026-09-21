import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendEnv } from '../config/env.validation';
import type { PerformanceQueryTelemetryService } from '../performance/performance-query-telemetry.service';
import { DatabaseService } from './database.service';
import { beforeTransactionCommit } from './transaction-hooks';
import { requireMdfCommandBoundary } from '../modules/mdf-board/application/mdf-command-boundary';

const state = vi.hoisted(() => ({ mode: 'legacy', calls: [] as string[], release: vi.fn() }));
vi.mock('pg', () => ({ Pool: class {
  async connect() { return {
    query: async (sql: string) => {
      state.calls.push(sql);
      return { rows: sql.includes('SELECT mode FROM mdf_engine_state') ? [{ mode: state.mode }] : [],
        rowCount: 0, fields: [], command: 'SELECT', oid: 0 };
    }, release: state.release,
  }; }
  async end() {}
} }));
const telemetry = { measure: <T>(_sql: string, operation: () => Promise<T>) => operation() } as PerformanceQueryTelemetryService;
function database() {
  const values: Partial<BackendEnv> = { DATABASE_URL: 'postgresql://test.invalid/e2e_mock',
    DATABASE_QUERY_TIMEOUT_MS: 5000, DATABASE_SSL: false, DATABASE_POOL_MIN: 0, DATABASE_POOL_MAX: 1 };
  return new DatabaseService({ get: (key: keyof BackendEnv) => values[key] } as ConfigService<BackendEnv, true>, telemetry);
}
const queued = { writer: 'manual-move', capability: 'queued' as const };

describe('DatabaseService MDF command entry', () => {
  beforeEach(() => { state.mode = 'legacy'; state.calls = []; state.release.mockClear(); });
  it('enters before handler locks and flushes normal transaction hooks', async () => {
    const db = database();
    await db.transaction(async tx => {
      expect(await requireMdfCommandBoundary(tx, queued)).toEqual({ mode: 'legacy', queued: false });
      await tx.query('SELECT e2e_domain_lock');
      beforeTransactionCommit(tx, 'e2e-hook', () => tx.query('SELECT e2e_finalizer').then(() => undefined));
    }, { mdf: queued });
    expect(state.calls[0]).toBe('BEGIN');
    expect(state.calls[1]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    expect(state.calls[2]).toContain('pg_advisory_xact_lock_shared');
    expect(state.calls[3]).toContain('SELECT mode FROM mdf_engine_state');
    expect(state.calls.slice(4)).toEqual(['SELECT e2e_domain_lock', 'SELECT e2e_finalizer', 'COMMIT']);
    expect(state.release).toHaveBeenCalledOnce();
  });
  it.each(['serializable', 'repeatable read'] as const)('rejects stale-snapshot isolation %s before MDF effects', async isolation => {
    const handler = vi.fn();
    await expect(database().transaction(handler, { mdf: queued, isolation }))
      .rejects.toMatchObject({ code: 'MDF_COMMAND_ISOLATION_UNSUPPORTED' });
    expect(handler).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });
  it('preserves explicit serializable isolation for unclassified transactions', async () => {
    await database().transaction(async () => undefined, { isolation: 'serializable' });
    expect(state.calls).toEqual(['BEGIN', 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'COMMIT']);
  });
  it('rejects unsupported active writer before invoking domain code', async () => {
    state.mode = 'active'; const handler = vi.fn();
    await expect(database().transaction(handler, { mdf: { writer: 'save', capability: 'legacy-only' } }))
      .rejects.toMatchObject({ code: 'MDF_WRITER_NOT_CONNECTED' });
    expect(handler).not.toHaveBeenCalled();
    expect(state.calls.at(-1)).toBe('ROLLBACK');
    expect(state.release).toHaveBeenCalledOnce();
  });
  it('unclassified transactions do not receive an MDF command capability', async () => {
    await database().transaction(async tx => {
      await expect(requireMdfCommandBoundary(tx, queued)).rejects.toMatchObject({ code: 'MDF_COMMAND_BOUNDARY_REQUIRED' });
    });
    expect(state.calls).toEqual(['BEGIN', 'COMMIT']);
  });
  it('drops cached boundary after commit and rechecks on the next transaction', async () => {
    const db = database();
    const old = await db.transaction(async tx => tx, { mdf: queued });
    await expect(requireMdfCommandBoundary(old, queued)).rejects.toMatchObject({ code: 'MDF_COMMAND_BOUNDARY_REQUIRED' });
    state.mode = 'active';
    await db.transaction(async tx => {
      expect((await requireMdfCommandBoundary(tx, queued)).queued).toBe(true);
    }, { mdf: queued });
    expect(state.calls.filter(sql => sql.includes('SELECT mode FROM mdf_engine_state'))).toHaveLength(2);
  });
});
