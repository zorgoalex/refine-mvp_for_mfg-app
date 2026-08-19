-- Support the fixed two-calendar-month MDF original-board history projection.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packets_mdf_original_created
  ON cnc_telegram_packets ((COALESCE(source_created_at, created_at)) DESC, packet_id)
  WHERE mdf_board_card_kind = 'machine_file';

CREATE INDEX IF NOT EXISTS idx_cut_result_original_board_created_job
  ON cut_result (created_at DESC, cut_job_id, result_no DESC, revision_no DESC, cut_result_id DESC);

COMMIT;
