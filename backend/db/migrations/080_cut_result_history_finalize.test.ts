import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./080_cut_result_history_finalize.sql', import.meta.url), 'utf8');

describe('080 cut result history finalize migration', () => {
  it('requires complete snapshots and same-job current pointer', () => {
    expect(sql).toContain('ALTER COLUMN snapshot_job SET NOT NULL');
    expect(sql).toContain('ALTER COLUMN snapshot_manifest SET NOT NULL');
    expect(sql).toContain('fk_cut_job_current_result_same_job');
    expect(sql).toContain('chk_cut_result_snapshot_shape');
    expect(sql).toContain('cut_result_expected_manifest');
    expect(sql).toContain('p_digest <> cut_result_snapshot_digest(p_snapshot)');
    expect(sql).toContain('manual_piece_keys IS DISTINCT FROM auto_piece_keys');
    expect(sql).toContain("jsonb_array_length(group_json -> 'sheets') = 0");
    expect(sql).toContain("jsonb_object_keys(sheet_json #> '{renderSnapshot,views}')");
    expect(sql).not.toContain('jsonb_object_length');
  });

  it('enforces append-only results and completed command linkage', () => {
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON cut_result');
    expect(sql).toContain('invalid completed cut result command state');
    expect(sql).toContain('calculate command lease ownership and claimed version are required');
    expect(sql).toContain('terminal cut result command is immutable');
    expect(sql).toContain('cut result requires its completed command ledger row');
    expect(sql).toContain('NEW.owner_token IS NOT NULL');
  });
});
