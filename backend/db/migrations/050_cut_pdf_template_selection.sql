-- 050_cut_pdf_template_selection.sql
-- Persist the last selected PDF template for whole-job and per-group exports.

BEGIN;

ALTER TABLE cut_job
  ADD COLUMN IF NOT EXISTS pdf_template_code VARCHAR(100) NOT NULL DEFAULT 'standard';

ALTER TABLE cut_group
  ADD COLUMN IF NOT EXISTS pdf_template_code VARCHAR(100) NOT NULL DEFAULT 'standard';

COMMIT;
