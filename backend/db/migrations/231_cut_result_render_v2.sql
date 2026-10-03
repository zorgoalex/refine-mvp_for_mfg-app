-- Cut results: contract v2 of the stored sheet render (only for results saved from now on).
-- v1 kept twelve finished views (two SVGs each) per sheet. v2 keeps the piece coordinates (already
-- in placements), the render model the live renderer used (label lines, contour colour, bath
-- details, resolved style, bath meter guide flag) and the one label-free unrotated SVG that
-- project_cut_result_label_maps copies into cut_result_sheet_map.base_svg. Every view is drawn on
-- read. Existing rows are untouched and stay valid (v1 is still accepted).
--
-- cut_sheet_render_is_complete holds the per-sheet rule for both contracts; the snapshot check and
-- the expected manifest are the live definitions with only the render part replaced. Apply this
-- migration BEFORE a backend that writes v2: the previous check rejects v2 sheets.
BEGIN;

-- A stored, resolved render style (CutRenderStyleRule), mirroring the settings parser field by field
-- (parseCutRenderStyleProfile): exactly these sections and fields, each with its type, range,
-- integer and enum rules; a missing or null value never passes (every test is `IS NOT TRUE`).
-- Semantic rules of the parser beyond a single field (label contrast) are enforced by the backend,
-- which checks every stored style with that parser before the insert.
CREATE OR REPLACE FUNCTION public.cut_render_style_is_complete(p_style jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE STRICT
AS $function$
DECLARE
  -- The settings parser accepts #rgb and #rrggbb, trimmed.
  hex CONSTANT TEXT := '^\s*#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})\s*$';
  spec RECORD;
  section_name TEXT;
  value JSONB;
  number_value NUMERIC;
  ok BOOLEAN;
BEGIN
  IF (jsonb_typeof(p_style) = 'object') IS NOT TRUE
    OR (SELECT count(*) FROM jsonb_object_keys(p_style)) <> 5
    OR (p_style ?& ARRAY['id', 'piece', 'label', 'sourceSvg', 'rawSvgScreenshot']) IS NOT TRUE
    OR (jsonb_typeof(p_style -> 'id') = 'string') IS NOT TRUE
    OR ((p_style ->> 'id') IN ('default', 'mdf_board_preview', 'vacuum_task_preview', 'telegram_photo')) IS NOT TRUE
  THEN
    RETURN FALSE;
  END IF;

  -- Each section holds exactly its fields.
  FOR section_name IN SELECT unnest(ARRAY['piece', 'label', 'sourceSvg', 'rawSvgScreenshot']) LOOP
    IF (jsonb_typeof(p_style -> section_name) = 'object') IS NOT TRUE
      OR (
        SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(p_style -> section_name) AS key
      ) IS DISTINCT FROM (
        SELECT array_agg(field ORDER BY field COLLATE "C")
        FROM (VALUES
          ('piece', 'defaultFill'), ('piece', 'stroke'), ('piece', 'strokeWidthMm'), ('piece', 'orderPalette'),
          ('label', 'fillStrategy'), ('label', 'darkFill'), ('label', 'darkTextStroke'),
          ('label', 'darkTextStrokeWidthRatio'), ('label', 'lightFill'), ('label', 'lightTextStroke'),
          ('label', 'lightTextStrokeWidthRatio'), ('label', 'fontWeight'), ('label', 'orderFontRatio'),
          ('label', 'positionFontRatio'), ('label', 'sizeFontRatio'), ('label', 'orderPositionGapRatio'),
          ('label', 'positionSizeGapRatio'), ('label', 'letterSpacingRatio'),
          ('sourceSvg', 'minStrokePx'), ('sourceSvg', 'nonScalingStroke'), ('sourceSvg', 'strokeColorMode'),
          ('sourceSvg', 'fixedStroke'), ('sourceSvg', 'strokeOpacity'), ('sourceSvg', 'pastelSaturationPercent'),
          ('sourceSvg', 'pastelLightnessPercent'),
          ('rawSvgScreenshot', 'minStrokePx')
        ) AS fields(section, field)
        WHERE fields.section = section_name
      )
    THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  FOR spec IN
    SELECT * FROM (VALUES
      ('piece', 'defaultFill', 'hex', NULL::numeric, NULL::numeric),
      ('piece', 'stroke', 'hex', NULL, NULL),
      ('piece', 'strokeWidthMm', 'number', 0.1, 20),
      ('piece', 'orderPalette', 'palette', 1, 24),
      ('label', 'fillStrategy', 'fill-strategy', NULL, NULL),
      ('label', 'darkFill', 'hex', NULL, NULL),
      ('label', 'darkTextStroke', 'hex', NULL, NULL),
      ('label', 'darkTextStrokeWidthRatio', 'number', 0, 0.25),
      ('label', 'lightFill', 'hex', NULL, NULL),
      ('label', 'lightTextStroke', 'hex', NULL, NULL),
      ('label', 'lightTextStrokeWidthRatio', 'number', 0, 0.25),
      ('label', 'fontWeight', 'integer', 100, 1000),
      ('label', 'orderFontRatio', 'number', 0.2, 2.5),
      ('label', 'positionFontRatio', 'number', 0.2, 2.5),
      ('label', 'sizeFontRatio', 'number', 0.2, 2.5),
      ('label', 'orderPositionGapRatio', 'number', -0.3, 1.5),
      ('label', 'positionSizeGapRatio', 'number', -0.3, 1.5),
      ('label', 'letterSpacingRatio', 'number', -0.2, 0.4),
      ('sourceSvg', 'minStrokePx', 'nullable-number', 0.1, 20),
      ('sourceSvg', 'nonScalingStroke', 'boolean', NULL, NULL),
      ('sourceSvg', 'strokeColorMode', 'stroke-color-mode', NULL, NULL),
      ('sourceSvg', 'fixedStroke', 'hex', NULL, NULL),
      ('sourceSvg', 'strokeOpacity', 'number', 0.05, 1),
      ('sourceSvg', 'pastelSaturationPercent', 'number', 0, 100),
      ('sourceSvg', 'pastelLightnessPercent', 'number', 0, 100),
      ('rawSvgScreenshot', 'minStrokePx', 'number', 0.1, 20)
    ) AS specs(section, field, kind, lo, hi)
  LOOP
    value := p_style -> spec.section -> spec.field;
    number_value := CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::numeric END;
    ok := CASE spec.kind
      WHEN 'hex' THEN jsonb_typeof(value) = 'string' AND (value #>> '{}') ~ hex
      WHEN 'number' THEN number_value BETWEEN spec.lo AND spec.hi
      WHEN 'integer' THEN number_value BETWEEN spec.lo AND spec.hi AND number_value = trunc(number_value)
      WHEN 'nullable-number' THEN jsonb_typeof(value) = 'null' OR number_value BETWEEN spec.lo AND spec.hi
      WHEN 'boolean' THEN jsonb_typeof(value) = 'boolean'
      WHEN 'fill-strategy' THEN jsonb_typeof(value) = 'string' AND (value #>> '{}') IN ('fixed', 'contrast')
      WHEN 'stroke-color-mode' THEN jsonb_typeof(value) = 'string'
        AND (value #>> '{}') IN ('preserve', 'piece-pastel', 'fixed')
      WHEN 'palette' THEN jsonb_typeof(value) = 'array'
        AND jsonb_array_length(value) BETWEEN spec.lo AND spec.hi
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(value) AS color(item)
          WHERE (jsonb_typeof(color.item) = 'string' AND (color.item #>> '{}') ~ hex) IS NOT TRUE
        )
    END;
    IF ok IS NOT TRUE THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cut_sheet_render_is_complete(p_sheet jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE STRICT
AS $function$
DECLARE
  render JSONB := p_sheet -> 'renderSnapshot';
  stored JSONB;
  model JSONB;
  style JSONB;
  piece JSONB;
  bath JSONB;
  model_keys TEXT[];
  sheet_keys TEXT[];
BEGIN
  IF jsonb_typeof(render) IS DISTINCT FROM 'object'
    OR jsonb_typeof(render -> 'views') IS DISTINCT FROM 'object'
    OR jsonb_typeof(render -> 'pdfMeta') IS DISTINCT FROM 'object'
    OR jsonb_typeof(render -> 'pdfDetailRows') IS DISTINCT FROM 'array'
  THEN
    RETURN FALSE;
  END IF;

  -- Contract v1: twelve finished views, unchanged since migration 080.
  IF render ->> 'contractVersion' = 'cut_sheet_render_v1' THEN
    RETURN (SELECT count(*) FROM jsonb_object_keys(render -> 'views')) = 12;
  END IF;
  IF render ->> 'contractVersion' IS DISTINCT FROM 'cut_sheet_render_v2' THEN
    RETURN FALSE;
  END IF;

  -- Contract v2: exactly the label-free SVG + the render model, nothing else.
  IF (SELECT count(*) FROM jsonb_object_keys(render)) <> 5
    OR NOT render ?& ARRAY['contractVersion', 'views', 'model', 'pdfMeta', 'pdfDetailRows']
    OR (SELECT count(*) FROM jsonb_object_keys(render -> 'views')) <> 1
    OR NOT (render -> 'views') ? 'r0:raw:top-left:labels-off'
  THEN
    RETURN FALSE;
  END IF;
  stored := render #> '{views,r0:raw:top-left:labels-off}';
  IF jsonb_typeof(stored) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(stored)) <> 1
    OR jsonb_typeof(stored -> 'svg') IS DISTINCT FROM 'string'
    OR stored ->> 'svg' = ''
  THEN
    RETURN FALSE;
  END IF;

  model := render -> 'model';
  IF jsonb_typeof(model) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(model)) <> 3
    OR NOT model ?& ARRAY['renderStyle', 'showBathMeterGuides', 'pieces']
    OR jsonb_typeof(model -> 'showBathMeterGuides') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(model -> 'pieces') IS DISTINCT FROM 'array'
  THEN
    RETURN FALSE;
  END IF;
  style := model -> 'renderStyle';
  IF jsonb_typeof(style) = 'object' THEN
    IF public.cut_render_style_is_complete(style) IS NOT TRUE THEN
      RETURN FALSE;
    END IF;
  ELSIF jsonb_typeof(style) IS DISTINCT FROM 'null' THEN
    RETURN FALSE;
  END IF;

  FOR piece IN SELECT value FROM jsonb_array_elements(model -> 'pieces') LOOP
    IF jsonb_typeof(piece) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(piece)) <> 5
      OR NOT piece ?& ARRAY['itemId', 'instance', 'label', 'fill', 'bath']
      OR jsonb_typeof(piece -> 'itemId') IS DISTINCT FROM 'string'
      OR piece ->> 'itemId' = ''
      OR jsonb_typeof(piece -> 'instance') IS DISTINCT FROM 'number'
      OR piece ->> 'instance' !~ '^[1-9][0-9]*$'
      OR jsonb_typeof(piece -> 'label') IS DISTINCT FROM 'array'
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(piece -> 'label') AS line(value)
        WHERE jsonb_typeof(line.value) IS DISTINCT FROM 'string'
      )
      OR jsonb_typeof(piece -> 'fill') NOT IN ('string', 'null')
    THEN
      RETURN FALSE;
    END IF;
    bath := piece -> 'bath';
    IF jsonb_typeof(bath) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(bath)) <> 3
      OR NOT bath ?& ARRAY['edgeTypeName', 'millingTypeName', 'doweling']
      OR jsonb_typeof(bath -> 'edgeTypeName') NOT IN ('string', 'null')
      OR jsonb_typeof(bath -> 'millingTypeName') NOT IN ('string', 'null')
      OR jsonb_typeof(bath -> 'doweling') IS DISTINCT FROM 'boolean'
    THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  -- The model covers exactly the sheet's real pieces, each once.
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::TEXT[]) INTO model_keys
  FROM (
    SELECT (value ->> 'itemId') || '#' || (value ->> 'instance') AS key
    FROM jsonb_array_elements(model -> 'pieces')
  ) AS model_pieces;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::TEXT[]) INTO sheet_keys
  FROM (
    SELECT (value ->> 'item_id') || '#' || (value ->> 'instance') AS key
    FROM jsonb_array_elements(p_sheet #> '{placements,pieces}')
  ) AS sheet_pieces;
  IF cardinality(model_keys) <> (SELECT count(DISTINCT key) FROM unnest(model_keys) AS key)
    OR model_keys IS DISTINCT FROM sheet_keys
  THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cut_result_snapshot_is_complete(p_snapshot jsonb, p_manifest jsonb, p_digest text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE STRICT
AS $function$
DECLARE
  group_json JSONB;
  sheet_json JSONB;
  item_json JSONB;
  auto_piece_keys TEXT[];
  manual_piece_keys TEXT[];
  item_count INTEGER;
  informational_snapshot BOOLEAN;
BEGIN
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_snapshot -> 'groups') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_snapshot -> 'items') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_snapshot -> 'totals') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_snapshot -> 'unplaced') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
    OR COALESCE(p_manifest ->> 'groups', '') !~ '^[0-9]+$'
    OR COALESCE(p_manifest ->> 'items', '') !~ '^[0-9]+$'
    OR COALESCE(p_manifest ->> 'instances', '') !~ '^[0-9]+$'
    OR COALESCE(p_manifest ->> 'unplaced', '') !~ '^[0-9]+$'
    OR jsonb_typeof(p_manifest -> 'variants') IS DISTINCT FROM 'array'
    OR p_digest !~ '^[0-9a-f]{64}$'
    OR p_digest <> cut_result_snapshot_digest(p_snapshot)
  THEN
    RETURN FALSE;
  END IF;

  item_count := jsonb_array_length(p_snapshot -> 'items');
  informational_snapshot := item_count = 0;

  IF jsonb_array_length(p_snapshot -> 'groups') = 0
    OR (p_manifest ->> 'groups')::integer <> jsonb_array_length(p_snapshot -> 'groups')
    OR (p_manifest ->> 'unplaced')::integer <> jsonb_array_length(p_snapshot -> 'unplaced')
    OR jsonb_array_length(p_manifest -> 'variants') <> jsonb_array_length(p_snapshot -> 'groups')
  THEN
    RETURN FALSE;
  END IF;

  IF informational_snapshot THEN
    IF jsonb_array_length(p_snapshot -> 'unplaced') <> 0
      OR (p_manifest ->> 'items')::integer = 0
      OR (p_manifest ->> 'instances')::integer = 0
    THEN
      RETURN FALSE;
    END IF;
  ELSE
    IF item_count = 0
      OR (p_manifest ->> 'items')::integer <> item_count
    THEN
      RETURN FALSE;
    END IF;

    FOR item_json IN SELECT value FROM jsonb_array_elements(p_snapshot -> 'items') LOOP
      IF jsonb_typeof(item_json) IS DISTINCT FROM 'object'
        OR jsonb_typeof(item_json -> 'qty') IS DISTINCT FROM 'number'
        OR (item_json ->> 'qty')::numeric <= 0
        OR cut_result_item_identity(item_json) IS NULL
      THEN
        RETURN FALSE;
      END IF;
    END LOOP;
    IF (p_manifest ->> 'instances')::integer <> (
      SELECT COALESCE(sum((value ->> 'qty')::integer), 0)
      FROM jsonb_array_elements(p_snapshot -> 'items')
    ) THEN
      RETURN FALSE;
    END IF;
  END IF;

  FOR group_json IN SELECT value FROM jsonb_array_elements(p_snapshot -> 'groups') LOOP
    IF jsonb_typeof(group_json) IS DISTINCT FROM 'object'
      OR jsonb_typeof(group_json -> 'sheets') IS DISTINCT FROM 'array'
      OR jsonb_array_length(group_json -> 'sheets') = 0
      OR NOT COALESCE(jsonb_typeof(group_json -> 'manualLayout') IN ('null', 'object'), FALSE)
    THEN
      RETURN FALSE;
    END IF;

    IF informational_snapshot THEN
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(group_json -> 'sheets') AS group_sheet(sheet_json),
             jsonb_array_elements(group_sheet.sheet_json -> 'placements' -> 'pieces') AS group_piece(piece_json)
      ) THEN
        RETURN FALSE;
      END IF;
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(group_json -> 'sheets') AS group_sheet(sheet_json),
             jsonb_array_elements(group_sheet.sheet_json -> 'placements' -> 'pieces') AS group_piece(piece_json)
        WHERE COALESCE(btrim(group_piece.piece_json ->> 'item_id'), '') = ''
          OR jsonb_typeof(group_piece.piece_json -> 'instance') IS DISTINCT FROM 'number'
          OR (group_piece.piece_json ->> 'instance')::integer <= 0
          OR jsonb_typeof(group_piece.piece_json -> 'label') IS DISTINCT FROM 'object'
          OR COALESCE(jsonb_typeof(group_piece.piece_json #> '{label,detailId}'), '') <> 'null'
      ) THEN
        RETURN FALSE;
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_snapshot -> 'items') AS snapshot_item(item_json)
        WHERE snapshot_item.item_json ->> 'cutGroupId' = group_json ->> 'cutGroupId'
      ) THEN
        RETURN FALSE;
      END IF;
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(group_json -> 'sheets') AS group_sheet(sheet_json),
             jsonb_array_elements(group_sheet.sheet_json -> 'placements' -> 'pieces') AS group_piece(piece_json)
        WHERE NOT (
          COALESCE(group_piece.piece_json ->> 'item_id', '') LIKE 'svg-%'
          AND jsonb_typeof(group_piece.piece_json -> 'label') = 'object'
          AND jsonb_typeof(group_piece.piece_json #> '{label,detailId}') = 'null'
          AND COALESCE(jsonb_typeof(group_piece.piece_json #> '{label,orderId}'), 'null') IN ('number', 'null')
          AND jsonb_typeof(group_piece.piece_json -> 'instance') = 'number'
          AND (group_piece.piece_json ->> 'instance')::integer > 0
        ) AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_snapshot -> 'items') AS snapshot_item(item_json)
          WHERE cut_result_item_identity(snapshot_item.item_json) = group_piece.piece_json ->> 'item_id'
            AND snapshot_item.item_json ->> 'cutGroupId' = group_json ->> 'cutGroupId'
        )
      ) THEN
        RETURN FALSE;
      END IF;
    END IF;

    FOR sheet_json IN SELECT value FROM jsonb_array_elements(group_json -> 'sheets') LOOP
      IF jsonb_typeof(sheet_json -> 'placements') IS DISTINCT FROM 'object'
        OR jsonb_typeof(sheet_json #> '{placements,pieces}') IS DISTINCT FROM 'array'
        OR NOT public.cut_sheet_render_is_complete(sheet_json)
      THEN
        RETURN FALSE;
      END IF;
    END LOOP;

    IF jsonb_typeof(group_json -> 'manualLayout') = 'object' THEN
      IF jsonb_typeof(group_json #> '{manualLayout,sheets}') IS DISTINCT FROM 'array'
        OR jsonb_array_length(group_json #> '{manualLayout,sheets}') = 0
        OR jsonb_typeof(group_json #> '{manualLayout,isActive}') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(group_json #> '{manualLayout,isStale}') IS DISTINCT FROM 'boolean'
        OR (
          (group_json #>> '{manualLayout,isActive}')::boolean
          AND (group_json #>> '{manualLayout,isStale}')::boolean
        )
      THEN
        RETURN FALSE;
      END IF;
      FOR sheet_json IN SELECT value FROM jsonb_array_elements(group_json #> '{manualLayout,sheets}') LOOP
        IF jsonb_typeof(sheet_json -> 'placements') IS DISTINCT FROM 'object'
          OR jsonb_typeof(sheet_json #> '{placements,pieces}') IS DISTINCT FROM 'array'
          OR NOT public.cut_sheet_render_is_complete(sheet_json)
        THEN
          RETURN FALSE;
        END IF;
      END LOOP;

      SELECT COALESCE(array_agg(piece_key ORDER BY piece_key), ARRAY[]::TEXT[])
      INTO auto_piece_keys
      FROM (
        SELECT (auto_piece.piece_json ->> 'item_id') || '#' || (auto_piece.piece_json ->> 'instance') AS piece_key
        FROM jsonb_array_elements(group_json -> 'sheets') AS auto_sheet(sheet_json),
             jsonb_array_elements(auto_sheet.sheet_json -> 'placements' -> 'pieces') AS auto_piece(piece_json)
      ) AS auto_pieces;
      SELECT COALESCE(array_agg(piece_key ORDER BY piece_key), ARRAY[]::TEXT[])
      INTO manual_piece_keys
      FROM (
        SELECT (manual_piece.piece_json ->> 'item_id') || '#' || (manual_piece.piece_json ->> 'instance') AS piece_key
        FROM jsonb_array_elements(group_json #> '{manualLayout,sheets}') AS manual_sheet(sheet_json),
             jsonb_array_elements(manual_sheet.sheet_json -> 'placements' -> 'pieces') AS manual_piece(piece_json)
      ) AS manual_pieces;
      IF manual_piece_keys IS DISTINCT FROM auto_piece_keys THEN
        RETURN FALSE;
      END IF;
    END IF;
  END LOOP;

  IF EXISTS (
      WITH all_instances AS (
        SELECT piece.piece_json ->> 'item_id' AS item_id,
               (piece.piece_json ->> 'instance')::integer AS instance
        FROM jsonb_array_elements(p_snapshot -> 'groups') AS group_item(group_json),
             jsonb_array_elements(group_item.group_json -> 'sheets') AS sheet_item(sheet_json),
             jsonb_array_elements(sheet_item.sheet_json -> 'placements' -> 'pieces') AS piece(piece_json)
        -- svg_source_instance_sequence_v1: ERP instances include unplaced below.
        WHERE informational_snapshot OR piece.piece_json ->> 'item_id' LIKE 'svg-%'
      ),
      actual AS (
        SELECT item_id, count(*) AS instances, count(DISTINCT instance) AS distinct_instances,
               min(instance) AS min_instance, max(instance) AS max_instance
        FROM all_instances GROUP BY item_id
      )
      SELECT 1
      FROM actual
      WHERE COALESCE(btrim(item_id), '') = ''
        OR instances <> distinct_instances
        OR min_instance <> 1
        OR max_instance <> instances
    ) THEN
      RETURN FALSE;
    END IF;
  IF NOT informational_snapshot THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_snapshot -> 'items') AS snapshot_item(item_json)
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_snapshot -> 'groups') AS snapshot_group(group_json)
        WHERE snapshot_group.group_json ->> 'cutGroupId' = snapshot_item.item_json ->> 'cutGroupId'
      )
    ) THEN
      RETURN FALSE;
    END IF;

    IF EXISTS (
      WITH expected_raw AS (
        SELECT cut_result_item_identity(item.item_json) AS item_id,
               (item.item_json ->> 'qty')::integer AS qty
        FROM jsonb_array_elements(p_snapshot -> 'items') AS item(item_json)
      ),
      expected AS (
        SELECT item_id, min(qty) AS qty, count(*) AS definitions
        FROM expected_raw GROUP BY item_id
      ),
      all_instances AS (
        SELECT piece.piece_json ->> 'item_id' AS item_id,
               (piece.piece_json ->> 'instance')::integer AS instance
        FROM jsonb_array_elements(p_snapshot -> 'groups') AS group_item(group_json),
             jsonb_array_elements(group_item.group_json -> 'sheets') AS sheet_item(sheet_json),
             jsonb_array_elements(sheet_item.sheet_json -> 'placements' -> 'pieces') AS piece(piece_json)
        UNION ALL
        SELECT unplaced.item_json ->> 'itemId', (unplaced.item_json ->> 'instance')::integer
        FROM jsonb_array_elements(p_snapshot -> 'unplaced') AS unplaced(item_json)
      ),
      actual AS (
        SELECT item_id, count(*) AS instances, count(DISTINCT instance) AS distinct_instances,
               min(instance) AS min_instance, max(instance) AS max_instance
        FROM all_instances WHERE item_id NOT LIKE 'svg-%' GROUP BY item_id
      )
      SELECT 1
      FROM expected e
      FULL JOIN actual a USING (item_id)
      WHERE e.item_id IS NULL OR a.item_id IS NULL OR e.definitions <> 1
        OR a.instances <> e.qty OR a.distinct_instances <> e.qty
        OR a.min_instance <> 1 OR a.max_instance <> e.qty
    ) THEN
      RETURN FALSE;
    END IF;
  END IF;

  IF p_manifest IS DISTINCT FROM cut_result_expected_manifest(p_snapshot) THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cut_result_expected_manifest(p_snapshot jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE STRICT
AS $function$
  WITH snapshot_counts AS (
    SELECT jsonb_array_length(p_snapshot -> 'items') AS item_count
  ),
  piece_rows AS (
    SELECT piece.piece_json ->> 'item_id' AS item_id
    FROM jsonb_array_elements(p_snapshot -> 'groups') AS group_item(group_json),
         jsonb_array_elements(group_item.group_json -> 'sheets') AS sheet_item(sheet_json),
         jsonb_array_elements(sheet_item.sheet_json -> 'placements' -> 'pieces') AS piece(piece_json)
    UNION ALL
    SELECT unplaced.item_json ->> 'itemId'
    FROM jsonb_array_elements(p_snapshot -> 'unplaced') AS unplaced(item_json)
  ),
  item_rows AS (
    SELECT (item.item_json ->> 'qty')::integer AS qty
    FROM jsonb_array_elements(p_snapshot -> 'items') AS item(item_json)
  ),
  manifest_counts AS (
    SELECT
      CASE
        WHEN snapshot_counts.item_count > 0 THEN snapshot_counts.item_count
        ELSE (SELECT count(DISTINCT item_id)::integer FROM piece_rows)
      END AS items,
      CASE
        WHEN snapshot_counts.item_count > 0 THEN (SELECT COALESCE(sum(qty), 0)::integer FROM item_rows)
        ELSE (SELECT count(*)::integer FROM piece_rows)
      END AS instances
    FROM snapshot_counts
  )
  SELECT jsonb_build_object(
    'groups', jsonb_array_length(p_snapshot -> 'groups'),
    'items', manifest_counts.items,
    'instances', manifest_counts.instances,
    'unplaced', jsonb_array_length(p_snapshot -> 'unplaced'),
    'variants', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'groupKey', COALESCE(group_item.group_json ->> 'groupKey', 'group:' || (group_item.group_json ->> 'cutGroupId')),
        'autoSheets', COALESCE((
          SELECT jsonb_agg(sheet.sheet_json -> 'sheetIndex' ORDER BY sheet.ordinality)
          FROM jsonb_array_elements(group_item.group_json -> 'sheets') WITH ORDINALITY AS sheet(sheet_json, ordinality)
        ), '[]'::jsonb),
        'manualSheets', CASE WHEN jsonb_typeof(group_item.group_json -> 'manualLayout') = 'object' THEN COALESCE((
          SELECT jsonb_agg(sheet.sheet_json -> 'sheetIndex' ORDER BY sheet.ordinality)
          FROM jsonb_array_elements(group_item.group_json #> '{manualLayout,sheets}') WITH ORDINALITY AS sheet(sheet_json, ordinality)
        ), '[]'::jsonb) ELSE '[]'::jsonb END,
        'renderContract', COALESCE(group_item.group_json #>> '{sheets,0,renderSnapshot,contractVersion}', 'cut_sheet_render_v1'),
        'autoRenderViews', COALESCE((
          SELECT jsonb_agg((
            SELECT count(*) FROM jsonb_object_keys(sheet.sheet_json #> '{renderSnapshot,views}')
          ) ORDER BY sheet.ordinality)
          FROM jsonb_array_elements(group_item.group_json -> 'sheets') WITH ORDINALITY AS sheet(sheet_json, ordinality)
        ), '[]'::jsonb),
        'manualRenderViews', CASE WHEN jsonb_typeof(group_item.group_json -> 'manualLayout') = 'object' THEN COALESCE((
          SELECT jsonb_agg((
            SELECT count(*) FROM jsonb_object_keys(sheet.sheet_json #> '{renderSnapshot,views}')
          ) ORDER BY sheet.ordinality)
          FROM jsonb_array_elements(group_item.group_json #> '{manualLayout,sheets}') WITH ORDINALITY AS sheet(sheet_json, ordinality)
        ), '[]'::jsonb) ELSE '[]'::jsonb END,
        'manualState', CASE
          WHEN jsonb_typeof(group_item.group_json -> 'manualLayout') <> 'object' THEN 'none'
          WHEN (group_item.group_json #>> '{manualLayout,isStale}')::boolean THEN 'stale'
          WHEN (group_item.group_json #>> '{manualLayout,isActive}')::boolean THEN 'active'
          ELSE 'inactive'
        END
      ) ORDER BY group_item.ordinality)
      FROM jsonb_array_elements(p_snapshot -> 'groups') WITH ORDINALITY AS group_item(group_json, ordinality)
    ), '[]'::jsonb)
  )
  FROM manifest_counts
$function$;

COMMIT;
