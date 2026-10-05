import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('205 warehouses 1C key required migration', () => {
  const sql = readFileSync(new URL('./205_warehouses_onec_key_required.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('adds the check NOT VALID idempotently and validates only when no warehouse lacks a key', () => {
    expect(sql).toContain('CHECK (ref_key_1c IS NOT NULL) NOT VALID');
    expect(sql).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint[\s\S]*chk_warehouses_ref_key_1c_required/);
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM public\.warehouses WHERE ref_key_1c IS NULL\) THEN\s+ALTER TABLE public\.warehouses VALIDATE CONSTRAINT/);
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\s+/im);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/SET NOT NULL/i);
  });

  it('probes the constraint before recording the ledger', () => {
    expect(runner).toContain('205_warehouses_onec_key_required*) probe_all');
    expect(runner).toContain('q_con_on warehouses chk_warehouses_ref_key_1c_required');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/205_warehouses_onec_key_required\*\)\s+probe_file "\$f" \|\| die/);
  });

  it('does not tie the 203 seed probe to the (renamable) seed warehouse name', () => {
    const probe = runner.slice(runner.indexOf('203_film_stock*) probe_all'), runner.indexOf('203_film_stock*) probe_all') + 200);
    expect(probe).toContain('SELECT EXISTS (SELECT 1 FROM public.warehouses)');
    expect(probe).not.toContain("warehouse_name='Склад плёнки'");
  });
});
