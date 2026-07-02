-- 047_label_template_qr_kind.sql
-- Allow first-class QR-code elements in label templates.

ALTER TABLE label_template_elements
  DROP CONSTRAINT IF EXISTS chk_label_template_elements_kind;

ALTER TABLE label_template_elements
  ADD CONSTRAINT chk_label_template_elements_kind
  CHECK (kind IN ('text', 'line', 'rect', 'qr'));

-- Rollback:
-- DELETE FROM label_template_elements WHERE kind = 'qr';
-- ALTER TABLE label_template_elements DROP CONSTRAINT IF EXISTS chk_label_template_elements_kind;
-- ALTER TABLE label_template_elements
--   ADD CONSTRAINT chk_label_template_elements_kind
--   CHECK (kind IN ('text', 'line', 'rect'));
