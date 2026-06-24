import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./037_cut_param_profile_seed_key.sql', import.meta.url), 'utf8');
// Live (executable) SQL is everything before the commented Down heading. The
// heading is decorated (`-- ── Down ─────`), so match any comment line containing
// "Down" rather than requiring it to immediately follow the dashes.
const liveSql = sql.split(/--[^\n]*Down/i)[0];

describe('037_cut_param_profile_seed_key migration', () => {
  it('adds the nullable seed_key column additively (no live DROP)', () => {
    expect(liveSql).toMatch(/ALTER TABLE cut_param_profiles\s+ADD COLUMN IF NOT EXISTS seed_key TEXT/i);
    expect(liveSql).not.toMatch(/DROP COLUMN/i); // executable section must not drop anything
    expect(liveSql).not.toMatch(/DROP INDEX/i);  // executable section must not drop anything
  });

  it('creates a partial unique index on seed_key WHERE seed_key IS NOT NULL', () => {
    expect(liveSql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_cut_param_profiles_seed_key\s+ON cut_param_profiles\(seed_key\)\s+WHERE seed_key IS NOT NULL/i);
  });

  it('documents a reversible Down section that drops the index and column', () => {
    expect(sql).toMatch(/--\s*DROP INDEX IF EXISTS uq_cut_param_profiles_seed_key/i);
    expect(sql).toMatch(/--\s*ALTER TABLE cut_param_profiles DROP COLUMN IF EXISTS seed_key/i);
  });
});
