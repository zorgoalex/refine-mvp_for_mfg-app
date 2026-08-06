-- 108_cnc_telegram_worker_audit_reason_codes.sql
-- Close the worker decision/error taxonomy at the database boundary.

BEGIN;

CREATE OR REPLACE FUNCTION cnc_telegram_worker_reason_code_valid(value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT value IS NULL OR value = ANY (ARRAY[
    'message_observed','message_classified','svg_selected','comment_selected',
    'image_selected','gcode_selected','source_unchanged','payload_unchanged',
    'unsupported_dxf','unsupported_message_type','no_svg_association',
    'svg_download_failed','svg_invalid_layout','image_download_failed','image_ignored',
    'gcode_download_failed','gcode_parse_failed','gcode_ignored','packet_built',
    'backend_ingest_succeeded','backend_ingest_failed','state_updated',
    'reply_selected','reply_invalid_number','reply_wrong_target','reply_foreign_sender',
    'reply_not_outgoing','reply_older_than_selected','reply_ambiguous',
    'reply_outside_business_window','reply_unrelated','reply_send_planned',
    'reply_send_succeeded','reply_send_failed','reconciliation_match',
    'reconciliation_wrong_target','reconciliation_wrong_text','reconciliation_foreign_sender',
    'reconciliation_not_outgoing','reconciliation_outside_window','reconciliation_ambiguous',
    'reconciliation_incomplete','worker_restarted_before_scan_completion',
    'iterator_limit_reached','telegram_read_failed','audit_delivery_failed','audit_spool_failed',
    'backend_capability_failed','unexpected_worker_error'
  ]::TEXT[]);
$fn$;

ALTER TABLE cnc_telegram_worker_scans
  ADD CONSTRAINT chk_cnc_tg_worker_scan_reason_codes CHECK (
    cnc_telegram_worker_reason_code_valid(day_error_code)
    AND cnc_telegram_worker_reason_code_valid(reply_search_error_code)
    AND cnc_telegram_worker_reason_code_valid(error_code)
  );

ALTER TABLE cnc_telegram_worker_message_logs
  ADD CONSTRAINT chk_cnc_tg_worker_message_reason_codes CHECK (
    cnc_telegram_worker_reason_code_valid(reason_code)
    AND cnc_telegram_worker_reason_code_valid(error_code)
  );

ALTER TABLE cnc_telegram_worker_operations
  ADD CONSTRAINT chk_cnc_tg_worker_operation_reason_codes CHECK (
    cnc_telegram_worker_reason_code_valid(reason_code)
    AND cnc_telegram_worker_reason_code_valid(error_code)
    AND cnc_telegram_worker_reason_code_valid(reconciliation_error_code)
  );

ALTER TABLE cnc_telegram_worker_message_observations
  ADD CONSTRAINT chk_cnc_tg_worker_observation_reason_codes CHECK (
    cnc_telegram_worker_reason_code_valid(decision_code)
  );

COMMIT;
