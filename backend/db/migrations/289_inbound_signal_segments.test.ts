import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '289_inbound_signal_segments.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 289: several occurrences of one signal in one message', () => {
  it('adds the segment columns and moves the uniqueness to (message, signal, segment), repeatably, in one transaction', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    for (const column of ['segment_index integer NOT NULL DEFAULT 0', 'segment_text text', 'group_references jsonb', 'visible_text text']) {
      expect(code).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(code).toContain('DROP CONSTRAINT IF EXISTS inbound_signal_occurrences_message_id_signal_code_key');
    expect(code).toContain('UNIQUE (message_id, signal_code, segment_index)');
    expect(code).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint[\s\S]*inbound_signal_occurrences_message_signal_segment_key/);
  });

  it('has a strict end-state probe and a post-apply check in the runner', () => {
    const arm = runner.slice(runner.indexOf('289_inbound_signal_segments*) probe_all'), runner.indexOf(';;', runner.indexOf('289_inbound_signal_segments*) probe_all')));
    for (const column of ['segment_index', 'segment_text', 'group_references', 'visible_text']) {
      expect(arm).toContain(`q_col inbound_signal_occurrences ${column}`);
    }
    expect(arm).toContain('q_con_on inbound_signal_occurrences inbound_signal_occurrences_message_signal_segment_key');
    expect(arm).toContain("NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.inbound_signal_occurrences'::regclass AND conname='inbound_signal_occurrences_message_id_signal_code_key')");
    expect(runner).toMatch(/\n    289_inbound_signal_segments\*\)\n      probe_file/);
  });

  it("keeps migration 173 detectable on a restored schema that already has 289 (either uniqueness key)", () => {
    const arm173 = runner.slice(runner.indexOf('173_inbound_signals*) probe_all'), runner.indexOf(';;', runner.indexOf('173_inbound_signals*) probe_all')));
    expect(arm173).toContain("conname IN ('inbound_signal_occurrences_message_id_signal_code_key','inbound_signal_occurrences_message_signal_segment_key')");
    expect(arm173).not.toContain('q_con_on inbound_signal_occurrences inbound_signal_occurrences_message_id_signal_code_key');
  });
});
