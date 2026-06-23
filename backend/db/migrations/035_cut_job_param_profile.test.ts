import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./035_cut_job_param_profile.sql', import.meta.url), 'utf8');
// Live (executable) SQL is everything before the commented Down heading. The
// heading is decorated (`-- ── Down ─────`), so match any comment line containing
// "Down" rather than requiring it to immediately follow the dashes.
const liveSql = sql.split(/--[^\n]*Down/i)[0];

describe('035_cut_job_param_profile migration', () => {
  it('adds the nullable param_profile_id column additively (no live DROP)', () => {
    expect(liveSql).toMatch(/ALTER TABLE cut_job\s+ADD COLUMN IF NOT EXISTS param_profile_id BIGINT/i);
    expect(liveSql).not.toMatch(/DROP COLUMN/i); // executable section must not drop anything
  });
  it('references cut_param_profiles with ON DELETE SET NULL', () => {
    expect(sql).toMatch(/FOREIGN KEY\s*\(param_profile_id\)\s*REFERENCES cut_param_profiles\(cut_param_profile_id\)/i);
    expect(sql).toMatch(/ON DELETE SET NULL/i);
  });
  it('indexes the new fk column', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_cut_job_param_profile_id\s+ON cut_job\(param_profile_id\)/i);
  });
  it('documents a reversible Down section', () => {
    expect(sql).toMatch(/--\s*ALTER TABLE cut_job DROP COLUMN IF EXISTS param_profile_id/i);
  });
});
