import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./149_cut_result_board_projection.sql', import.meta.url), 'utf8');
const backfill = readFileSync(new URL('./150_cut_result_board_projection_backfill.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('cut-result MDF metadata projection', () => {
  it('projects immutable headers transactionally without rewriting source or placement tables', () => {
    expect(sql).toContain('AFTER INSERT ON cut_result');
    expect(sql).toContain('BEFORE INSERT OR UPDATE OR DELETE ON cut_result_board_projection');
    expect(sql).toContain('ON CONFLICT (cut_result_id) DO NOTHING');
    expect(sql).toContain('p.snapshot_digest = result_row.snapshot_digest');
    expect(sql).not.toMatch(/(?:UPDATE|DELETE FROM|ALTER TABLE)\s+cut_result\b/);
    expect(sql).not.toContain('DISABLE TRIGGER');
    expect(sql).toContain('WHERE is_vacuum = true');
  });
  it('backfills per-result transactions and validates frozen-source coverage', () => {
    expect(backfill).toContain('PERFORM project_cut_result_board_metadata(result_id);\n    COMMIT;');
    expect(backfill).toContain('p.is_vacuum IS DISTINCT FROM cut_result_snapshot_is_vacuum(r.snapshot_job)');
    expect(backfill).toContain('p.snapshot_digest IS DISTINCT FROM r.snapshot_digest');
    expect(runner).toContain('149_cut_result_board_projection*) probe_all');
    expect(runner).toContain('150_cut_result_board_projection_backfill*) probe_true');
    expect(runner).toContain('|149_*|150_*)');
  });
});
