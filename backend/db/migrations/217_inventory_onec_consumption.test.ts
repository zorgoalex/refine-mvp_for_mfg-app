import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('217 inventory 1C consumption projection migration', () => {
  const sql = readFileSync(new URL('./217_inventory_onec_consumption.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('is additive: widens checks, adds nullable columns and new tables, touches no data', () => {
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\s+/im);
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX)/i);
    expect(sql).toContain("CHECK (doc_type IN ('receipt', 'writeoff', 'inventory', 'onec'))");
    expect(sql).toContain("CHECK (source IN ('manual', 'import', 'onec'))");
    expect(sql).toContain("CHECK (movement_type IN ('receipt', 'writeoff', 'inventory_adjustment', 'onec'))");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS onec_consumption_since TIMESTAMPTZ NULL/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS counted_at TIMESTAMPTZ NULL/);
    for (const table of ['inventory_onec_projection', 'inventory_onec_applied', 'inventory_onec_issues', 'inventory_onec_generation']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
    // Без FK на onec_documents (загрузчик удаляет документ при смене вида).
    expect(sql).not.toMatch(/REFERENCES public\.onec_documents/);
    // Шкала применённого расхода = шкала учёта.
    expect(sql).toMatch(/quantity NUMERIC\(12,2\) NOT NULL/);
  });

  it('probes every object and the widened checks before recording the ledger', () => {
    expect(runner).toContain('217_inventory_onec_consumption*) probe_all');
    for (const probe of ['q_col warehouses onec_consumption_since', 'q_tbl inventory_onec_generation', 'q_idx uq_stock_documents_onec_projection',
      "q_con_def_on_safe chk_stock_movements_type stock_movements"]) expect(runner).toContain(probe);
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/217_inventory_onec_consumption\*\)\s+probe_file "\$f" \|\| die/);
  });
});
