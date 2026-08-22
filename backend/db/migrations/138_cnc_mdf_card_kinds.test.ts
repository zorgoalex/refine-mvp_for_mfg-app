import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./138_cnc_mdf_card_kinds.sql', import.meta.url), 'utf8');

describe('138_cnc_mdf_card_kinds migration', () => {
  it('separates bath seed packets and indexes normalized whole-order keys', () => {
    expect(sql).toContain('mdf_board_card_kind');
    expect(sql).toContain("CHECK (mdf_board_card_kind IN ('machine_file', 'bath_seed'))");
    expect(sql).toContain('cnc_telegram_packet_whole_order_keys');
    expect(sql).toContain("(?=[^0-9]|$)");
  });
});
