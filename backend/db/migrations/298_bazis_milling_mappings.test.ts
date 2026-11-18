import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '298_bazis_milling_mappings.sql'), 'utf8');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 298: Bazis milling mappings', () => {
  it('is one bounded transaction', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('adds a nullable milling_type_id referencing milling_types and touches no data', () => {
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS milling_type_id bigint NULL REFERENCES public.milling_types(milling_type_id)',
    );
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bINSERT\b|\bDROP\s+(TABLE|COLUMN)\b/i);
  });

  it('extends source/target kinds with milling and keeps every old branch exclusive of milling_type_id', () => {
    expect(sql).toContain("CHECK (source_kind IN ('sheet', 'film', 'edge', 'milling'))");
    expect(sql).toContain("CHECK (target_kind IN ('sheet', 'film', 'edge', 'milling', 'ignore'))");
    for (const kind of ['ignore', 'sheet', 'film', 'edge']) {
      const branch = sql.split('\n').find((line) => line.includes(`(target_kind = '${kind}'`));
      expect(branch, kind).toContain('milling_type_id IS NULL');
    }
    expect(sql).toContain("(target_kind = 'milling' AND milling_type_id IS NOT NULL");
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toContain('298_bazis_milling_mappings*) probe_all');
    expect(runner).toMatch(/298_bazis_milling_mappings\*\)\n\s+probe_file "\$f"/);
    const start = runner.indexOf('298_bazis_milling_mappings*) probe_all');
    const probe = runner.slice(start, runner.indexOf(';;', start));
    expect(probe).toContain('q_col bazis_material_mappings milling_type_id');
    for (const name of [
      'bazis_material_mappings_source_kind_check',
      'bazis_material_mappings_target_kind_check',
      'bazis_material_mappings_target_chk',
    ]) {
      expect(probe).toContain(name);
    }
  });
});
