-- 093_cnc_telegram_svg_cut_import.sql
-- Persist parsed SVG cut layouts and link imported reverse-engineered cut jobs.

BEGIN;

ALTER TABLE cnc_telegram_packets
  ADD COLUMN IF NOT EXISTS cut_layout_json JSONB,
  ADD COLUMN IF NOT EXISTS svg_cut_job_id BIGINT,
  ADD COLUMN IF NOT EXISTS svg_cut_result_id BIGINT,
  ADD COLUMN IF NOT EXISTS svg_cut_import_status TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS svg_cut_import_note TEXT;

ALTER TABLE cnc_telegram_packets
  DROP CONSTRAINT IF EXISTS chk_cnc_telegram_packets_svg_cut_import_status;

ALTER TABLE cnc_telegram_packets
  ADD CONSTRAINT chk_cnc_telegram_packets_svg_cut_import_status
    CHECK (svg_cut_import_status IN ('none', 'skipped', 'needs_review', 'imported'));

ALTER TABLE cnc_telegram_packets
  DROP CONSTRAINT IF EXISTS fk_cnc_telegram_packets_svg_cut_job;

ALTER TABLE cnc_telegram_packets
  ADD CONSTRAINT fk_cnc_telegram_packets_svg_cut_job
    FOREIGN KEY (svg_cut_job_id) REFERENCES cut_job(cut_job_id) ON DELETE SET NULL;

ALTER TABLE cnc_telegram_packets
  DROP CONSTRAINT IF EXISTS fk_cnc_telegram_packets_svg_cut_result_same_job;

ALTER TABLE cnc_telegram_packets
  ADD CONSTRAINT fk_cnc_telegram_packets_svg_cut_result_same_job
    FOREIGN KEY (svg_cut_job_id, svg_cut_result_id)
    REFERENCES cut_result(cut_job_id, cut_result_id) ON DELETE SET NULL;

ALTER TABLE cnc_telegram_packets
  DROP CONSTRAINT IF EXISTS chk_cnc_telegram_packets_svg_cut_result_requires_job;

ALTER TABLE cnc_telegram_packets
  ADD CONSTRAINT chk_cnc_telegram_packets_svg_cut_result_requires_job
    CHECK (svg_cut_result_id IS NULL OR svg_cut_job_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packets_svg_cut_job
  ON cnc_telegram_packets(svg_cut_job_id)
  WHERE svg_cut_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cnc_telegram_packets_cut_layout_valid
  ON cnc_telegram_packets((cut_layout_json->>'status'))
  WHERE cut_layout_json IS NOT NULL;

COMMIT;
