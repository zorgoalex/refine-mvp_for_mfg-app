import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./198_onec_etl.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('migration 198 (1C agent E3a ETL intake and mirror) contract', () => {
  it('is additive: only new onec_etl_ tables', () => {
    expect(sql).not.toMatch(/ALTER TABLE|DROP |DELETE FROM|TRUNCATE/i);
    for (const table of ['onec_etl_runs', 'onec_etl_batches', 'onec_etl_mirror_rows', 'onec_etl_entity_state']) {
      expect(sql).toContain(`CREATE TABLE ${table} (`);
    }
    expect(sql).toContain('CREATE UNLOGGED TABLE onec_etl_staging_rows (');
  });

  it('keeps missing rows as diagnostics, never deletes (plan §20)', () => {
    expect(sql).toContain('missing_in_source_at timestamptz');
    expect(sql).not.toMatch(/deleted_by_absence/);
  });

  it('has a strict end-state probe before ledger advancement', () => {
    expect(runner).toContain('198_onec_etl*) probe_all');
    expect(runner).toMatch(/198_onec_etl\*\)\s+probe_file "\$f" \|\| die/);
    expect(runner).toContain("relpersistence = 'u'");
  });
});
