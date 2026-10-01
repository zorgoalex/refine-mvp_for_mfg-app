import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('219 1C currency conflict migration', () => {
  const sql = readFileSync(new URL('./219_onec_currency_conflict.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('widens the line conflict codes with CURRENCY_CHANGED under a new constraint name', () => {
    expect(sql).toContain('chk_onec_document_lines_conflict_code_v2');
    expect(sql).toContain("'CURRENCY_CHANGED'");
    for (const code of ['QUANTITY_BELOW_ALLOCATED', 'REMOVED_WITH_ALLOCATION', 'MATERIAL_CHANGED', 'UNIT_CHANGED', 'AMOUNT_BELOW_ALLOCATED']) {
      expect(sql).toContain(`'${code}'`);
    }
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\s+/im);
    expect(sql.match(/\bDROP\b/gi)).toHaveLength(1);
  });

  it('probes the new constraint before recording the ledger', () => {
    expect(runner).toContain('219_onec_currency_conflict*) probe_all');
    expect(runner).toContain('q_con_on onec_document_lines chk_onec_document_lines_conflict_code_v2');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/219_onec_currency_conflict\*\)\s+probe_file "\$f" \|\| die/);
  });
});
