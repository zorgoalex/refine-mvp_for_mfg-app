import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';

describe('203 film stock migration', () => {
  const sql = readFileSync(new URL('./203_film_stock.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('creates the stock tables and seeds only the film warehouse', () => {
    for (const table of ['stock_documents', 'stock_document_lines', 'stock_balances', 'stock_movements', 'stock_import_aliases']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
    expect(sql.match(/^\s*INSERT INTO public\./gim) ?? []).toHaveLength(1);
    expect(sql).toMatch(/INSERT INTO public\.warehouses[\s\S]*ON CONFLICT \(warehouse_name\) DO NOTHING/);
    expect(sql).not.toMatch(/^\s*UPDATE\s+/im);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toContain('warehouse_stock');
  });

  it('allows negative balances but keeps the movement ledger consistent', () => {
    const balances = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS public.stock_balances'), sql.indexOf('CREATE INDEX IF NOT EXISTS idx_stock_balances_film'));
    expect(balances).not.toMatch(/CHECK\s*\(\s*quantity\s*>=\s*0/);
    expect(sql).toContain('CHECK (balance_after = balance_before + delta)');
    expect(sql).toContain('uq_stock_movements_document_film UNIQUE (document_id, film_id)');
    expect(sql).toContain("CHECK (order_id IS NULL OR doc_type = 'writeoff')");
    expect(sql).toContain("match_status IN ('alias', 'exact', 'suggested', 'confirmed', 'manual', 'unmatched', 'skipped')");
    expect(sql).toContain("quantity_status IN ('ok', 'needs_review', 'missing', 'confirmed')");
  });

  it('probes every object before recording the ledger', () => {
    expect(runner).toContain('203_film_stock*) probe_all');
    for (const table of ['stock_documents', 'stock_document_lines', 'stock_balances', 'stock_movements', 'stock_import_aliases']) {
      expect(runner).toContain(`q_tbl ${table}`);
    }
    for (const name of ['chk_stock_documents_order_writeoff', 'chk_stock_movements_balance', 'uq_stock_import_aliases_source', 'pk_stock_balances']) {
      expect(runner).toContain(name);
    }
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/203_film_stock\*\)\s+probe_file "\$f" \|\| die/);
  });

  it('runner effect gate records only after the probe passes', () => {
    expectMigrationEffectGate(runner, '203_film_stock.sql');
  });
});
