-- 124_cnc_manual_svg_telegram_files.sql
-- DB-retained manual SVG upload files, order links, and Telegram send queue.

BEGIN;

CREATE TABLE IF NOT EXISTS cnc_manual_svg_upload_files (
  file_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  packet_id UUID NOT NULL REFERENCES cnc_telegram_packets(packet_id) ON DELETE RESTRICT,
  file_kind TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  content_bytes BYTEA NOT NULL,
  generated BOOLEAN NOT NULL DEFAULT false,
  created_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  CONSTRAINT chk_cnc_manual_svg_upload_files_kind
    CHECK (file_kind IN ('svg', 'gcode', 'screenshot')),
  CONSTRAINT chk_cnc_manual_svg_upload_files_name
    CHECK (length(trim(original_file_name)) > 0 AND length(original_file_name) <= 240),
  CONSTRAINT chk_cnc_manual_svg_upload_files_content_type
    CHECK (length(trim(content_type)) > 0 AND length(content_type) <= 120),
  CONSTRAINT chk_cnc_manual_svg_upload_files_sha
    CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_cnc_manual_svg_upload_files_size
    CHECK (size_bytes > 0 AND size_bytes <= 15728640 AND octet_length(content_bytes) = size_bytes),
  CONSTRAINT chk_cnc_manual_svg_upload_files_ttl
    CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_manual_svg_upload_files_packet_kind
  ON cnc_manual_svg_upload_files(packet_id, file_kind);

CREATE INDEX IF NOT EXISTS idx_cnc_manual_svg_upload_files_packet
  ON cnc_manual_svg_upload_files(packet_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cnc_manual_svg_upload_files_expires
  ON cnc_manual_svg_upload_files(expires_at);

CREATE TABLE IF NOT EXISTS cnc_manual_svg_upload_file_orders (
  file_id UUID NOT NULL REFERENCES cnc_manual_svg_upload_files(file_id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_cnc_manual_svg_upload_file_orders_order
  ON cnc_manual_svg_upload_file_orders(order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cnc_manual_svg_telegram_send_requests (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  packet_id UUID NOT NULL REFERENCES cnc_telegram_packets(packet_id) ON DELETE RESTRICT,
  send_idempotency_key TEXT NOT NULL,
  requested_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  message_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  sent_chat_id TEXT,
  sent_message_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_cnc_manual_svg_telegram_send_status
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'unknown')),
  CONSTRAINT chk_cnc_manual_svg_telegram_send_idempotency_key
    CHECK (length(trim(send_idempotency_key)) BETWEEN 8 AND 240),
  CONSTRAINT chk_cnc_manual_svg_telegram_send_attempts
    CHECK (attempt_count BETWEEN 0 AND 5),
  CONSTRAINT chk_cnc_manual_svg_telegram_send_message
    CHECK (char_length(message_text) <= 4096),
  CONSTRAINT chk_cnc_manual_svg_telegram_send_error
    CHECK (last_error IS NULL OR char_length(last_error) BETWEEN 1 AND 1000),
  CONSTRAINT chk_cnc_manual_svg_telegram_send_state CHECK (
    (status = 'pending' AND claimed_at IS NULL AND finished_at IS NULL
      AND sent_chat_id IS NULL AND last_error IS NULL)
    OR
    (status = 'processing' AND claimed_at IS NOT NULL AND finished_at IS NULL
      AND sent_chat_id IS NULL AND last_error IS NULL AND attempt_count > 0)
    OR
    (status = 'sent' AND claimed_at IS NOT NULL AND finished_at IS NOT NULL
      AND sent_chat_id IS NOT NULL AND jsonb_typeof(sent_message_ids_json) = 'array'
      AND last_error IS NULL AND attempt_count > 0)
    OR
    (status = 'failed' AND claimed_at IS NOT NULL AND finished_at IS NOT NULL
      AND sent_chat_id IS NULL AND last_error IS NOT NULL AND attempt_count > 0)
    OR
    (status = 'unknown' AND claimed_at IS NOT NULL AND finished_at IS NOT NULL
      AND sent_chat_id IS NULL AND last_error IS NOT NULL AND attempt_count > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_manual_svg_telegram_send_idempotency_key
  ON cnc_manual_svg_telegram_send_requests(send_idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_manual_svg_telegram_send_active_packet
  ON cnc_manual_svg_telegram_send_requests(packet_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_cnc_manual_svg_telegram_send_claim
  ON cnc_manual_svg_telegram_send_requests(status, requested_at, request_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_cnc_manual_svg_telegram_send_packet_history
  ON cnc_manual_svg_telegram_send_requests(packet_id, requested_at DESC, request_id DESC);

CREATE TABLE IF NOT EXISTS cnc_manual_svg_telegram_send_request_files (
  request_id UUID NOT NULL REFERENCES cnc_manual_svg_telegram_send_requests(request_id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES cnc_manual_svg_upload_files(file_id) ON DELETE RESTRICT,
  send_order INTEGER NOT NULL,
  PRIMARY KEY (request_id, file_id),
  UNIQUE (request_id, send_order),
  CONSTRAINT chk_cnc_manual_svg_telegram_send_file_order
    CHECK (send_order BETWEEN 1 AND 10)
);

COMMIT;
