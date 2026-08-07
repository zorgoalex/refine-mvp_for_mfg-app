-- 111_cnc_telegram_media_restore.sql
-- Durable, worker-owned restoration queue for expired Telegram sheet screenshots.

BEGIN;

CREATE TABLE IF NOT EXISTS cnc_telegram_media_restore_requests (
  restore_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  packet_id UUID NOT NULL REFERENCES cnc_telegram_packets(packet_id) ON DELETE RESTRICT,
  requested_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  request_trace_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  available_until TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_cnc_telegram_media_restore_status
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT chk_cnc_telegram_media_restore_attempts
    CHECK (attempt_count BETWEEN 0 AND 5),
  CONSTRAINT chk_cnc_telegram_media_restore_error
    CHECK (last_error IS NULL OR char_length(last_error) BETWEEN 1 AND 500),
  CONSTRAINT chk_cnc_telegram_media_restore_state CHECK (
    (status = 'pending' AND claimed_at IS NULL AND finished_at IS NULL
      AND available_until IS NULL AND last_error IS NULL)
    OR
    (status = 'processing' AND claimed_at IS NOT NULL AND finished_at IS NULL
      AND available_until IS NULL AND last_error IS NULL AND attempt_count > 0)
    OR
    (status = 'completed' AND claimed_at IS NOT NULL AND finished_at IS NOT NULL
      AND available_until IS NOT NULL AND available_until > finished_at AND last_error IS NULL)
    OR
    (status = 'failed' AND claimed_at IS NOT NULL AND finished_at IS NOT NULL
      AND available_until IS NULL AND last_error IS NOT NULL AND attempt_count > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_telegram_media_restore_active_packet
  ON cnc_telegram_media_restore_requests(packet_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_media_restore_claim
  ON cnc_telegram_media_restore_requests(status, requested_at, restore_request_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_media_restore_packet_history
  ON cnc_telegram_media_restore_requests(packet_id, requested_at DESC, restore_request_id DESC);

COMMIT;
