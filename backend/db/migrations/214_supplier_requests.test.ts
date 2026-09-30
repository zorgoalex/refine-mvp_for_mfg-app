import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';

describe('214 supplier requests migration', () => {
  const sql = readFileSync(new URL('./214_supplier_requests.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('is additive: new tables only, no data changes', () => {
    for (const table of ['supplier_requests', 'supplier_request_lines', 'supplier_request_line_orders', 'supplier_request_counters', 'procurement_command_keys']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table} (`);
    }
    expect(sql).not.toMatch(/\bUPDATE\s+public\./i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM/i);
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
  });

  it('keeps the §5.5 invariants in the schema', () => {
    expect(sql).toContain("CHECK (request_number ~ '^[0-9]{2}-[0-9]{4,}$')");
    expect(sql).toContain("CHECK (status IN ('draft', 'sent', 'closed', 'cancelled'))");
    expect(sql).toContain('CHECK (stock_quantity >= 0 AND stock_quantity <= quantity)');
    expect(sql).toContain('UNIQUE (supplier_request_line_id, order_resource_procurement_id)');
    // supplier_id ⇔ ключ s:<id>
    expect(sql).toContain("(supplier_id IS NULL) = (supplier_key NOT LIKE 's:%')");
    // Страховка инварианта строки: отложенные триггеры на строки и заказы строк.
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER trg_supplier_request_lines_invariant[\s\S]+DEFERRABLE INITIALLY DEFERRED/);
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER trg_supplier_request_line_orders_invariant\s+AFTER INSERT OR UPDATE OR DELETE/);
    expect(sql).toContain('quantity <> l.stock_quantity + COALESCE');
  });

  it('probes the tables, constraints, indexes and triggers before recording the ledger', () => {
    expect(runner).toContain('214_supplier_requests*) probe_all');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/214_supplier_requests\*\)\s+probe_file "\$f" \|\| die/);
  });

  it('runner effect gate records only after the probe passes', () => {
    expectMigrationEffectGate(runner, '214_supplier_requests.sql');
  });
});
