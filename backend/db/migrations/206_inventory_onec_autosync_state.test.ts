import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('206 inventory 1C autosync state migration', () => {
  const sql = readFileSync(new URL('./206_inventory_onec_autosync_state.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('creates only the additive state table with ordered sequence constraints', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.inventory_onec_autosync_state');
    expect(sql).toContain('REFERENCES public.onec_sources(source_id)');
    expect(sql).toContain('CHECK (finished_seq >= 0 AND finished_seq <= last_seq)');
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\s+/im);
    expect(sql).not.toMatch(/\b(DROP|ALTER)\b/i);
  });

  it('probes the table and its constraint before recording the ledger', () => {
    expect(runner).toContain('206_inventory_onec_autosync_state*) probe_all');
    expect(runner).toContain('q_tbl inventory_onec_autosync_state');
    expect(runner).toContain('q_con_on inventory_onec_autosync_state chk_inventory_onec_autosync_seq');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/206_inventory_onec_autosync_state\*\)\s+probe_file "\$f" \|\| die/);
  });
});
