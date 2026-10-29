import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '284_stage_letters_cut_ready_saw.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 284: «Базис» in the CNC ready statuses; reconcile after a rollback', () => {
  it('adds saw to the stored ready statuses only next to drawn, keeping the user codes, once', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(code).toContain("(value->'codes') || '[\"saw\"]'::jsonb");
    expect(code).toContain("(value->'codes') ? 'drawn'");
    expect(code).toContain("NOT (value->'codes') ? 'saw'");
  });

  it('reconciles «Базис» with the cards: orders first by id, audited, a CNC-reserved detail kept', () => {
    expect(code).toContain('CREATE OR REPLACE FUNCTION public.reconcile_saw_detail_statuses');
    expect(code).toContain('ORDER BY order_id FOR UPDATE');
    expect(code).toContain("'saw_reconcile'");
    // cards created before the rollback window are never converted (a separate decision)
    expect(code).toContain('b.created_at >= p_since');
    // routes of details that went past the step during the rollback are restored; outbox + correlation as a command
    expect(code).toContain('INSERT INTO public.order_detail_stage_routes (detail_id, round_no, request_id)');
    expect(code).toContain("set_config('erp.request_id', p_request_id, true)");
    expect(code).toContain("'saw-reconcile:' || p_request_id || ':' || v_order");
    expect(code).toContain('c.order_detail_id = od.detail_id AND c.is_active');
  });

  it('has an end-state probe in the runner', () => {
    expect(runner).toContain('284_stage_letters_cut_ready_saw*) probe_all');
    expect(runner).toMatch(/\n    284_stage_letters_cut_ready_saw\*\)\n      probe_file/);
  });
});
