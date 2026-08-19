-- Phase A global fencing lease for the single Telegram worker lane.
BEGIN;

CREATE TABLE IF NOT EXISTS cnc_telegram_worker_session_leases (
  source_chat_id TEXT PRIMARY KEY,
  lease_token TEXT NOT NULL,
  lease_generation BIGINT NOT NULL DEFAULT 1,
  worker_instance_id UUID NOT NULL,
  worker_image_revision TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_cnc_tg_session_lease_chat
    CHECK (length(trim(source_chat_id)) BETWEEN 1 AND 120),
  CONSTRAINT chk_cnc_tg_session_lease_token
    CHECK (length(lease_token) BETWEEN 32 AND 240),
  CONSTRAINT chk_cnc_tg_session_lease_generation
    CHECK (lease_generation > 0),
  CONSTRAINT chk_cnc_tg_session_lease_revision
    CHECK (worker_image_revision ~ '^[0-9a-f]{7,64}$'),
  CONSTRAINT chk_cnc_tg_session_lease_expiry
    CHECK (expires_at > claimed_at)
);

CREATE INDEX IF NOT EXISTS idx_cnc_tg_session_leases_expiry
  ON cnc_telegram_worker_session_leases(expires_at);

-- Worker-owned item leases fence queue claims independently of the global
-- Telegram client lease. Existing rows remain claimable with generation 0.
ALTER TABLE cnc_telegram_media_restore_requests
  ADD COLUMN IF NOT EXISTS lease_token TEXT,
  ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_worker_instance_id UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

ALTER TABLE cnc_manual_svg_telegram_send_requests
  ADD COLUMN IF NOT EXISTS lease_token TEXT,
  ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_worker_instance_id UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- Cut over rows claimed by a pre-Phase-A worker before enforcing the new
-- shape. Restore is safe to retry; Telegram send is not, so preserve it as
-- unknown for operator reconciliation instead of risking a duplicate send.
UPDATE cnc_telegram_media_restore_requests
SET status='pending', claimed_at=NULL, finished_at=NULL,
    last_error='Перезапущено при включении fenced worker lease', updated_at=now()
WHERE status='processing' AND lease_token IS NULL;

UPDATE cnc_manual_svg_telegram_send_requests
SET status='unknown', finished_at=COALESCE(finished_at, now()),
    last_error='Статус отправки неизвестен: migration fenced worker lease', updated_at=now()
WHERE status='processing' AND lease_token IS NULL;

ALTER TABLE cnc_telegram_media_restore_requests
  ADD CONSTRAINT chk_cnc_tg_restore_item_lease_generation CHECK (lease_generation >= 0),
  ADD CONSTRAINT chk_cnc_tg_restore_item_lease_shape CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_worker_instance_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'processing'
  );

ALTER TABLE cnc_manual_svg_telegram_send_requests
  ADD CONSTRAINT chk_cnc_tg_send_item_lease_generation CHECK (lease_generation >= 0),
  ADD CONSTRAINT chk_cnc_tg_send_item_lease_shape CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_worker_instance_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'processing'
  );

CREATE INDEX IF NOT EXISTS idx_cnc_tg_restore_item_lease_expiry
  ON cnc_telegram_media_restore_requests(lease_expires_at)
  WHERE status='processing';

CREATE INDEX IF NOT EXISTS idx_cnc_tg_send_item_lease_expiry
  ON cnc_manual_svg_telegram_send_requests(lease_expires_at)
  WHERE status='processing';

COMMIT;
