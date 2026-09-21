import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { loadMdfShadowProofs } from './mdf-shadow-proof-loader';

const source = { kind: 'packet' as const, id: 'p' };
const command = { source_kind: 'packet', source_id: 'p', sequence: '1', revision: 'r', kind: 'manual_move',
  target: 'completed', compositionDigest: 'd', provenanceValid: true, issues: ['EXPLICIT_COMMAND_UNVERIFIED'] };
const line = { source_kind: 'packet', source_id: 'p', revision: 'r', line: 'member:a', orderId: 1, detailId: 11,
  quantity: 3, rework: false, stage: 'membership', evidence: 'derived' };
const client = (commands: object[], lines: object[]) => {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('JOIN mdf_shadow_commands') ? commands : lines }));
  return { query, db: { query } as unknown as DatabaseClient };
};
describe('bounded journal proof batch loader', () => {
  it('loads exact tuple-scoped frozen membership with two bounded queries, no archive', async () => {
    const f = client([command], [line]);
    expect((await loadMdfShadowProofs(f.db, [source])).get('packet:p')).toMatchObject([
      { provenanceValid: true, members: [{ line: 'member:a', quantity: 3, detailId: 11 }] },
    ]);
    expect(f.query).toHaveBeenCalledTimes(2);
    for (const [sql] of f.query.mock.calls) {
      expect(sql).toContain('unnest('); expect(sql).toContain('LIMIT'); expect(sql).not.toContain('snapshot_job');
    }
    expect(f.query.mock.calls[0][0]).toContain('a.user_id=r.actor_user_id');
    expect(f.query.mock.calls[0][0]).toContain('a.request_id=r.request_id');
  });
  it('rejects command sentinel before loading lines', async () => {
    const f = client(Array.from({ length: 1001 }, () => command), []);
    await expect(loadMdfShadowProofs(f.db, [source])).rejects.toMatchObject({ code: 'COMMAND_LIMIT' });
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it('rejects line sentinel instead of reporting truncated proof', async () => {
    const f = client([command], Array.from({ length: 10001 }, () => line));
    await expect(loadMdfShadowProofs(f.db, [source])).rejects.toMatchObject({ code: 'COMMAND_LINE_LIMIT' });
  });
  it.each([{ stage: 'cut' }, { evidence: 'physical' }, { quantity: NaN }, { orderId: 0 }, { detailId: 1.5 }])
  ('invalid frozen line cannot retire provenance marker: %o', patch => {
    const f = client([command], [{ ...line, ...patch }]);
    return expect(loadMdfShadowProofs(f.db, [source]).then(r => r.get('packet:p')![0].provenanceValid)).resolves.toBe(false);
  });
  it('empty requested scope performs no queries', async () => {
    const f = client([], []); expect((await loadMdfShadowProofs(f.db, [])).size).toBe(0);
    expect(f.query).not.toHaveBeenCalled();
  });
});
