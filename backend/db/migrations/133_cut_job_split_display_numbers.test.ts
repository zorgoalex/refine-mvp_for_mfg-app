import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sql = readFileSync(
  fileURLToPath(new URL('./133_cut_job_split_display_numbers.sql', import.meta.url)),
  'utf8',
);
const runner = readFileSync(
  fileURLToPath(new URL('../../../ops/apply-migrations.sh', import.meta.url)),
  'utf8',
);

describe('133_cut_job_split_display_numbers migration', () => {
  it('backfills regular and vacuum display-number scopes and enforces uniqueness', () => {
    expect(sql).toContain("profile.params->>'layout_mode' = 'vacuum_table'");
    expect(sql).toContain("job.source_display_number ~ '^[0-9]+$'");
    expect(sql).toContain("source_display_number = 'В-' || job.source_display_number");
    expect(sql).toContain('regular_max AS');
    expect(sql).toContain('vacuum_max AS');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_cut_job_source_display_number');
  });

  it('is guarded by apply-migrations end-state probes', () => {
    expect(runner).toContain('133_cut_job_split_display_numbers*');
    expect(runner).toContain('uq_cut_job_source_display_number');
  });
});
