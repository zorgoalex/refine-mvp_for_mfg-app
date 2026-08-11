-- Central source of truth for manual card placement on the MDF work board.

BEGIN;

CREATE TABLE IF NOT EXISTS mdf_board_manual_moves (
  move_id BIGSERIAL PRIMARY KEY,
  card_kind TEXT NOT NULL,
  card_id TEXT NOT NULL,
  target_column TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  created_by_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  updated_by_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_mdf_board_manual_moves_card UNIQUE (card_kind, card_id),
  CONSTRAINT chk_mdf_board_manual_moves_card_kind CHECK (
    card_kind IN ('packet', 'bazisCutSet', 'bath', 'order')
  ),
  CONSTRAINT chk_mdf_board_manual_moves_card_id CHECK (
    length(btrim(card_id)) BETWEEN 1 AND 240
  ),
  CONSTRAINT chk_mdf_board_manual_moves_target_column CHECK (
    target_column IN (
      'parsed',
      'completed',
      'completed_laminated',
      'baths',
      'baths_ready',
      'baths_laminated',
      'orders',
      'orders_ready',
      'orders_issued'
    )
  ),
  CONSTRAINT chk_mdf_board_manual_moves_kind_target CHECK (
    (
      card_kind IN ('packet', 'bazisCutSet')
      AND target_column IN ('parsed', 'completed', 'completed_laminated')
    )
    OR (
      card_kind = 'bath'
      AND target_column IN ('baths', 'baths_ready', 'baths_laminated')
    )
    OR (
      card_kind = 'order'
      AND target_column IN ('orders', 'orders_ready', 'orders_issued')
    )
  ),
  CONSTRAINT chk_mdf_board_manual_moves_version CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS idx_mdf_board_manual_moves_lookup
  ON mdf_board_manual_moves(card_kind, card_id);

CREATE INDEX IF NOT EXISTS idx_mdf_board_manual_moves_updated
  ON mdf_board_manual_moves(updated_at DESC, move_id DESC);

COMMENT ON TABLE mdf_board_manual_moves IS
  'mdf-board-manual-moves-v1: active manual card placement overrides shared by all users';
COMMENT ON COLUMN mdf_board_manual_moves.card_kind IS
  'packet|bazisCutSet|bath|order';
COMMENT ON COLUMN mdf_board_manual_moves.target_column IS
  'MDF board display column key validated by card kind';

COMMIT;
