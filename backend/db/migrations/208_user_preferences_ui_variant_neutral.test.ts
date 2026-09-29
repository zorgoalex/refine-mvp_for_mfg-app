import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';

describe('208 user UI variant NEUTRAL migration', () => {
  const sql = readFileSync(
    resolve(__dirname, '208_user_preferences_ui_variant_neutral.sql'),
    'utf8',
  );
  const runner = readFileSync(
    resolve(__dirname, '../../../ops/apply-migrations.sh'),
    'utf8',
  );

  it('widens the constrained UI variant set to include neutral and keeps evolution as default', () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS chk_user_preferences_ui_variant/i);
    expect(sql).toMatch(/ui_variant NOT IN \('legacy', 'evolution', 'line', 'air', 'neutral'\)/i);
    expect(sql).toMatch(/ALTER COLUMN ui_variant SET DEFAULT 'evolution'/i);
    expect(sql).toMatch(/CHECK \(ui_variant IN \('legacy', 'evolution', 'line', 'air', 'neutral'\)\)/i);
  });

  it('has a strict end-state probe in the migration runner', () => {
    expect(runner).toMatch(/208_user_preferences_ui_variant_neutral\*\)/);
    expect(runner).toContain("column_default='''evolution''::text'");
    expect(runner).toContain("pg_get_constraintdef(oid) LIKE '%neutral%'");
  });

  it('runner effect gate records only after the probe passes', () => {
    expectMigrationEffectGate(runner, '208_user_preferences_ui_variant_neutral.sql');
  });
});
