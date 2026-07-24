import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./085_cut_result_manual_revisions.sql', import.meta.url), 'utf8');

describe('085 cut result manual revisions migration', () => {
  it('keeps one public result number while adding immutable internal revisions', () => {
    expect(sql).toContain('ADD COLUMN revision_no INTEGER NOT NULL DEFAULT 1');
    expect(sql).toContain('DROP CONSTRAINT uq_cut_result_job_no');
    expect(sql).toMatch(/UNIQUE\s*\(cut_job_id,\s*result_no,\s*revision_no\)/i);
    expect(sql).toContain('chk_cut_result_revision_no');
    expect(sql).toContain('revision_no > 0');
  });

  it('indexes newest revision lookup by job and public result number', () => {
    expect(sql).toMatch(
      /CREATE INDEX idx_cut_result_job_no_revision\s+ON cut_result\s*\(cut_job_id,\s*result_no,\s*revision_no DESC\)/i,
    );
  });
});
