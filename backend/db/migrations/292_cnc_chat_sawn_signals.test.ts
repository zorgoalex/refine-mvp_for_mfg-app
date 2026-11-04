import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '292_cnc_chat_sawn_signals.sql'), 'utf8');
const code = sql.replace(/--.*$/gm, '');
const runner = readFileSync(resolve(__dirname, '../../../ops/apply-migrations.sh'), 'utf8');

describe('migration 292: «Распилено» signals from the CNC chat', () => {
  it('is additive, repeatable and runs in one transaction', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    for (const table of ['cnc_chat_signal_messages', 'cnc_chat_signal_claims', 'cnc_chat_sawn_packet_signals',
      'cnc_chat_sawn_signals', 'cnc_chat_signal_return_resets', 'cnc_chat_signal_commands']) {
      expect(code).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
    expect(code).not.toMatch(/^\s*(ALTER|DROP|UPDATE|DELETE|TRUNCATE)\b/m);
  });

  it('allows at most one open signal per packet and one open episode per reactor', () => {
    expect(code).toMatch(/uq_cnc_chat_sawn_packet_signals_open\s+ON cnc_chat_sawn_packet_signals \(packet_id\) WHERE closed_observed_at IS NULL/);
    expect(code).toMatch(/uq_cnc_chat_sawn_signals_open_episode\s+ON cnc_chat_sawn_signals \(chat_id, message_id, reactor_peer_type, reactor_peer_id\)/);
    expect(code).toContain("reactor_peer_type IN ('user','channel','chat','anonymous')");
  });

  it('knows every apply state of the plan table and binds a reset to one return generation', () => {
    for (const state of ['pending', 'held_disabled', 'held_baseline', 'held_history', 'held_return_barrier',
      'held_engine', 'retry_wait', 'failed_final', 'applied', 'already_completed', 'closed']) {
      expect(code).toContain(`'${state}'`);
    }
    expect(code).toMatch(/return_ref text NOT NULL/);
    expect(code).toMatch(/packet_return_refs jsonb NOT NULL/);
    expect(code).toMatch(/uq_cnc_chat_signal_return_resets_active\s+ON cnc_chat_signal_return_resets \(packet_id, return_ref\)/);
  });

  it('seeds the automatic move switch OFF without overwriting an existing value', () => {
    expect(code).toContain("'cnc_chat_signals.apply_to_packet', '{\"value\": false}'::jsonb");
    expect(code).toContain('ON CONFLICT (setting_key) DO NOTHING');
  });

  it('has a strict end-state probe and a post-apply check in the runner', () => {
    const start = runner.indexOf('292_cnc_chat_sawn_signals*) probe_all');
    const arm = runner.slice(start, runner.indexOf(';;', start));
    for (const table of ['cnc_chat_signal_messages', 'cnc_chat_signal_claims', 'cnc_chat_sawn_packet_signals',
      'cnc_chat_sawn_signals', 'cnc_chat_signal_return_resets', 'cnc_chat_signal_commands']) {
      expect(arm).toContain(`q_tbl ${table}`);
    }
    expect(arm).toContain('q_idx uq_cnc_chat_sawn_packet_signals_open');
    expect(arm).toContain("setting_key='cnc_chat_signals.apply_to_packet'");
    expect(runner).toMatch(/\n    292_cnc_chat_sawn_signals\*\)\n      probe_file/);
  });
});
