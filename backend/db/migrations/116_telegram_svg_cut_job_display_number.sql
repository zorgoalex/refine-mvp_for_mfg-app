-- Backfill operator-facing cut job numbers for Telegram SVG reverse imports.

BEGIN;

ALTER TABLE cut_job
  ADD COLUMN IF NOT EXISTS source_display_number TEXT;

WITH telegram_svg_jobs AS (
  SELECT DISTINCT
         packet.svg_cut_job_id AS cut_job_id,
         packet.cutting_sequence_no::text AS source_display_number
  FROM cnc_telegram_packets packet
  JOIN cut_job job
    ON job.cut_job_id = packet.svg_cut_job_id
  WHERE packet.svg_cut_job_id IS NOT NULL
    AND packet.svg_cut_result_id IS NOT NULL
    AND packet.svg_cut_import_status = 'imported'
    AND packet.cutting_sequence_no IS NOT NULL
    AND packet.cut_layout_json->>'status' = 'valid'
    AND job.source = 'api'
    AND job.selection_criteria->>'source' = 'cnc_telegram_svg'
)
UPDATE cut_job job
SET source_display_number = telegram_svg_jobs.source_display_number,
    updated_at = now()
FROM telegram_svg_jobs
WHERE job.cut_job_id = telegram_svg_jobs.cut_job_id
  AND job.source_display_number IS DISTINCT FROM telegram_svg_jobs.source_display_number;

COMMENT ON COLUMN cut_job.source_display_number IS
  'Operator-facing cut job number from the source system; Telegram SVG imports use cnc_telegram_packets.cutting_sequence_no.';

COMMIT;
