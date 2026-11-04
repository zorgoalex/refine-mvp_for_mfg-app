import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '290_bazis_wins_saw_backfill.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 290: «Базис» wins — «Новый» / «Отрисован» details of «Базис раскрой» cards become «Базис»', () => {
  it('runs in one transaction with a lock timeout', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('moves live new/drawn details in a card, CNC job or not, orders before details', () => {
    expect(code).toContain('od.production_status_id IN (v_new, v_drawn) AND NOT COALESCE(od.delete_flag, false)');
    expect(code).toContain('EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id)');
    expect(code).not.toContain('NOT EXISTS (SELECT 1 FROM public.cut_job_item');
    expect(code.indexOf('ORDER BY o.order_id FOR UPDATE')).toBeLessThan(code.indexOf('INSERT INTO saw_backfill_290 (detail_id'));
    expect(code).toContain('WHERE od.order_id IN (SELECT order_id FROM saw_backfill_290_orders)');
    expect(code.indexOf('INSERT INTO saw_backfill_290 (detail_id')).toBeLessThan(code.indexOf('FOR UPDATE OF od'));
    expect(code).toContain("set_config('erp.request_id', 'migration-290', true)");
    expect(code).toContain('IF v_saw IS NOT NULL AND v_new IS NOT NULL AND v_drawn IS NOT NULL THEN');
  });

  it('writes what the saw sync writes: version, audit with transitions, outbox once per order, a summary row', () => {
    expect(code).toContain('UPDATE public.orders SET version = version + 1');
    expect(code).toContain("'orders.detail_production_status_auto_change', 'order'");
    expect(code).toContain("jsonb_build_object('detailId', detail_id, 'from', from_code, 'to', 'saw')");
    expect(code).toContain('INSERT INTO public.audit_log_related_entity');
    expect(code).toContain("'saw-backfill:290:' || v_order.order_id");
    expect(code).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(code).toContain("'orders.saw_status_backfill', 'migration', '290'");
  });

  it('runs once: serialized, and a repeat changes nothing', () => {
    expect(code).toContain("pg_advisory_xact_lock(hashtext('erp-migration-290-bazis-wins-saw-backfill'))");
    const guard = code.indexOf("IF EXISTS (SELECT 1 FROM public.audit_log WHERE event = 'orders.saw_status_backfill'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(code.indexOf('UPDATE public.order_details'));
    expect(code.slice(guard, guard + 400)).toContain("entity_id = '290'");
    expect(code.slice(guard, guard + 400)).toContain('RETURN;');
  });

  it('the «Базис» route is dropped on saw → new or drawn in the same round (before the backfill)', () => {
    expect(code).toContain('CREATE OR REPLACE FUNCTION public.trg_order_detail_saw_route()');
    expect(code).toContain("production_status_code IN ('new', 'drawn')");
    expect(code.indexOf('CREATE OR REPLACE FUNCTION')).toBeLessThan(code.indexOf('DO $$'));
  });

  it('drops stale «Базис» routes of new/drawn details in their round, orders locked first', () => {
    expect(code).toContain('DELETE FROM public.order_detail_stage_routes r USING public.order_details od');
    expect(code).toContain('AND od.production_status_id IN (v_new, v_drawn)');
    expect(code.indexOf('ORDER BY o.order_id FOR UPDATE')).toBeLessThan(code.indexOf('DELETE FROM public.order_detail_stage_routes r USING'));
    expect(code).toContain('AND od.order_id IN (SELECT order_id FROM saw_backfill_290_orders)\n         AND od.production_status_id IN (v_new, v_drawn)');
    expect(code).toContain("'staleRoutesDropped', v_stale_routes");
  });

  it('holds a write barrier (orders, then details) before any candidate is read, after the trigger is replaced', () => {
    const orders = code.indexOf('LOCK TABLE public.orders IN EXCLUSIVE MODE;');
    const details = code.indexOf('LOCK TABLE public.order_details IN SHARE MODE;');
    expect(orders).toBeGreaterThan(code.indexOf('CREATE OR REPLACE FUNCTION public.trg_order_detail_saw_route()'));
    expect(orders).toBeLessThan(details);
    expect(details).toBeLessThan(code.indexOf('WITH locked AS'));
  });

  it('audits every dropped route per order (detail, round, status), with related details', () => {
    expect(code).toContain("'orders.stage_route_repair', 'order'");
    expect(code).toContain("jsonb_build_object('detailId', detail_id, 'roundNo', round_no, 'status', status_code");
    expect(code).toContain('FROM saw_routes_290 GROUP BY order_id ORDER BY order_id');
  });

  it('has an end-state probe in the runner', () => {
    expect(runner).toContain('290_bazis_wins_saw_backfill*) probe_all');
    expect(runner).toMatch(/\n    290_bazis_wins_saw_backfill\*\)\n      probe_file/);
  });
});
