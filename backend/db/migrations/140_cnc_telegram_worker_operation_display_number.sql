-- Preserve the operator-facing cut job number on worker reply operations.

BEGIN;

ALTER TABLE cnc_telegram_worker_operations
  ADD COLUMN IF NOT EXISTS cut_job_display_number TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_cnc_tg_worker_operation_display_number'
      AND conrelid = 'cnc_telegram_worker_operations'::regclass
  ) THEN
    ALTER TABLE cnc_telegram_worker_operations
      ADD CONSTRAINT chk_cnc_tg_worker_operation_display_number
      CHECK (length(COALESCE(cut_job_display_number, '')) <= 80);
  END IF;
END $$;

COMMIT;
