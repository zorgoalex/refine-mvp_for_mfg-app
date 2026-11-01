import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '280_material_suppliers.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 280: material suppliers', () => {
  it('runs in one transaction under bounded timeouts and is rerun-safe', () => {
    expect(code).toMatch(/^BEGIN;\s*$/m);
    expect(code).toMatch(/^COMMIT;\s*$/m);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    expect(code).toContain("SET LOCAL statement_timeout = '30s';");
    expect(code).toContain('CREATE TABLE IF NOT EXISTS public.material_suppliers');
    expect(code).toContain('ADD COLUMN IF NOT EXISTS vendor_id');
    expect(code.match(/CREATE UNIQUE INDEX IF NOT EXISTS/g)).toHaveLength(6);
  });

  it('is additive: does not touch the 1C supplier journal or the sheet main supplier', () => {
    expect(code).not.toMatch(/resource_suppliers/);
    expect(code).not.toMatch(/ALTER TABLE public\.sheet_material_types/);
    expect(code).not.toMatch(/\bDROP\b/);
  });

  it('keeps exactly one owner per row and a supplier at most once per position', () => {
    expect(code).toContain("resource_kind IN ('film', 'sheet_material', 'extra_resource')");
    for (const kind of ['film', 'sheet', 'extra']) {
      expect(code).toContain(`uq_material_suppliers_${kind}_supplier`);
      expect(code).toContain(`uq_material_suppliers_${kind}_position`);
    }
  });

  it('has an end-state probe and is verified after apply', () => {
    expect(runner).toContain('280_material_suppliers*) probe_all');
    expect(runner).toMatch(/280_material_suppliers\*\)\n\s+probe_file "\$f" \|\| die/);
  });
});
