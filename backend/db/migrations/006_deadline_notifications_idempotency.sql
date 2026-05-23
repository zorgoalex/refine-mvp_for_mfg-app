-- Deadline Engine notification delivery idempotency.
--
-- Adds an idempotency key to backend notifications so repeated worker/action
-- dispatch cannot create duplicate user-visible Deadline Engine notifications.

BEGIN;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_idempotency_key
  ON notifications(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_source
  ON notifications(source_type, source_id, created_at DESC);

COMMIT;
