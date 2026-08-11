import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sql = readFileSync(
  fileURLToPath(new URL('./117_mdf_board_manual_moves.sql', import.meta.url)),
  'utf8',
);

describe('117_mdf_board_manual_moves migration', () => {
  it('creates one shared active manual move row per MDF board card', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS mdf_board_manual_moves');
    expect(sql).toContain('CONSTRAINT uq_mdf_board_manual_moves_card UNIQUE (card_kind, card_id)');
    expect(sql).toContain('version BIGINT NOT NULL DEFAULT 1');
    expect(sql).toContain('created_by_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL');
    expect(sql).toContain('updated_by_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL');
  });

  it('locks target columns to the correct card kind matrix', () => {
    expect(sql).toContain("card_kind IN ('packet', 'bazisCutSet')");
    expect(sql).toContain("target_column IN ('parsed', 'completed', 'completed_laminated')");
    expect(sql).toContain("card_kind = 'bath'");
    expect(sql).toContain("target_column IN ('baths', 'baths_ready', 'baths_laminated')");
    expect(sql).toContain("card_kind = 'order'");
    expect(sql).toContain("target_column IN ('orders', 'orders_ready', 'orders_issued')");
  });

  it('adds probe-visible comments and active lookup indexes', () => {
    expect(sql).toContain('idx_mdf_board_manual_moves_lookup');
    expect(sql).toContain('idx_mdf_board_manual_moves_updated');
    expect(sql).toContain('mdf-board-manual-moves-v1: active manual card placement overrides shared by all users');
  });
});
