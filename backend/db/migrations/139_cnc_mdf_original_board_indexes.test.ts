import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./139_cnc_mdf_original_board_indexes.sql', import.meta.url), 'utf8');

describe('139 CNC MDF original-board indexes migration', () => {
  it('adds bounded-history indexes without changing rows', () => {
    expect(sql).toContain('idx_cnc_telegram_packets_mdf_original_created');
    expect(sql).toContain('COALESCE(source_created_at, created_at)');
    expect(sql).toContain("WHERE mdf_board_card_kind = 'machine_file'");
    expect(sql).toContain('idx_cut_result_original_board_created_job');
    expect(sql).toContain('created_at DESC, cut_job_id, result_no DESC, revision_no DESC, cut_result_id DESC');
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i);
  });
});
