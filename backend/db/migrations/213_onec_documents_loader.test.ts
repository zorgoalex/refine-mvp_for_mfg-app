import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('213 1C documents loader migration', () => {
  const sql = readFileSync(new URL('./213_onec_documents_loader.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('adds only additive loader columns, the pass state and the currency map', () => {
    for (const column of ['observed_fingerprint', 'applied_fingerprint', 'applied_revision', 'load_conflict', 'missing_in_source_at', 'removed_in_onec_at', 'load_conflict_code', 'mapping_issue']) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.onec_documents_load_state');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.onec_currency_map');
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\s+/im);
    expect(sql).not.toMatch(/\bDROP\b/i);
  });

  it('probes the new objects before recording the ledger', () => {
    expect(runner).toContain('213_onec_documents_loader*) probe_all');
    expect(runner).toContain('q_col onec_documents applied_revision');
    expect(runner).toContain('q_col onec_document_lines load_conflict_code');
    expect(runner).toContain('q_tbl onec_documents_load_state');
    expect(runner).toContain('q_tbl onec_currency_map');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/213_onec_documents_loader\*\)\s+probe_file "\$f" \|\| die/);
  });
});
