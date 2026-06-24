import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./038_seed_vacuum_cut_profiles.sql', import.meta.url), 'utf8');
// Live (executable) SQL is everything before the commented Down heading. The
// heading is decorated (`-- ── Down ─────`), so match any comment line containing
// "Down" rather than requiring it to immediately follow the dashes.
const liveSql = sql.split(/--[^\n]*Down/i)[0];

describe('038_seed_vacuum_cut_profiles migration', () => {
  it('inserts all 3 seed rows using WHERE NOT EXISTS by seed_key (idempotent)', () => {
    expect(liveSql).toMatch(/WHERE NOT EXISTS\s*\(\s*SELECT 1 FROM cut_param_profiles WHERE seed_key\s*=\s*'vacuum_optimal'/i);
    expect(liveSql).toMatch(/WHERE NOT EXISTS\s*\(\s*SELECT 1 FROM cut_param_profiles WHERE seed_key\s*=\s*'vacuum_width'/i);
    expect(liveSql).toMatch(/WHERE NOT EXISTS\s*\(\s*SELECT 1 FROM cut_param_profiles WHERE seed_key\s*=\s*'vacuum_height'/i);
  });

  it('contains all 3 seed_keys in the live SQL', () => {
    expect(liveSql).toContain("'vacuum_optimal'");
    expect(liveSql).toContain("'vacuum_width'");
    expect(liveSql).toContain("'vacuum_height'");
  });

  it('sets layout_mode to vacuum_table in seeded params', () => {
    expect(liveSql).toContain('vacuum_table');
  });

  it('does NOT contain UPDATE or adoption patterns in the live section', () => {
    expect(liveSql).not.toMatch(/\bUPDATE\b/i);
    expect(liveSql).not.toMatch(/adopt/i);
  });

  it('does NOT use ON CONFLICT on name (loud-abort on name collision is intended)', () => {
    expect(liveSql).not.toMatch(/ON CONFLICT\s*\(name\)/i);
    // ON CONFLICT on seed_key is also not present (WHERE NOT EXISTS is the guard)
    expect(liveSql).not.toMatch(/ON CONFLICT\s*DO NOTHING/i);
  });

  it('documents a reversible Down section that deletes by seed_key', () => {
    expect(sql).toMatch(/--\s*DELETE FROM cut_param_profiles WHERE seed_key IN/i);
    expect(sql).toMatch(/'vacuum_optimal'/);
    expect(sql).toMatch(/'vacuum_width'/);
    expect(sql).toMatch(/'vacuum_height'/);
  });
});
