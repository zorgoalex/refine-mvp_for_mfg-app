import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./142_cnc_telegram_manual_send_routing.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('142 CNC Telegram manual send routing migration', () => {
  it('adds explicit destinations, quarantines legacy pending sends, and stores runtime evidence', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS destination_chat_id TEXT');
    expect(sql).toContain('idx_cnc_manual_svg_telegram_send_destination_claim');
    expect(sql).toContain("last_error='ROUTING_V2_LEGACY_REQUEST_NOT_REPLAYED'");
    expect(sql).toContain("WHERE status IN ('pending', 'processing')");
    expect(sql).toContain('AND destination_chat_id IS NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS can_send_manual_svg_uploads BOOLEAN');
    expect(sql).toContain('manual_svg_send_poll_interval_seconds DOUBLE PRECISION');
    expect(sql).toContain('chk_cnc_tg_session_runtime_evidence');
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toContain('142_cnc_telegram_manual_send_routing*) probe_all');
    expect(runner).toContain('q_col cnc_manual_svg_telegram_send_requests destination_chat_id');
    expect(runner).toContain('q_idx idx_cnc_manual_svg_telegram_send_destination_claim');
    expect(runner).toContain('q_col cnc_telegram_worker_session_leases can_send_manual_svg_uploads');
    expect(runner).toContain('q_con_on cnc_telegram_worker_session_leases chk_cnc_tg_session_runtime_evidence');
  });
});
