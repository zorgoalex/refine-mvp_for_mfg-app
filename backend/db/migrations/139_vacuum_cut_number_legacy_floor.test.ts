import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  fileURLToPath(new URL('./139_vacuum_cut_number_legacy_floor.sql', import.meta.url)),
  'utf8',
);
const runner = readFileSync(
  fileURLToPath(new URL('../../../ops/apply-migrations.sh', import.meta.url)),
  'utf8',
);

describe('139_vacuum_cut_number_legacy_floor migration', () => {
  it('restores legacy bath numbers and allocates post-split numbers above their range', () => {
    expect(sql).toContain("pg_advisory_xact_lock(hashtext('cut_job_display_number:vacuum'))");
    expect(sql).toContain("filename = '133_cut_job_split_display_numbers.sql'");
    expect(sql).toContain("WHEN v.created_at < b.applied_at THEN 'В-' || v.cut_job_id::text");
    expect(sql).toContain('floor.value');
    expect(sql).toContain('row_number() OVER');
    expect(sql).toContain('SET source_display_number = NULL');
  });

  it('has a guarded migration-runner end-state probe', () => {
    expect(runner).toContain('139_vacuum_cut_number_legacy_floor*');
    expect(runner).toContain("j.source_display_number IS DISTINCT FROM 'В-' || j.cut_job_id::text");
    expect(runner).toContain('substring(j.source_display_number FROM 3)::integer <= floor.value');
  });
});
