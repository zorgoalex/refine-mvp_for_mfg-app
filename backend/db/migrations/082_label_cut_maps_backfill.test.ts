import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('082 label cut-map backfill migration', () => {
  const sql = readFileSync(new URL('./082_label_cut_maps_backfill.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('backfills one immutable result per transaction and validates full coverage', () => {
    expect(sql).toContain('CALL backfill_cut_result_label_maps()');
    expect(sql).toMatch(/PERFORM project_cut_result_label_maps\(result_id\);\s+COMMIT;/);
    expect(sql).toContain('cut_result_label_map_expected_counts(r.snapshot_job)');
    expect(sql).toContain('p.sheet_count IS DISTINCT FROM expected.sheet_count');
    expect(sql).toContain('cut-result label-map backfill coverage validation failed');
  });

  it('preserves the applied migration ledger filename in the runner', () => {
    expect(runner).toMatch(/082_label_cut_maps_backfill\*\)\s*probe_true/);
  });
});
