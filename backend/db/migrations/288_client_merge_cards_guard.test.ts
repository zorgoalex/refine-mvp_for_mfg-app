import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '288_client_merge_cards_guard.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');
const apply = readFileSync(resolve(__dirname, '../../src/modules/client-merge/merge-apply.ts'), 'utf8');
const undo = readFileSync(resolve(__dirname, '../../src/modules/client-merge/merge-undo.ts'), 'utf8');

describe('migration 288: only the card-aware merge and undo write the merge journal', () => {
  it('guards INSERT and status changes of client_merges with the session flag, in one transaction', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(code).toContain("current_setting('erp.client_merge_cards', true) = 'on'");
    expect(code).toContain('BEFORE INSERT OR UPDATE OF status ON public.client_merges');
    expect(code).toContain('CLIENT_MERGE_REQUIRES_CARDS');
  });

  it('the merge sets the flag before its journal row, the undo before closing the merge', () => {
    const flag = "set_config('erp.client_merge_cards', 'on', true)";
    expect(apply.indexOf(flag)).toBeGreaterThan(-1);
    expect(apply.indexOf(flag)).toBeLessThan(apply.indexOf('INSERT INTO client_merges'));
    expect(undo.indexOf(flag)).toBeGreaterThan(-1);
    expect(undo.indexOf(flag)).toBeLessThan(undo.indexOf("UPDATE client_merges SET status = 'undone'"));
  });

  it('has an end-state probe in the runner', () => {
    expect(runner).toContain('288_client_merge_cards_guard*) probe_all');
    expect(runner).toMatch(/\n    288_client_merge_cards_guard\*\)\n      probe_file/);
  });
});
