-- Allow terminal hidden bath placements on the MDF work board.

BEGIN;

ALTER TABLE mdf_board_manual_moves
  DROP CONSTRAINT IF EXISTS chk_mdf_board_manual_moves_target_column,
  DROP CONSTRAINT IF EXISTS chk_mdf_board_manual_moves_kind_target;

ALTER TABLE mdf_board_manual_moves
  ADD CONSTRAINT chk_mdf_board_manual_moves_target_column CHECK (
    target_column IN (
      'parsed',
      'completed',
      'completed_laminated',
      'baths',
      'baths_ready',
      'baths_laminated',
      'completed_baths',
      'orders',
      'orders_ready',
      'orders_issued'
    )
  ),
  ADD CONSTRAINT chk_mdf_board_manual_moves_kind_target CHECK (
    (
      card_kind IN ('packet', 'bazisCutSet')
      AND target_column IN ('parsed', 'completed', 'completed_laminated')
    )
    OR (
      card_kind = 'bath'
      AND target_column IN ('baths', 'baths_ready', 'baths_laminated', 'completed_baths')
    )
    OR (
      card_kind = 'order'
      AND target_column IN ('orders', 'orders_ready', 'orders_issued')
    )
  );

COMMENT ON CONSTRAINT chk_mdf_board_manual_moves_target_column ON mdf_board_manual_moves IS
  'mdf-board-manual-moves-v2: includes completed_baths terminal bath column';

COMMIT;
