import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./132_user_preferences_sidebar_collapsed.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('132_user_preferences_sidebar_collapsed migration', () => {
  it('adds a nullable per-user sidebar collapsed preference', () => {
    expect(sql).toMatch(/ALTER TABLE user_preferences/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS sidebar_collapsed BOOLEAN/i);
    expect(sql).not.toMatch(/NOT NULL/i);
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toMatch(
      /132_user_preferences_sidebar_collapsed\*\)\s*probe_all\s+"\$\(q_col user_preferences sidebar_collapsed\)"/,
    );
    expect(runner).toMatch(/\|132_\*(?:\||\))/);
  });
});
