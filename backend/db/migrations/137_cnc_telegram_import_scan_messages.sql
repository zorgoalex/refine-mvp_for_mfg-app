-- Persist every bounded Telegram message observed by an explicit import scan.
-- This is deliberately separate from the worker audit tables: a manual scan is
-- owned by its import scan and must remain queryable after candidate parsing.
BEGIN;

CREATE TABLE IF NOT EXISTS cnc_telegram_import_scan_messages (
  scan_message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID NOT NULL REFERENCES cnc_telegram_import_scans(scan_id) ON DELETE CASCADE,
  source_chat_id TEXT NOT NULL,
  source_message_id BIGINT NOT NULL,
  source_thread_id BIGINT,
  reply_to_message_id BIGINT,
  sender_user_id BIGINT,
  source_created_at TIMESTAMPTZ NOT NULL,
  source_updated_at TIMESTAMPTZ,
  workday DATE NOT NULL,
  message_type TEXT NOT NULL,
  filename TEXT,
  mime_type TEXT,
  message_text TEXT,
  outgoing BOOLEAN NOT NULL DEFAULT false,
  -- Candidate cleanup must never erase an observed Telegram message. NO ACTION
  -- preserves the snapshot and the candidate/role integrity pair. Deleting the
  -- parent scan still cascades to both candidates and messages.
  candidate_id UUID REFERENCES cnc_telegram_import_candidates(candidate_id),
  candidate_role TEXT,
  read_ordinal INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cnc_tg_import_scan_message_source
    UNIQUE (scan_id, source_chat_id, source_message_id),
  CONSTRAINT chk_cnc_tg_import_scan_message_type
    CHECK (message_type IN ('svg', 'dxf', 'image', 'gcode', 'text', 'other')),
  CONSTRAINT chk_cnc_tg_import_scan_message_role
    CHECK (candidate_role IS NULL OR candidate_role IN ('svg', 'gcode', 'screenshot', 'comment')),
  CONSTRAINT chk_cnc_tg_import_scan_message_bounds
    CHECK (
      length(source_chat_id) BETWEEN 1 AND 120
      AND source_message_id > 0
      AND length(COALESCE(filename, '')) <= 255
      AND length(COALESCE(mime_type, '')) <= 120
      AND length(COALESCE(message_text, '')) <= 2000
      AND read_ordinal > 0
    ),
  CONSTRAINT chk_cnc_tg_import_scan_message_role_pair
    CHECK ((candidate_id IS NULL AND candidate_role IS NULL) OR (candidate_id IS NOT NULL AND candidate_role IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_cnc_tg_import_scan_message_chronological
  ON cnc_telegram_import_scan_messages(scan_id, source_created_at, source_message_id, scan_message_id);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_import_scan_message_ordinal
  ON cnc_telegram_import_scan_messages(scan_id, workday, read_ordinal, source_message_id);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_import_scan_message_candidate
  ON cnc_telegram_import_scan_messages(candidate_id, candidate_role)
  WHERE candidate_id IS NOT NULL;

COMMIT;
