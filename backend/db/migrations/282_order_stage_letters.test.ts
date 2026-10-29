import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '282_order_stage_letters.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 282: stage letters from details, manual overrides, status «Базис»', () => {
  it('is one bounded, re-runnable transaction', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    for (const table of ['order_detail_stage_routes', 'order_stage_auto_state', 'order_stage_letter_overrides', 'order_stage_letters_rev']) {
      expect(code).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
    expect(code).toContain("ON CONFLICT (production_status_code) DO NOTHING");
  });

  it('adds «Базис» (saw) on the step of «Отрисован»', () => {
    expect(code).toContain("SELECT 'Базис', 'saw', drawn.sort_order");
  });

  it('backfills routes and the automatic state before any recompute trigger exists (no per-order events)', () => {
    const backfill = code.indexOf('INSERT INTO public.order_stage_auto_state (order_id, production_status_id, passed, seq, round_no_at_calc)');
    const firstTrigger = code.indexOf('CREATE TRIGGER');
    expect(backfill).toBeGreaterThan(0);
    expect(backfill).toBeLessThan(firstTrigger);
    expect(code.indexOf("'migration-282'")).toBeLessThan(firstTrigger);
  });

  it('keys the state and the override by (order, stage) — continuous across rework rounds', () => {
    expect(code).toMatch(/order_stage_auto_state[\s\S]*?PRIMARY KEY \(order_id, production_status_id\)/);
    expect(code).toMatch(/order_stage_letter_overrides[\s\S]*?PRIMARY KEY \(order_id, production_status_id\)/);
    expect(code).toContain('ov.auto_seq_at_set = st.seq');
    // a changed automatic value expires the override for good
    expect(code).toContain('DELETE FROM public.order_stage_letter_overrides');
  });

  it('routes follow the detail’s own round and are owned by the snapshot import', () => {
    expect(code).toContain('r.detail_id = od.detail_id AND r.round_no = od.production_round');
    expect(code).toMatch(/trg_order_detail_saw_route[\s\S]*?'historical_import'/);
    expect(code).toContain('OR o.production_round IS DISTINCT FROM n.production_round');
  });

  it('guards the reference: order, activity, active inserts, deletes and semantic codes need the procedure flag', () => {
    expect(code).toContain("current_setting('erp.stage_reference_recompute', true) = 'on'");
    expect(code).toContain("ARRAY['new', 'drawn', 'saw', 'film_purchase', 'hdf', 'issued']");
    expect(code).toContain('BEFORE INSERT OR UPDATE OR DELETE ON public.production_statuses');
  });

  it('records each change of the effective letters once (audit + outbox keyed by the order revision)', () => {
    expect(code).toContain("'production_stage_letters.changed'");
    expect(code).toContain("'order.stage_letters_changed'");
    expect(code).toContain("'stage-letters:' || p_order_id || ':' || v_rev");
  });

  it('shows only the last letter of a finished order', () => {
    // decided by the details (the automatic value), not by a manual «Выдан»
    expect(code).toContain("bool_or(code = 'issued' AND auto)");
    expect(code).toContain("bool_or(b.code = 'issued' AND b.auto)");
    expect(code).not.toContain("code = 'issued' AND shown");
  });

  it('has an end-state probe in the runner', () => {
    expect(runner).toContain('282_order_stage_letters*) probe_all');
    expect(runner).toMatch(/\n    282_order_stage_letters\*\)\n      probe_file/);
  });
});
