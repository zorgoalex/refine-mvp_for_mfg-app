-- 049_label_qr_templates.sql
-- Global reusable QR templates for labels. Additive, old-writer-safe.
CREATE TABLE IF NOT EXISTS label_qr_templates (
  label_qr_template_id bigserial PRIMARY KEY,
  name                 text        NOT NULL,
  content_template     text        NOT NULL,
  error_correction     char(1)     NOT NULL DEFAULT 'M'
                       CHECK (error_correction IN ('L','M','Q','H')),
  default_size_mm      numeric(6,2) NOT NULL DEFAULT 20
                       CHECK (default_size_mm > 0),
  is_active            boolean     NOT NULL DEFAULT true,
  version              integer     NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           bigint      REFERENCES users(user_id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           bigint      REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS label_qr_templates_name_active_uniq
  ON label_qr_templates (lower(name))
  WHERE is_active;
