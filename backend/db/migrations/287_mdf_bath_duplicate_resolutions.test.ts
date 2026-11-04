import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '287_mdf_bath_duplicate_resolutions.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 287: MDF bath duplicate resolutions', () => {
  it('runs in one transaction under bounded timeouts and is rerun-safe', () => {
    expect(code).toMatch(/^BEGIN;\s*$/m);
    expect(code).toMatch(/^COMMIT;\s*$/m);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    expect(code).toContain("SET LOCAL statement_timeout = '30s';");
    expect(code).toContain('CREATE TABLE IF NOT EXISTS public.mdf_bath_duplicate_resolutions');
    expect(code.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(2);
  });

  it('is additive: no cut data, history CHECK or placement index changes', () => {
    expect(code).not.toMatch(/\bDROP\b/);
    expect(code).not.toMatch(/ALTER TABLE/);
    expect(code).not.toMatch(/cut_result_placement\s*\(/);
    expect(code).not.toMatch(/mdf_board_history_events/);
  });

  it('keeps a canonical pair, a known action, a pair-side target and a unique command key', () => {
    expect(code).toContain("action IN ('keep_both', 'rework_mark')");
    expect(code).toContain('substring(bath_a FROM 12)::bigint < substring(bath_b FROM 12)::bigint');
    expect(code).toContain('target_bath IN (bath_a, bath_b)');
    expect(code).toContain('CONSTRAINT uq_mdf_bath_duplicate_resolutions_command_key UNIQUE (command_key)');
    expect(code).toContain("digest ~ '^[a-f0-9]{64}$'");
    expect('cut-result:'.length + 1).toBe(12);
  });

  it('has an end-state probe and is verified after apply', () => {
    expect(runner).toContain('287_mdf_bath_duplicate_resolutions*) probe_all');
    expect(runner).toMatch(/287_mdf_bath_duplicate_resolutions\*\)\n\s+probe_file "\$f" \|\| die/);
  });
});
