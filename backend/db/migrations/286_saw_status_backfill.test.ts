import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '286_saw_status_backfill.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 286: «Базис» for «Новый» details already in «Базис раскрой» cards', () => {
  it('runs in one transaction with a lock timeout', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('moves only live «Новый» details in a card and not in a CNC job, orders before details', () => {
    expect(code).toContain('od.production_status_id = v_new AND NOT COALESCE(od.delete_flag, false)');
    expect(code).toContain('EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id)');
    expect(code).toContain('NOT EXISTS (SELECT 1 FROM public.cut_job_item c WHERE c.order_detail_id = od.detail_id AND c.is_active)');
    // FOR UPDATE conflicts with the FOR KEY SHARE of a CNC reservation; candidates come from a later statement
    expect(code.indexOf('ORDER BY o.order_id FOR UPDATE')).toBeLessThan(code.indexOf('INSERT INTO saw_backfill_286 (detail_id'));
    expect(code).toContain('WHERE od.order_id IN (SELECT order_id FROM saw_backfill_286_orders)');
    expect(code.indexOf('INSERT INTO saw_backfill_286 (detail_id')).toBeLessThan(code.indexOf('FOR UPDATE OF od'));
    expect(code).toContain("set_config('erp.request_id', 'migration-286', true)");
    expect(code).toContain('IF v_saw IS NOT NULL AND v_new IS NOT NULL THEN');
  });

  it('writes what the saw sync writes: version, audit with details, outbox once per order, and a summary row', () => {
    expect(code).toContain('UPDATE public.orders SET version = version + 1');
    expect(code).toContain("'orders.detail_production_status_auto_change', 'order'");
    expect(code).toContain('INSERT INTO public.audit_log_related_entity');
    expect(code).toContain("'saw-backfill:286:' || v_order.order_id");
    expect(code).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(code).toContain("'orders.saw_status_backfill', 'migration', '286'");
  });

  it('runs once: serialized, and a repeat after a commit without the ledger row changes nothing', () => {
    expect(code).toContain("pg_advisory_xact_lock(hashtext('erp-migration-286-saw-status-backfill'))");
    const guard = code.indexOf("IF EXISTS (SELECT 1 FROM public.audit_log WHERE event = 'orders.saw_status_backfill'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(code.indexOf('UPDATE public.order_details'));
    expect(code.slice(guard, guard + 400)).toContain('RETURN;');
  });

  it('has an end-state probe in the runner', () => {
    expect(runner).toContain('286_saw_status_backfill*) probe_all');
    expect(runner).toMatch(/\n    286_saw_status_backfill\*\)\n      probe_file/);
  });
});
