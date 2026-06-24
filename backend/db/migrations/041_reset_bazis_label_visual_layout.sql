-- 041_reset_bazis_label_visual_layout.sql
-- Replace the initial cramped MVP label layout with a Bazis-sample-like 85x88mm layout.

BEGIN;

CREATE TEMP TABLE tmp_bazis_label_visual_targets ON COMMIT DROP AS
  SELECT label_template_id
  FROM label_templates
  WHERE deleted_at IS NULL
    AND (
      name = 'Стандартная бирка Bazis 85x88'
      OR name LIKE 'Импорт Bazis %'
    );

DELETE FROM label_template_elements elements
USING tmp_bazis_label_visual_targets target
WHERE elements.label_template_id = target.label_template_id;

UPDATE label_templates lt
SET
  canvas_width_mm = 85,
  canvas_height_mm = 88,
  dpi = 203,
  version = version + 1,
  updated_at = now()
FROM tmp_bazis_label_visual_targets target
WHERE lt.label_template_id = target.label_template_id;

WITH
seed_elements(element_key, kind, source_field, static_text, x_mm, y_mm, width_mm, height_mm, rotation_deg, z_index, style_json, condition_json) AS (
  VALUES
    ('border', 'rect', NULL, NULL, 1, 1, 83, 86, 0, 0, '{"strokeWidth":1}'::JSONB, '{}'::JSONB),
    ('detail-id-label', 'text', NULL, '№:', 2, 4, 14, 8, 0, 1, '{"fontSize":13,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('detail-id-value', 'text', 'bazis.detail_id', NULL, 36, 6, 30, 10, 0, 2, '{"fontSize":18,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('order-label', 'text', NULL, 'Заказ№:', 2, 18, 22, 7, 0, 3, '{"fontSize":11}'::JSONB, '{}'::JSONB),
    ('order-value', 'text', 'bazis.order_number', NULL, 24, 18, 56, 7, 0, 4, '{"fontSize":11,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('position-label', 'text', NULL, 'Поз.', 2, 28, 13, 7, 0, 5, '{"fontSize":11}'::JSONB, '{}'::JSONB),
    ('position-value', 'text', 'bazis.position', NULL, 15, 28, 20, 7, 0, 6, '{"fontSize":11}'::JSONB, '{}'::JSONB),
    ('material-value', 'text', 'bazis.material', NULL, 31, 38, 34, 6, 0, 7, '{"fontSize":9}'::JSONB, '{}'::JSONB),
    ('length-value', 'text', 'bazis.detail_length', NULL, 27, 47, 18, 8, 0, 8, '{"fontSize":16,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('size-x', 'text', NULL, 'x', 45, 47, 7, 8, 0, 9, '{"fontSize":16,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('width-value', 'text', 'bazis.detail_width', NULL, 52, 47, 18, 8, 0, 10, '{"fontSize":16,"fontWeight":"bold"}'::JSONB, '{}'::JSONB),
    ('date-value', 'text', 'date.today', NULL, 2, 80, 29, 7, 0, 11, '{"fontSize":10}'::JSONB, '{}'::JSONB),
    ('counter-value', 'text', 'label.counter_text', NULL, 41, 80, 38, 7, 0, 12, '{"fontSize":10}'::JSONB, '{}'::JSONB)
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
  target.label_template_id,
  seed.element_key,
  seed.kind,
  seed.source_field,
  seed.static_text,
  seed.x_mm,
  seed.y_mm,
  seed.width_mm,
  seed.height_mm,
  seed.rotation_deg,
  seed.z_index,
  seed.style_json,
  seed.condition_json
FROM tmp_bazis_label_visual_targets target
CROSS JOIN seed_elements seed;

COMMIT;
