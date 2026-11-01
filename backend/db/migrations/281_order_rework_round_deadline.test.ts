import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./281_order_rework_round_deadline.sql', import.meta.url), 'utf8');
const rollback = readFileSync(new URL('../rollback/281_order_rework_round_deadline.down.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

const COLUMNS = [
  'planned_completion_date',
  'planned_completion_source',
  'suggested_planned_completion_date',
  'from_planned_completion_date',
  'from_completion_date',
  'deadline_sync_requested_at',
  'deadline_sync_request_id',
  'deadline_sync_requested_by',
];

describe('281 order rework round deadline migration', () => {
  it('is additive, in one transaction', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    for (const column of COLUMNS) expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN)|^\s*(UPDATE|DELETE)\s/im);
    // The source is set only together with a date.
    expect(sql).toContain("planned_completion_source IN ('schedule', 'manual') AND planned_completion_date IS NOT NULL");
    expect(sql).toContain('WHERE deadline_sync_requested_at IS NOT NULL');
  });

  it('rolls back only while the columns are empty (they hold the only copy of the previous order dates)', () => {
    for (const column of COLUMNS) {
      expect(rollback).toContain(`OR ${column} IS NOT NULL`.replace('OR planned_completion_date', 'WHERE planned_completion_date'));
      expect(rollback).toContain(`DROP COLUMN IF EXISTS ${column}`);
    }
    expect(rollback).toContain('ROLLBACK_281_REFUSED');
    expect(rollback.indexOf('ROLLBACK_281_REFUSED')).toBeLessThan(rollback.indexOf('DROP COLUMN'));
    // Locked before the emptiness check, held until COMMIT: a concurrent writer cannot fill a column in between.
    expect(rollback).toContain('LOCK TABLE public.order_production_rounds IN ACCESS EXCLUSIVE MODE NOWAIT;');
    expect(rollback.indexOf('LOCK TABLE')).toBeLessThan(rollback.indexOf('ROLLBACK_281_REFUSED'));
  });

  it('is probed before the ledger records it', () => {
    expect(runner).toContain('281_order_rework_round_deadline*) probe_all');
    for (const column of COLUMNS) expect(runner).toContain(`q_col order_production_rounds ${column}`);
    expect(runner).toContain('q_con_on order_production_rounds chk_order_production_rounds_planned_source');
    expect(runner).toContain('q_idx idx_order_production_rounds_deadline_sync');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toContain('281_order_rework_round_deadline*)');
  });
});
