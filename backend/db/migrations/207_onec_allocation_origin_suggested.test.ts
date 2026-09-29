import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';

describe('207 allocation origin «suggested» migration', () => {
  const sql = readFileSync(new URL('./207_onec_allocation_origin_suggested.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('widens the column together with the CHECK (R2-7) and touches nothing else', () => {
    expect(sql).toContain('ALTER COLUMN origin TYPE VARCHAR(16)');
    expect(sql).toContain("CHECK (origin IN ('auto', 'manual', 'suggested'))");
    expect(sql.indexOf('ALTER COLUMN origin TYPE VARCHAR(16)')).toBeLessThan(sql.indexOf('ADD CONSTRAINT chk_orp_alloc_origin'));
    expect(sql).not.toMatch(/\bUPDATE\s+/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM/i);
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });

  it('probes the new column width and constraint before recording the ledger', () => {
    expect(runner).toContain('207_onec_allocation_origin_suggested*) probe_all');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/207_onec_allocation_origin_suggested\*\)\s+probe_file "\$f" \|\| die/);
  });

  it('runner effect gate records only after the probe passes', () => {
    expectMigrationEffectGate(runner, '207_onec_allocation_origin_suggested.sql');
  });
});
