import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('091 user UI variant LINE/AIR migration', () => {
  const sql = readFileSync(
    resolve(__dirname, '091_user_preferences_line_air_ui_variants.sql'),
    'utf8',
  );
  const runner = readFileSync(
    resolve(__dirname, '../../../ops/apply-migrations.sh'),
    'utf8',
  );

  it('widens the constrained UI variant set and keeps evolution as default', () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS chk_user_preferences_ui_variant/i);
    expect(sql).toMatch(/ui_variant NOT IN \('legacy', 'evolution', 'line', 'air'\)/i);
    expect(sql).toMatch(/ALTER COLUMN ui_variant SET DEFAULT 'evolution'/i);
    expect(sql).toMatch(/CHECK \(ui_variant IN \('legacy', 'evolution', 'line', 'air'\)\)/i);
  });

  it('has a strict end-state probe in the migration runner', () => {
    expect(runner).toMatch(/091_user_preferences_line_air_ui_variants\*\)/);
    expect(runner).toContain("column_default='''evolution''::text'");
    expect(runner).toContain("pg_get_constraintdef(oid) LIKE '%line%'");
    expect(runner).toContain("pg_get_constraintdef(oid) LIKE '%air%'");
    expect(runner).toMatch(/073_\*\|074_\*\|087_\*\|088_\*\|089_\*\|091_\*/);
  });
});
