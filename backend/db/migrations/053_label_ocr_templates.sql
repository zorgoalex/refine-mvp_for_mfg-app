-- 053_label_ocr_templates.sql
-- Configurable OCR label templates (ordered line rules). Additive, fallback-safe.
CREATE TABLE IF NOT EXISTS label_ocr_templates (
  label_ocr_template_id bigserial PRIMARY KEY,
  name          text        NOT NULL,
  rules         jsonb       NOT NULL,
  sample_lines  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  is_active     boolean     NOT NULL DEFAULT true,
  version       integer     NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint      REFERENCES users(user_id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint      REFERENCES users(user_id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS label_ocr_templates_name_active_uniq
  ON label_ocr_templates (lower(name)) WHERE is_active;
