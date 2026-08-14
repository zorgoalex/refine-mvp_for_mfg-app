-- 115_cnc_telegram_packet_mdf_board_hidden.sql
-- Hide machine-file cards from the MDF board when their source cut job is deleted.

BEGIN;

ALTER TABLE cnc_telegram_packets
  ADD COLUMN IF NOT EXISTS mdf_board_hidden_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mdf_board_hidden_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS mdf_board_hidden_reason TEXT,
  ADD COLUMN IF NOT EXISTS mdf_board_hidden_cut_job_id BIGINT REFERENCES cut_job(cut_job_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packets_mdf_visible_workday
  ON cnc_telegram_packets(workday DESC, updated_at DESC)
  WHERE mdf_board_hidden_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packets_mdf_hidden_cut_job
  ON cnc_telegram_packets(mdf_board_hidden_cut_job_id, mdf_board_hidden_at DESC)
  WHERE mdf_board_hidden_at IS NOT NULL;

COMMIT;
