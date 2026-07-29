import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('090 user UI variant evolution default migration', () => {
  const sql = readFileSync(
    resolve(__dirname, '090_user_preferences_ui_variant_default_evolution.sql'),
    'utf8',
  );
  const runner = readFileSync(
    resolve(__dirname, '../../../ops/apply-migrations.sh'),
    'utf8',
  );

  it('switches only the database default to evolution', () => {
    expect(sql).toMatch(/ALTER TABLE user_preferences/i);
    expect(sql).toMatch(/ALTER COLUMN ui_variant SET DEFAULT 'evolution'/i);
    expect(sql).not.toMatch(/UPDATE\s+user_preferences/i);
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toMatch(/090_user_preferences_ui_variant_default_evolution\*\)/);
    expect(runner).toContain("column_default='''evolution''::text'");
  });
});
