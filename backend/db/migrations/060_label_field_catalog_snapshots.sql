-- Preserve the schema metadata used by each label/QR template so editors can
-- distinguish a changed field from a field that disappeared entirely.
BEGIN;

ALTER TABLE label_templates
  ADD COLUMN IF NOT EXISTS field_catalog_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB;

ALTER TABLE label_qr_templates
  ADD COLUMN IF NOT EXISTS field_catalog_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB;

ALTER TABLE label_templates
  DROP CONSTRAINT IF EXISTS chk_label_templates_field_catalog_snapshot_object;
ALTER TABLE label_templates
  ADD CONSTRAINT chk_label_templates_field_catalog_snapshot_object
  CHECK (jsonb_typeof(field_catalog_snapshot) = 'object');

ALTER TABLE label_qr_templates
  DROP CONSTRAINT IF EXISTS chk_label_qr_templates_field_catalog_snapshot_object;
ALTER TABLE label_qr_templates
  ADD CONSTRAINT chk_label_qr_templates_field_catalog_snapshot_object
  CHECK (jsonb_typeof(field_catalog_snapshot) = 'object');

COMMIT;
