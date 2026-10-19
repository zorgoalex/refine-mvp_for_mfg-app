import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '259_payment_audit_capture.sql'), 'utf8');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 259: payment audit capture triggers', () => {
  it('is one bounded transaction, re-runnable', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(2);
    for (const trigger of ['trg_payments_audit_capture', 'trg_orders_audit_capture_insert', 'trg_orders_audit_capture_totals']) {
      expect(sql.indexOf(`DROP TRIGGER IF EXISTS ${trigger}`)).toBeLessThan(sql.indexOf(`CREATE TRIGGER ${trigger}`));
    }
  });

  it('does nothing unless the transaction turned capture on, and keeps only the first image', () => {
    const guards = sql.match(/IF COALESCE\(current_setting\('app\.payment_audit_capture', true\), ''\) <> 'on' THEN\s+RETURN NULL;/g);
    expect(guards).toHaveLength(2);
    expect(sql.match(/ON CONFLICT \(kind, id\) DO NOTHING/g)).toHaveLength(2);
    expect(sql).toContain("CASE WHEN TG_OP = 'INSERT' THEN 'null'::jsonb ELSE to_jsonb(OLD) END");
    expect(sql).toContain("jsonb_build_object('paid_amount', 0, 'payment_status_id', NULL, 'created', true)");
  });

  it('fires AFTER the row change on payments and on order inserts and total updates only', () => {
    expect(sql).toContain('AFTER INSERT OR UPDATE OR DELETE ON public.payments');
    expect(sql).toContain('AFTER INSERT ON public.orders');
    expect(sql).toContain('AFTER UPDATE OF paid_amount, payment_status_id ON public.orders');
  });

  it('has an end-state probe in the migration runner', () => {
    expect(runner).toContain('259_payment_audit_capture*) probe_all');
    expect(runner).toContain('|259_payment_audit_capture*)');
  });
});
