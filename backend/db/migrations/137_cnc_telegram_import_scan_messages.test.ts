import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./137_cnc_telegram_import_scan_messages.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('137 explicit Telegram import scan messages migration', () => {
  it('defines scan-owned bounded chronological messages and candidate linkage', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS cnc_telegram_import_scan_messages');
    expect(sql).toContain('REFERENCES cnc_telegram_import_scans(scan_id) ON DELETE CASCADE');
    expect(sql).toContain('UNIQUE (scan_id, source_chat_id, source_message_id)');
    expect(sql).toContain('candidate_id UUID REFERENCES cnc_telegram_import_candidates(candidate_id)');
    expect(sql).not.toContain('candidate_id UUID REFERENCES cnc_telegram_import_candidates(candidate_id) ON DELETE CASCADE');
    expect(sql).toContain("candidate_role IN ('svg', 'gcode', 'screenshot', 'comment')");
    expect(sql).toContain('chk_cnc_tg_import_scan_message_role_pair');
    expect(sql).toContain('idx_cnc_tg_import_scan_message_chronological');
    expect(sql).toContain('length(COALESCE(message_text, \'\')) <= 2000');
  });

  it('has an effect probe before the migration ledger can advance', () => {
    expect(runner).toContain('137_cnc_telegram_import_scan_messages*) probe_all');
    expect(runner).toContain('q_tbl cnc_telegram_import_scan_messages');
    expect(runner).toContain('q_con_on cnc_telegram_import_scan_messages chk_cnc_tg_import_scan_message_bounds');
    expect(runner).toContain('q_idx idx_cnc_tg_import_scan_message_chronological');
  });
});
