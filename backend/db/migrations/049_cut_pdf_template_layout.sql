-- Migration 049: Persist editable cut PDF template layouts.
BEGIN;

ALTER TABLE cut_pdf_templates
  ADD COLUMN IF NOT EXISTS layout JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
