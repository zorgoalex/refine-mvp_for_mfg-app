BEGIN;
ALTER TABLE cnc_telegram_packets ADD COLUMN IF NOT EXISTS mdf_completion_returned boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN cnc_telegram_packets.mdf_completion_returned IS
  'Local completion correction barrier: repeated completed source payloads remain pending until false then true or explicit manual forward movement.';
COMMIT;
