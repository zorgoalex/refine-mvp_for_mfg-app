import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';

describe('194 order resource procurement migration', () => {
  const sql = readFileSync(new URL('./194_order_resource_procurement.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('is additive: creates one table and never backfills or touches existing tables', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.order_resource_procurement');
    expect(sql).not.toMatch(/\bUPDATE\s+/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toContain('order_resource_requirements (');
  });

  it('keeps one real FK per resource kind and one row per order material', () => {
    expect(sql).toContain('REFERENCES public.orders(order_id)');
    expect(sql).toContain('REFERENCES public.sheet_material_types(sheet_material_type_id)');
    expect(sql).toContain('REFERENCES public.films(film_id)');
    expect(sql).toContain("resource_kind = 'sheet_material' AND sheet_material_type_id IS NOT NULL AND film_id IS NULL");
    expect(sql).toContain("resource_kind = 'film' AND film_id IS NOT NULL AND sheet_material_type_id IS NULL");
    expect(sql).toMatch(/uq_orp_order_sheet_material[\s\S]*WHERE resource_kind = 'sheet_material'/);
    expect(sql).toMatch(/uq_orp_order_film[\s\S]*WHERE resource_kind = 'film'/);
  });

  it('requires who/when and the demand snapshot for every purchased mark', () => {
    expect(sql).toContain('NOT purchased OR (marked_at IS NOT NULL AND origin IS NOT NULL AND demand_fingerprint_at_mark IS NOT NULL)');
    expect(sql).toContain("demand_fingerprint_at_mark ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain('CHECK (version >= 1)');
  });

  it('probes the table, every constraint and index before recording the ledger', () => {
    expect(runner).toContain('194_order_resource_procurement*) probe_all');
    expect(runner).toContain('q_tbl order_resource_procurement');
    for (const name of ['chk_orp_resource_kind', 'chk_orp_one_ref', 'chk_orp_origin', 'chk_orp_unit',
      'chk_orp_version', 'chk_orp_fingerprint', 'chk_orp_marked_snapshot']) {
      expect(runner).toContain(`q_con_on order_resource_procurement ${name}`);
    }
    for (const index of ['uq_orp_order_sheet_material', 'uq_orp_order_film', 'idx_orp_order']) {
      expect(runner).toContain(`q_idx ${index}`);
    }
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/194_order_resource_procurement\*\)\s+probe_file "\$f" \|\| die/);
  });

  it('runner effect gate records only after the probe passes', () => {
    expectMigrationEffectGate(runner, '194_order_resource_procurement.sql');
  });
});
