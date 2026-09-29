import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./211_order_rework_rounds_stage_boundary.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('211 order rework rounds stage boundary migration (B)', () => {
  it('drops only the old «stage once» indexes', () => {
    expect(sql).toContain('DROP INDEX IF EXISTS public.uq_pse_detail_status_once;');
    expect(sql).toContain('DROP INDEX IF EXISTS public.uq_pse_order_status_once;');
    const drops = sql.match(/DROP INDEX[^;]*;/g) ?? [];
    expect(drops).toHaveLength(2);
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN|FUNCTION)/i);
  });

  it('admits only backend writers, in the current round, and past-round-safe deletes', () => {
    expect(sql).toContain("current_setting('erp.pse_writer', true)");
    expect(sql).toContain("NOT IN ('backend', 'historical_import')");
    expect(sql).toContain('STAGE_EVENT_WRITE_REQUIRES_BACKEND');
    expect(sql).toContain('STAGE_EVENT_ROUND_MISMATCH');
    expect(sql).toContain('STAGE_EVENT_PAST_ROUND_DELETE');
    expect(sql).toMatch(/IF TG_OP = 'DELETE' AND NOT v_parent_found THEN\s*RETURN OLD;/);
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON public\.production_status_events/);
    expect(sql).toContain('STAGE_EVENT_IDENTITY_IMMUTABLE');
    expect(sql).toContain('STAGE_EVENT_PAST_ROUND_UPDATE');
    expect(sql).toMatch(/OLD\.event_by IS NOT NULL AND NEW\.event_by IS NULL/);
  });

  it('runs as one transaction and ships a guarded rollback', async () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    const { readFileSync: read } = await import('node:fs');
    const down = read(new URL('../rollback/211_order_rework_rounds_stage_boundary.down.sql', import.meta.url), 'utf8');
    expect(down).toMatch(/^BEGIN;$/m);
    expect(down).toContain('REWORK_211_ROLLBACK_BLOCKED');
    expect(down).toContain('LOCK TABLE public.production_status_events IN ACCESS EXCLUSIVE MODE NOWAIT;');
    expect(down.indexOf('ACCESS EXCLUSIVE MODE NOWAIT')).toBeLessThan(down.indexOf('REWORK_211_ROLLBACK_BLOCKED'));
    expect(down).toContain("DELETE FROM public.schema_migrations WHERE filename = '211_order_rework_rounds_stage_boundary.sql'");
  });

  it('is probed before the ledger records it', () => {
    expect(runner).toContain('211_order_rework_rounds_stage_boundary*) probe_all');
    expect(runner).toContain("q_fun_hash 'public.trg_production_status_events_command_boundary()' 3e164baf56866d058a62346908295f10");
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/211_order_rework_rounds_stage_boundary\*\)\s+probe_file "\$f" \|\| die/);
  });
});
