import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { ShadowScopeError } from '../adapters/mdf-comparison-snapshot';
import { MdfShadowComparisonService } from './mdf-shadow-comparison.service';

const snapshot = { snapshotAt: '2026-09-20T00:00:00Z', sourceDigest: 'current', ownerCount: 1, sourceCount: 0,
  input: { sources: [], details: [], legacyCards: [], allocations: [], issues: [], thresholds: { packed: 4, issued: 5, laminated: 3 } } };
function fixture(mode = 'legacy', attempts = 0) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('pg_try_')) return { rows: [{ acquired: true }] };
    if (sql.includes('SELECT mode')) return { rows: [{ mode }] };
    if (sql.includes('SELECT o.source_kind')) return { rows: [{ source_kind: 'packet', source_id: 'p', revision_key: 'r', source_digest: 'old', attempts }] };
    return { rows: [] };
  });
  const db = { isConfigured: true, transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn({ query })) };
  const load = vi.fn(async () => snapshot);
  const service = new MdfShadowComparisonService(db as unknown as DatabaseService, load);
  return { query, db, load, service };
}
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('MDF diagnostic comparison worker', () => {
  it('disabled flag performs zero queries or transactions', async () => {
    vi.stubEnv('BACKEND_MDF_SHADOW_COMPARE', 'false');
    const f = fixture(); f.service.onModuleInit(); await f.service.runTick(); f.service.onModuleDestroy();
    expect(f.db.transaction).not.toHaveBeenCalled();
  });
  it.each(['active', 'read_only'])('never runs in %s mode', async mode => {
    vi.stubEnv('BACKEND_MDF_SHADOW_COMPARE', 'true'); const f = fixture(mode); await f.service.runTick();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.query.mock.calls[0][0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  });
  it('writes only diagnostic report and records superseded trigger, not event replay', async () => {
    vi.stubEnv('BACKEND_MDF_SHADOW_COMPARE', 'true'); const f = fixture(); await f.service.runTick();
    const writes = f.query.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql));
    expect(writes).toHaveLength(1); expect(writes[0][0]).toContain('INSERT INTO mdf_shadow_comparisons');
    const params = (f.query.mock.calls as unknown as [string, unknown[]][]).find(([sql]) => sql.startsWith('INSERT'))![1];
    expect(JSON.parse(params[7] as string)).toMatchObject({ triggerSuperseded: true, cutoverReady: false, status: 'blocked' });
  });
  it('is single-flight and schedules no immediate board-load work', async () => {
    vi.stubEnv('BACKEND_MDF_SHADOW_COMPARE', 'true'); vi.useFakeTimers(); const f = fixture();
    f.service.onModuleInit(); expect(f.load).not.toHaveBeenCalled();
    let resolve!: (value: typeof snapshot) => void;
    f.load.mockImplementation(() => new Promise(r => { resolve = r; }));
    const first = f.service.runTick(); await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(1));
    await f.service.runTick(); expect(f.db.transaction).toHaveBeenCalledTimes(1);
    resolve(snapshot); await first; f.service.onModuleDestroy();
  });
  it('backs off SQL failures without poison blocking later observations', async () => {
    vi.stubEnv('BACKEND_MDF_SHADOW_COMPARE', 'true'); const f = fixture();
    f.load.mockRejectedValue({ code: '57014', message: 'private sql' }); await f.service.runTick();
    expect(f.query.mock.calls.some(([sql]) => sql === 'ROLLBACK TO SAVEPOINT shadow_snapshot')).toBe(true);
    const writes = f.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT'));
    expect(writes[0][0]).toContain('mdf_shadow_comparison_attempts');
    expect(JSON.stringify(f.query.mock.calls)).not.toContain('private sql');
  });
  it('turns permanent caps / exhausted retries into blocked reports', async () => {
    vi.stubEnv('BACKEND_MDF_SHADOW_COMPARE', 'true');
    for (const error of [new ShadowScopeError('SOURCE_LIMIT'), new Error('private failure')]) {
      const f = fixture('legacy', 2); f.load.mockRejectedValue(error); await f.service.runTick();
      expect(f.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO mdf_shadow_comparisons'))).toBe(true);
      expect(f.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO mdf_shadow_comparison_attempts'))).toBe(false);
    }
  });
  it('rejects a write attempted through the snapshot client before it reaches SQL', async () => {
    vi.stubEnv('BACKEND_MDF_SHADOW_COMPARE', 'true'); const f = fixture();
    const service = new MdfShadowComparisonService(f.db as unknown as DatabaseService, async db => {
      await db.query('WITH changed AS (UPDATE order_details SET quantity=1 RETURNING *) SELECT * FROM changed');
      return snapshot;
    });
    await service.runTick();
    expect(f.query.mock.calls.some(([sql]) => sql.includes('UPDATE order_details'))).toBe(false);
    const call = (f.query.mock.calls as unknown as [string, unknown[]][]).find(([sql]) => sql.startsWith('INSERT'))!;
    expect(JSON.parse(call[1][7] as string).issues).toContain('NON_READ_QUERY_REJECTED');
  });
});
