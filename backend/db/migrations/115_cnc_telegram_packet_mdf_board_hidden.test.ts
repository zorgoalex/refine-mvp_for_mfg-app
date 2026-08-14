import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const sql = readFileSync(
  new URL('./115_cnc_telegram_packet_mdf_board_hidden.sql', import.meta.url),
  'utf8',
);

describe('115_cnc_telegram_packet_mdf_board_hidden migration', () => {
  it('adds MDF board hide metadata to CNC telegram packets', () => {
    expect(sql).toContain('mdf_board_hidden_at TIMESTAMPTZ');
    expect(sql).toContain('mdf_board_hidden_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL');
    expect(sql).toContain('mdf_board_hidden_reason TEXT');
    expect(sql).toContain('mdf_board_hidden_cut_job_id BIGINT REFERENCES cut_job(cut_job_id) ON DELETE SET NULL');
  });

  it('indexes visible board rows and hidden rows by source cut job', () => {
    expect(sql).toContain('idx_cnc_telegram_packets_mdf_visible_workday');
    expect(sql).toContain('WHERE mdf_board_hidden_at IS NULL');
    expect(sql).toContain('idx_cnc_telegram_packets_mdf_hidden_cut_job');
    expect(sql).toContain('WHERE mdf_board_hidden_at IS NOT NULL');
  });
});
