BEGIN;

ALTER TABLE cnc_manual_svg_telegram_send_requests
  ADD COLUMN IF NOT EXISTS destination_chat_id TEXT;

ALTER TABLE cnc_manual_svg_telegram_send_requests
  ADD CONSTRAINT chk_cnc_manual_svg_telegram_destination_chat
  CHECK (
    destination_chat_id IS NULL
    OR length(trim(destination_chat_id)) BETWEEN 1 AND 120
  );

CREATE INDEX IF NOT EXISTS idx_cnc_manual_svg_telegram_send_destination_claim
  ON cnc_manual_svg_telegram_send_requests(destination_chat_id, requested_at, request_id)
  WHERE status='pending';

-- Legacy active rows have no explicit destination. Do not replay them when
-- routing v2 becomes active: Telegram delivery is externally visible and the
-- operator deliberately chose to send only requests created after cut-over.
UPDATE cnc_manual_svg_telegram_send_requests
SET status='unknown',
    claimed_at=COALESCE(claimed_at, now()),
    attempt_count=GREATEST(attempt_count, 1),
    finished_at=COALESCE(finished_at, now()),
    sent_chat_id=NULL,
    sent_message_ids_json='[]'::jsonb,
    last_error='ROUTING_V2_LEGACY_REQUEST_NOT_REPLAYED',
    updated_at=now()
WHERE status IN ('pending', 'processing')
  AND destination_chat_id IS NULL;

ALTER TABLE cnc_telegram_worker_session_leases
  ADD COLUMN IF NOT EXISTS stack_env TEXT,
  ADD COLUMN IF NOT EXISTS worker_role TEXT,
  ADD COLUMN IF NOT EXISTS can_send_manual_svg_uploads BOOLEAN,
  ADD COLUMN IF NOT EXISTS manual_svg_send_poll_interval_seconds DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS parser_version TEXT;

ALTER TABLE cnc_telegram_worker_session_leases
  ADD CONSTRAINT chk_cnc_tg_session_runtime_evidence CHECK (
    (stack_env IS NULL OR length(trim(stack_env)) BETWEEN 1 AND 32)
    AND (worker_role IS NULL OR worker_role IN ('disabled', 'reader', 'writer'))
    AND (
      manual_svg_send_poll_interval_seconds IS NULL
      OR manual_svg_send_poll_interval_seconds BETWEEN 0.1 AND 3600
    )
    AND (parser_version IS NULL OR length(trim(parser_version)) BETWEEN 1 AND 160)
  );

COMMIT;
