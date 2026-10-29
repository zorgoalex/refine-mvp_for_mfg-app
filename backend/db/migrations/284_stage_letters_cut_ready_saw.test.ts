import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '284_stage_letters_cut_ready_saw.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 284: «Базис» in the CNC ready statuses; card composition only with the saw sync', () => {
  it('adds saw to the stored ready statuses only next to drawn, keeping the user codes, once', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(code).toContain("(value->'codes') || '[\"saw\"]'::jsonb");
    expect(code).toContain("(value->'codes') ? 'drawn'");
    expect(code).toContain("NOT (value->'codes') ? 'saw'");
  });

  it('lets only the saw-sync commands change the composition of «Базис раскрой» cards (FK actions pass)', () => {
    expect(code).toContain("current_setting('erp.bazis_cut_saw_sync', true) = 'on' OR pg_trigger_depth() > 1");
    expect(code).toContain('BEFORE INSERT OR DELETE OR UPDATE OF source_order_detail_id ON public.bazis_cut_set_details');
    expect(code).toContain('DROP FUNCTION IF EXISTS public.reconcile_saw_detail_statuses(timestamptz, text);');
  });

  it('has an end-state probe in the runner', () => {
    expect(runner).toContain('284_stage_letters_cut_ready_saw*) probe_all');
    expect(runner).toMatch(/\n    284_stage_letters_cut_ready_saw\*\)\n      probe_file/);
  });
});
