import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(new URL('./157_products_services_catalog.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');
describe('catalog migration contract', () => {
  it('is additive, unseeded, preserves archived SKU identity and unit FK', () => {
    expect(sql).toContain('lower(sku)) WHERE sku IS NOT NULL');
    expect(sql).toContain('REFERENCES public.units(unit_id) ON DELETE RESTRICT');
    expect(sql).not.toMatch(/ALTER TABLE|DROP |INSERT INTO|DELETE FROM/i);
    expect(sql).toContain("base_price <> 'NaN'::numeric");
  });
  it('has strict end-state verification before ledger advancement', () => {
    expect(runner).toContain('157_products_services_catalog*) probe_all');
    expect(runner).toContain('151_*|152_*|156_*|157_*)');
    for (const name of ['catalog_items_sku_unique', 'catalog_item_commands', 'catalog_items_unit_id_fkey', 'catalog_items_kind_check']) expect(runner).toContain(name);
  });
});
