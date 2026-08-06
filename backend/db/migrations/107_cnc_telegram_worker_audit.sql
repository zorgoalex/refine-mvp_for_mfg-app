-- 107_cnc_telegram_worker_audit.sql
-- Durable, query-ready operational evidence for the SVG Telegram worker.

BEGIN;

CREATE TABLE IF NOT EXISTS cnc_telegram_worker_scans (
  scan_id UUID PRIMARY KEY,
  source_chat_id BIGINT NOT NULL,
  workday DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  session_user_id BIGINT,
  day_yielded_count INTEGER NOT NULL DEFAULT 0,
  day_exhausted BOOLEAN NOT NULL DEFAULT false,
  day_truncated BOOLEAN NOT NULL DEFAULT false,
  day_error_code TEXT,
  reply_search_yielded_count INTEGER NOT NULL DEFAULT 0,
  reply_search_exhausted BOOLEAN NOT NULL DEFAULT false,
  reply_search_truncated BOOLEAN NOT NULL DEFAULT false,
  reply_search_error_code TEXT,
  svg_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  ingested_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  parser_version TEXT NOT NULL,
  worker_version TEXT NOT NULL,
  can_write_chat BOOLEAN NOT NULL DEFAULT false,
  error_code TEXT,
  error_message TEXT,
  writer_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_cnc_tg_worker_scan_status
    CHECK (status IN ('running', 'completed', 'failed', 'abandoned')),
  CONSTRAINT chk_cnc_tg_worker_scan_counts
    CHECK (day_yielded_count >= 0 AND reply_search_yielded_count >= 0 AND svg_count >= 0
      AND processed_count >= 0 AND ingested_count >= 0 AND skipped_count >= 0 AND failed_count >= 0),
  CONSTRAINT chk_cnc_tg_worker_scan_error_lengths
    CHECK (length(COALESCE(error_code, '')) <= 120 AND length(COALESCE(error_message, '')) <= 1000)
);

CREATE TABLE IF NOT EXISTS cnc_telegram_worker_message_logs (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  log_key TEXT NOT NULL UNIQUE,
  raw_source_digest TEXT NOT NULL,
  sanitizer_version TEXT NOT NULL,
  source_chat_id BIGINT NOT NULL,
  source_message_id BIGINT NOT NULL,
  source_thread_id BIGINT,
  reply_to_message_id BIGINT,
  sender_user_id BIGINT,
  source_created_at TIMESTAMPTZ NOT NULL,
  source_edited_at TIMESTAMPTZ,
  workday DATE NOT NULL,
  message_type TEXT NOT NULL,
  filename TEXT,
  mime_type TEXT,
  message_text TEXT,
  outgoing BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'observed',
  reason_code TEXT,
  reason_message TEXT,
  error_code TEXT,
  error_message TEXT,
  related_source_message_id BIGINT,
  external_packet_key TEXT,
  source_version BIGINT,
  packet_id UUID,
  cut_job_id BIGINT,
  cut_result_no INTEGER,
  cutting_sequence_no INTEGER,
  backend_applied BOOLEAN,
  backend_stale BOOLEAN,
  ever_ingested BOOLEAN NOT NULL DEFAULT false,
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  last_decision_at TIMESTAMPTZ,
  last_scan_id UUID REFERENCES cnc_telegram_worker_scans(scan_id) ON DELETE SET NULL,
  observed_count INTEGER NOT NULL DEFAULT 1,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_cnc_tg_worker_message_type
    CHECK (message_type IN ('svg', 'dxf', 'image', 'gcode', 'bot_reply', 'text', 'other')),
  CONSTRAINT chk_cnc_tg_worker_message_status
    CHECK (status IN ('observed', 'used', 'ingested', 'skipped', 'failed')),
  CONSTRAINT chk_cnc_tg_worker_message_bounds
    CHECK (length(COALESCE(filename, '')) <= 255
      AND length(COALESCE(mime_type, '')) <= 120
      AND length(COALESCE(message_text, '')) <= 2000
      AND length(COALESCE(reason_code, '')) <= 120
      AND length(COALESCE(reason_message, '')) <= 1000
      AND length(COALESCE(error_code, '')) <= 120
      AND length(COALESCE(error_message, '')) <= 1000
      AND observed_count > 0 AND attempt_count >= 0)
);

CREATE TABLE IF NOT EXISTS cnc_telegram_worker_operations (
  operation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key TEXT NOT NULL UNIQUE,
  scan_id UUID NOT NULL REFERENCES cnc_telegram_worker_scans(scan_id) ON DELETE CASCADE,
  log_id UUID NOT NULL REFERENCES cnc_telegram_worker_message_logs(log_id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  planned_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  reason_code TEXT,
  reason_message TEXT,
  error_code TEXT,
  error_message TEXT,
  external_packet_key TEXT,
  source_version BIGINT,
  packet_id UUID,
  cut_job_id BIGINT,
  cut_result_no INTEGER,
  cutting_sequence_no INTEGER,
  backend_applied BOOLEAN,
  backend_stale BOOLEAN,
  reply_text TEXT,
  reply_to_message_id BIGINT,
  session_sender_user_id BIGINT,
  sent_telegram_message_id BIGINT,
  reconciliation_yielded_count INTEGER NOT NULL DEFAULT 0,
  reconciliation_exhausted BOOLEAN NOT NULL DEFAULT false,
  reconciliation_truncated BOOLEAN NOT NULL DEFAULT false,
  reconciliation_error_code TEXT,
  reconciliation_window_from TIMESTAMPTZ,
  reconciliation_window_to TIMESTAMPTZ,
  steps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  responses_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_cnc_tg_worker_operation_type
    CHECK (operation_type IN ('message_processing', 'telegram_reply')),
  CONSTRAINT chk_cnc_tg_worker_operation_status
    CHECK (status IN ('planned', 'succeeded', 'skipped', 'failed', 'reconciled', 'ambiguous', 'incomplete')),
  CONSTRAINT chk_cnc_tg_worker_operation_arrays
    CHECK (jsonb_typeof(steps_json) = 'array' AND jsonb_array_length(steps_json) <= 64
      AND jsonb_typeof(responses_json) = 'array' AND jsonb_array_length(responses_json) <= 16),
  CONSTRAINT chk_cnc_tg_worker_operation_bounds
    CHECK (length(COALESCE(reply_text, '')) <= 500
      AND length(COALESCE(reason_code, '')) <= 120
      AND length(COALESCE(reason_message, '')) <= 1000
      AND length(COALESCE(error_code, '')) <= 120
      AND length(COALESCE(error_message, '')) <= 1000
      AND reconciliation_yielded_count >= 0)
);

CREATE TABLE IF NOT EXISTS cnc_telegram_worker_message_observations (
  observation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL REFERENCES cnc_telegram_worker_scans(scan_id) ON DELETE CASCADE,
  log_id UUID NOT NULL REFERENCES cnc_telegram_worker_message_logs(log_id) ON DELETE CASCADE,
  operation_id UUID REFERENCES cnc_telegram_worker_operations(operation_id) ON DELETE CASCADE,
  source_chat_id BIGINT NOT NULL,
  source_message_id BIGINT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  read_source TEXT NOT NULL,
  read_ordinal INTEGER NOT NULL,
  classification_code TEXT NOT NULL,
  decision_code TEXT,
  related_source_message_id BIGINT,
  CONSTRAINT chk_cnc_tg_worker_observation_source
    CHECK (read_source IN ('day_history', 'reply_search', 'reply_reconciliation')),
  CONSTRAINT chk_cnc_tg_worker_observation_ordinal CHECK (read_ordinal > 0),
  CONSTRAINT chk_cnc_tg_worker_observation_owner CHECK (
    (read_source = 'reply_reconciliation' AND operation_id IS NOT NULL)
    OR (read_source <> 'reply_reconciliation' AND operation_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_tg_worker_observation_scan_ordinal
  ON cnc_telegram_worker_message_observations(scan_id, read_source, read_ordinal)
  WHERE operation_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_tg_worker_observation_operation_ordinal
  ON cnc_telegram_worker_message_observations(operation_id, read_source, read_ordinal)
  WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cnc_tg_worker_scans_started
  ON cnc_telegram_worker_scans(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_worker_scans_status_started
  ON cnc_telegram_worker_scans(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_worker_messages_workday
  ON cnc_telegram_worker_message_logs(workday DESC, last_decision_at DESC);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_worker_messages_status
  ON cnc_telegram_worker_message_logs(status, workday DESC);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_worker_messages_type
  ON cnc_telegram_worker_message_logs(message_type, workday DESC);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_worker_messages_reason
  ON cnc_telegram_worker_message_logs(reason_code, workday DESC);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_worker_messages_source
  ON cnc_telegram_worker_message_logs(source_chat_id, source_message_id);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_worker_messages_search
  ON cnc_telegram_worker_message_logs USING GIN (
    to_tsvector('simple', COALESCE(filename, '') || ' ' || COALESCE(message_text, ''))
  );
CREATE INDEX IF NOT EXISTS idx_cnc_tg_worker_observations_scan
  ON cnc_telegram_worker_message_observations(scan_id, read_source, read_ordinal);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_worker_observations_log
  ON cnc_telegram_worker_message_observations(log_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_worker_operations_scan
  ON cnc_telegram_worker_operations(scan_id, planned_at);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_worker_operations_log
  ON cnc_telegram_worker_operations(log_id, planned_at DESC);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_worker_operations_type_status
  ON cnc_telegram_worker_operations(operation_type, status, planned_at DESC);

COMMIT;
