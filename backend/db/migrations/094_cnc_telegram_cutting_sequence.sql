-- 094_cnc_telegram_cutting_sequence.sql
-- Stable machine-file cutting sequence numbers assigned from Telegram replies/backend ingest.

BEGIN;

ALTER TABLE cnc_telegram_packets
  ADD COLUMN IF NOT EXISTS cutting_sequence_no INTEGER;

ALTER TABLE cnc_telegram_packets
  DROP CONSTRAINT IF EXISTS chk_cnc_telegram_packets_cutting_sequence_positive;

ALTER TABLE cnc_telegram_packets
  ADD CONSTRAINT chk_cnc_telegram_packets_cutting_sequence_positive
  CHECK (cutting_sequence_no IS NULL OR cutting_sequence_no > 0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cnc_telegram_packets_cutting_sequence_no
  ON cnc_telegram_packets(cutting_sequence_no)
  WHERE cutting_sequence_no IS NOT NULL;

COMMIT;
