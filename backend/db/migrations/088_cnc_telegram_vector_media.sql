-- 088_cnc_telegram_vector_media.sql
-- SVG-vector detail source and expiring Telegram sheet image previews.

BEGIN;

ALTER TABLE cnc_telegram_packets
  ADD COLUMN IF NOT EXISTS sheet_image_storage_key TEXT,
  ADD COLUMN IF NOT EXISTS sheet_image_content_type TEXT,
  ADD COLUMN IF NOT EXISTS sheet_image_size_bytes BIGINT;

ALTER TABLE cnc_telegram_packets
  DROP CONSTRAINT IF EXISTS chk_cnc_telegram_packets_sheet_image_size_positive;

ALTER TABLE cnc_telegram_packets
  ADD CONSTRAINT chk_cnc_telegram_packets_sheet_image_size_positive
    CHECK (sheet_image_size_bytes IS NULL OR sheet_image_size_bytes > 0);

ALTER TABLE cnc_telegram_packet_items
  DROP CONSTRAINT IF EXISTS chk_cnc_telegram_packet_items_source;

ALTER TABLE cnc_telegram_packet_items
  ADD CONSTRAINT chk_cnc_telegram_packet_items_source
    CHECK (source IN ('vector', 'ocr', 'gcode', 'manual'));

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packets_sheet_image_storage_key
  ON cnc_telegram_packets(sheet_image_storage_key)
  WHERE sheet_image_storage_key IS NOT NULL;

COMMIT;
