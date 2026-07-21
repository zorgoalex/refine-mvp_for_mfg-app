-- Expose human-readable detail reference names for label templates.
-- New view columns are appended to preserve CREATE OR REPLACE VIEW compatibility.
BEGIN;

CREATE OR REPLACE VIEW order_details_view AS
SELECT
    od.detail_id,
    od.order_id,
    od.detail_number,
    od.detail_name,
    od.height,
    od.width,
    od.quantity,
    od.area,
    od.material_id,
    od.sheet_material_type_id,
    smt.name AS material_name,
    od.milling_type_id,
    od.edge_type_id,
    od.film_id,
    od.milling_cost_per_sqm,
    od.detail_cost,
    od.priority,
    od.production_status_id,
    od.joint_order_id,
    od.note,
    od.link_cutting_file,
    od.link_cutting_image_file,
    od.link_cad_file,
    od.link_pdf_file,
    od.ref_key_1c,
    od.basis_project,
    od.basis_data,
    od.basis_designation,
    od.basis_product,
    od.doweling,
    mt.milling_type_name,
    f.film_name
FROM order_details od
JOIN orders ord
  ON ord.order_id = od.order_id AND ord.delete_flag = false
LEFT JOIN sheet_material_types smt
  ON smt.sheet_material_type_id = od.sheet_material_type_id
LEFT JOIN milling_types mt ON mt.milling_type_id = od.milling_type_id
LEFT JOIN films f ON f.film_id = od.film_id
WHERE od.delete_flag = false;

COMMENT ON VIEW order_details_view IS
  'Order details with sheet material, milling type, and film display names';

-- These bindings were previously presented to users as semantic fields even
-- though they stored raw ids. Preserve that intended meaning everywhere a
-- saved template can reference a field. The affected-id tables make the data
-- rewrite idempotent: a second run finds no legacy bindings and bumps no
-- versions.
CREATE TEMP TABLE label_reference_name_affected_templates
ON COMMIT DROP AS
SELECT affected.*
FROM (
  SELECT
    lt.label_template_id,
    (
      lt.field_catalog_snapshot ? 'detail.milling_type_id'
      OR EXISTS (
        SELECT 1
        FROM label_template_elements lte
        WHERE lte.label_template_id = lt.label_template_id
          AND (
            btrim(COALESCE(lte.source_field, '')) = 'detail.milling_type_id'
            OR COALESCE(lte.style_json->>'qrTemplate', '')
              ~ '\{[[:space:]]*detail\.milling_type_id[[:space:]]*\}'
            OR btrim(COALESCE(lte.condition_json->>'field', '')) = 'detail.milling_type_id'
          )
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_each(lt.custom_field_schema) entry
        WHERE btrim(COALESCE(entry.value->>'sourceField', '')) = 'detail.milling_type_id'
      )
    ) AS uses_milling_name,
    (
      lt.field_catalog_snapshot ? 'detail.film_id'
      OR EXISTS (
        SELECT 1
        FROM label_template_elements lte
        WHERE lte.label_template_id = lt.label_template_id
          AND (
            btrim(COALESCE(lte.source_field, '')) = 'detail.film_id'
            OR COALESCE(lte.style_json->>'qrTemplate', '')
              ~ '\{[[:space:]]*detail\.film_id[[:space:]]*\}'
            OR btrim(COALESCE(lte.condition_json->>'field', '')) = 'detail.film_id'
          )
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_each(lt.custom_field_schema) entry
        WHERE btrim(COALESCE(entry.value->>'sourceField', '')) = 'detail.film_id'
      )
    ) AS uses_film_name
  FROM label_templates lt
) affected
WHERE affected.uses_milling_name OR affected.uses_film_name;

CREATE TEMP TABLE label_reference_name_affected_qr_templates
ON COMMIT DROP AS
SELECT
  lqt.label_qr_template_id,
  (
    lqt.field_catalog_snapshot ? 'detail.milling_type_id'
    OR lqt.content_template ~ '\{[[:space:]]*detail\.milling_type_id[[:space:]]*\}'
  ) AS uses_milling_name,
  (
    lqt.field_catalog_snapshot ? 'detail.film_id'
    OR lqt.content_template ~ '\{[[:space:]]*detail\.film_id[[:space:]]*\}'
  ) AS uses_film_name
FROM label_qr_templates lqt
WHERE lqt.field_catalog_snapshot ?| ARRAY['detail.milling_type_id', 'detail.film_id']
   OR lqt.content_template
      ~ '\{[[:space:]]*detail\.(milling_type_id|film_id)[[:space:]]*\}';

UPDATE label_template_elements lte
SET source_field = CASE btrim(COALESCE(lte.source_field, ''))
      WHEN 'detail.milling_type_id' THEN 'detail.milling_type_name'
      WHEN 'detail.film_id' THEN 'detail.film_name'
      ELSE lte.source_field
    END,
    style_json = CASE
      WHEN COALESCE(lte.style_json->>'qrTemplate', '')
        ~ '\{[[:space:]]*detail\.(milling_type_id|film_id)[[:space:]]*\}'
      THEN jsonb_set(
        lte.style_json,
        '{qrTemplate}',
        to_jsonb(
          regexp_replace(
            regexp_replace(
              lte.style_json->>'qrTemplate',
              '\{[[:space:]]*detail\.milling_type_id[[:space:]]*\}',
              '{detail.milling_type_name}',
              'g'
            ),
            '\{[[:space:]]*detail\.film_id[[:space:]]*\}',
            '{detail.film_name}',
            'g'
          )
        )
      )
      ELSE lte.style_json
    END,
    condition_json = CASE btrim(COALESCE(lte.condition_json->>'field', ''))
      WHEN 'detail.milling_type_id'
        THEN jsonb_set(lte.condition_json, '{field}', to_jsonb('detail.milling_type_name'::text))
      WHEN 'detail.film_id'
        THEN jsonb_set(lte.condition_json, '{field}', to_jsonb('detail.film_name'::text))
      ELSE lte.condition_json
    END,
    updated_at = now()
WHERE lte.label_template_id IN (
  SELECT affected.label_template_id
  FROM label_reference_name_affected_templates affected
)
  AND (
    btrim(COALESCE(lte.source_field, ''))
      IN ('detail.milling_type_id', 'detail.film_id')
    OR COALESCE(lte.style_json->>'qrTemplate', '')
      ~ '\{[[:space:]]*detail\.(milling_type_id|film_id)[[:space:]]*\}'
    OR btrim(COALESCE(lte.condition_json->>'field', ''))
      IN ('detail.milling_type_id', 'detail.film_id')
  );

WITH rewritten AS (
  SELECT
    lt.label_template_id,
    jsonb_object_agg(
      entry.key,
      CASE btrim(COALESCE(entry.value->>'sourceField', ''))
        WHEN 'detail.milling_type_id'
          THEN jsonb_set(entry.value, '{sourceField}', to_jsonb('detail.milling_type_name'::text))
        WHEN 'detail.film_id'
          THEN jsonb_set(entry.value, '{sourceField}', to_jsonb('detail.film_name'::text))
        ELSE entry.value
      END
    ) AS custom_field_schema
  FROM label_templates lt
  CROSS JOIN LATERAL jsonb_each(lt.custom_field_schema) entry
  WHERE lt.label_template_id IN (
    SELECT affected.label_template_id
    FROM label_reference_name_affected_templates affected
  )
  GROUP BY lt.label_template_id
)
UPDATE label_templates lt
SET custom_field_schema = rewritten.custom_field_schema
FROM rewritten
WHERE rewritten.label_template_id = lt.label_template_id;

WITH rewritten AS (
  SELECT
    data.order_label_detail_data_id,
    jsonb_object_agg(
      entry.key,
      CASE btrim(COALESCE(entry.value->>'sourceField', ''))
        WHEN 'detail.milling_type_id'
          THEN jsonb_set(entry.value, '{sourceField}', to_jsonb('detail.milling_type_name'::text))
        WHEN 'detail.film_id'
          THEN jsonb_set(entry.value, '{sourceField}', to_jsonb('detail.film_name'::text))
        ELSE entry.value
      END
    ) AS custom_field_schema_snapshot
  FROM order_label_detail_data data
  CROSS JOIN LATERAL jsonb_each(data.custom_field_schema_snapshot) entry
  GROUP BY data.order_label_detail_data_id
  HAVING bool_or(
    btrim(COALESCE(entry.value->>'sourceField', ''))
      IN ('detail.milling_type_id', 'detail.film_id')
  )
)
UPDATE order_label_detail_data data
SET custom_field_schema_snapshot = rewritten.custom_field_schema_snapshot,
    version = data.version + 1,
    updated_at = now()
FROM rewritten
WHERE rewritten.order_label_detail_data_id = data.order_label_detail_data_id;

UPDATE label_templates lt
SET version = lt.version + 1,
    updated_at = now(),
    field_catalog_snapshot =
      (lt.field_catalog_snapshot - 'detail.milling_type_id' - 'detail.film_id')
      || CASE WHEN affected.uses_milling_name THEN jsonb_build_object(
        'detail.milling_type_name',
        jsonb_build_object(
          'type', 'string',
          'label', 'Фрезеровка',
          'sourceColumn', 'milling_type_name'
        )
      ) ELSE '{}'::jsonb END
      || CASE WHEN affected.uses_film_name THEN jsonb_build_object(
        'detail.film_name',
        jsonb_build_object(
          'type', 'string',
          'label', 'Пленка',
          'sourceColumn', 'film_name'
        )
      ) ELSE '{}'::jsonb END
FROM label_reference_name_affected_templates affected
WHERE affected.label_template_id = lt.label_template_id;

UPDATE label_qr_templates lqt
SET content_template =
      regexp_replace(
        regexp_replace(
          lqt.content_template,
          '\{[[:space:]]*detail\.milling_type_id[[:space:]]*\}',
          '{detail.milling_type_name}',
          'g'
        ),
        '\{[[:space:]]*detail\.film_id[[:space:]]*\}',
        '{detail.film_name}',
        'g'
      ),
    field_catalog_snapshot =
      (lqt.field_catalog_snapshot - 'detail.milling_type_id' - 'detail.film_id')
      || CASE WHEN affected.uses_milling_name THEN jsonb_build_object(
        'detail.milling_type_name',
        jsonb_build_object(
          'type', 'string',
          'label', 'Фрезеровка',
          'sourceColumn', 'milling_type_name'
        )
      ) ELSE '{}'::jsonb END
      || CASE WHEN affected.uses_film_name THEN jsonb_build_object(
        'detail.film_name',
        jsonb_build_object(
          'type', 'string',
          'label', 'Пленка',
          'sourceColumn', 'film_name'
        )
      ) ELSE '{}'::jsonb END,
    version = lqt.version + 1,
    updated_at = now()
FROM label_reference_name_affected_qr_templates affected
WHERE affected.label_qr_template_id = lqt.label_qr_template_id;

COMMIT;
