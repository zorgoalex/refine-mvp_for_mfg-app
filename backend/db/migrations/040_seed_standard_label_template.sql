-- 040_seed_standard_label_template.sql
-- Seed one practical Bazis-compatible label template. Idempotent by live name.

BEGIN;

WITH inserted AS (
  INSERT INTO label_templates (
    name,
    description,
    canvas_width_mm,
    canvas_height_mm,
    dpi,
    default_export_formats,
    custom_field_schema
  )
  SELECT
    'Стандартная бирка Bazis 85x88',
    'Базовый шаблон по sample-выгрузкам Bazis: заказ, позиция, деталь, размер, материал, комментарий.',
    85,
    88,
    203,
    ARRAY['bmp', 'png', 'emf']::TEXT[],
    '{}'::JSONB
  WHERE NOT EXISTS (
    SELECT 1
    FROM label_templates
    WHERE lower(name) = lower('Стандартная бирка Bazis 85x88')
      AND deleted_at IS NULL
  )
  RETURNING label_template_id
),
target_template AS (
  SELECT label_template_id FROM inserted
  UNION ALL
  SELECT label_template_id
  FROM label_templates
  WHERE lower(name) = lower('Стандартная бирка Bazis 85x88')
    AND deleted_at IS NULL
  LIMIT 1
),
seed_elements(element_key, kind, source_field, static_text, x_mm, y_mm, width_mm, height_mm, rotation_deg, z_index, style_json, condition_json) AS (
  VALUES
    ('border', 'rect', NULL, NULL, 1, 1, 83, 86, 0, 0, '{"strokeWidth":1}'::JSONB, '{}'::JSONB),
    ('order-label', 'text', NULL, 'Заказ', 4, 4, 16, 5, 0, 1, '{"fontSize":10,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('order-value', 'text', 'bazis.order_number', NULL, 21, 4, 58, 5, 0, 2, '{"fontSize":10}'::JSONB, '{}'::JSONB),
    ('position-label', 'text', NULL, 'Поз.', 4, 12, 14, 5, 0, 3, '{"fontSize":10,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('position-value', 'text', 'bazis.position', NULL, 18, 12, 20, 5, 0, 4, '{"fontSize":12,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('qty-label', 'text', NULL, 'Кол-во', 48, 12, 18, 5, 0, 5, '{"fontSize":10,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('qty-value', 'text', 'bazis.quantity', NULL, 67, 12, 12, 5, 0, 6, '{"fontSize":12,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('name-label', 'text', NULL, 'Деталь', 4, 21, 18, 5, 0, 7, '{"fontSize":10,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('name-value', 'text', 'bazis.name', NULL, 4, 27, 76, 10, 0, 8, '{"fontSize":14,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('size-label', 'text', NULL, 'Размер', 4, 42, 20, 5, 0, 9, '{"fontSize":10,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('length-value', 'text', 'bazis.detail_length', NULL, 25, 42, 18, 5, 0, 10, '{"fontSize":12}'::JSONB, '{}'::JSONB),
    ('size-x', 'text', NULL, 'x', 44, 42, 4, 5, 0, 11, '{"fontSize":12}'::JSONB, '{}'::JSONB),
    ('width-value', 'text', 'bazis.detail_width', NULL, 49, 42, 18, 5, 0, 12, '{"fontSize":12}'::JSONB, '{}'::JSONB),
    ('material-label', 'text', NULL, 'Материал', 4, 51, 24, 5, 0, 13, '{"fontSize":10,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('material-value', 'text', 'bazis.material', NULL, 4, 57, 76, 8, 0, 14, '{"fontSize":12}'::JSONB, '{}'::JSONB),
    ('comment-label', 'text', NULL, 'Комментарий', 4, 70, 32, 5, 0, 15, '{"fontSize":10,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('comment-value', 'text', 'bazis.comment', NULL, 4, 76, 76, 8, 0, 16, '{"fontSize":10}'::JSONB, '{}'::JSONB)
)
INSERT INTO label_template_elements (
  label_template_id,
  element_key,
  kind,
  source_field,
  static_text,
  x_mm,
  y_mm,
  width_mm,
  height_mm,
  rotation_deg,
  z_index,
  style_json,
  condition_json
)
SELECT
  target_template.label_template_id,
  seed_elements.element_key,
  seed_elements.kind,
  seed_elements.source_field,
  seed_elements.static_text,
  seed_elements.x_mm,
  seed_elements.y_mm,
  seed_elements.width_mm,
  seed_elements.height_mm,
  seed_elements.rotation_deg,
  seed_elements.z_index,
  seed_elements.style_json,
  seed_elements.condition_json
FROM target_template
CROSS JOIN seed_elements
ON CONFLICT (label_template_id, element_key) DO NOTHING;

COMMIT;
