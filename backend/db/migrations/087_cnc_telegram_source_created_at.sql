-- 087_cnc_telegram_source_created_at.sql
-- Store original Telegram message creation time separately from edit/update time.

BEGIN;

ALTER TABLE cnc_telegram_packets
  ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMPTZ;

UPDATE cnc_telegram_packets
SET source_created_at = COALESCE(source_created_at, source_updated_at, created_at)
WHERE source_created_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packets_workday_source_created
  ON cnc_telegram_packets(workday DESC, source_created_at DESC);

COMMIT;
