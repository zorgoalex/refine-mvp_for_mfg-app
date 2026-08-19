import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./126_cnc_mdf_forced_cards.sql', import.meta.url), 'utf8');

describe('126 CNC MDF forced cards migration', () => {
  it('adds an additive, constrained card-kind discriminator and active lookup index', () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS mdf_board_card_kind TEXT NOT NULL DEFAULT 'machine_file'");
    expect(sql).toContain("CHECK (mdf_board_card_kind IN ('machine_file', 'bath_seed'))");
    expect(sql).toContain('idx_cnc_telegram_packets_cut_job_card_kind');
    expect(sql).toContain('idx_cnc_telegram_packet_items_unmatched_order_key');
    expect(sql).toContain('idx_cnc_telegram_packet_whole_order_keys_order');
    expect(sql).toContain('INSERT INTO cnc_telegram_packet_whole_order_keys');
    expect(sql).toContain('regexp_matches');
    expect(sql).toContain("'(^|[^0-9])([0-9]{4,})(?=[^0-9]|$)'");
    expect(sql).toContain('WHERE mdf_board_hidden_at IS NULL');
  });
});
