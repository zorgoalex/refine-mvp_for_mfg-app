-- 122_cut_result_informational_label_maps.sql
-- Project label-map sheet/placement rows for informational SVG cut results.

BEGIN;

ALTER TABLE cut_result_placement
  ALTER COLUMN order_detail_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION project_cut_result_label_maps(p_cut_result_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  result_row RECORD;
  group_entry RECORD;
  sheet_entry RECORD;
  piece_json JSONB;
  item_json JSONB;
  group_json JSONB;
  sheet_json JSONB;
  sheet_map_id BIGINT;
  group_id BIGINT;
  group_key_value TEXT;
  item_id_value TEXT;
  items_by_id JSONB;
  has_active_manual BOOLEAN;
  informational_snapshot BOOLEAN;
  expected_sheet_count INTEGER := 0;
  expected_placement_count INTEGER := 0;
  snapshot_sheet_count INTEGER;
  snapshot_placement_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM cut_result_label_map_projection WHERE cut_result_id = p_cut_result_id
  ) THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM cut_result_sheet_map WHERE cut_result_id = p_cut_result_id
  ) THEN
    RAISE EXCEPTION 'cut result % has an incomplete label-map projection', p_cut_result_id;
  END IF;

  SELECT cut_result_id, cut_job_id, snapshot_job, snapshot_digest
  INTO result_row
  FROM cut_result
  WHERE cut_result_id = p_cut_result_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cut result % not found for label-map projection', p_cut_result_id;
  END IF;

  informational_snapshot := jsonb_array_length(result_row.snapshot_job -> 'items') = 0;

  SELECT COALESCE(
    jsonb_object_agg('det-' || (value ->> 'orderDetailId'), value),
    '{}'::JSONB
  )
  INTO items_by_id
  FROM jsonb_array_elements(result_row.snapshot_job -> 'items');

  SELECT counts.sheet_count, counts.placement_count
  INTO snapshot_sheet_count, snapshot_placement_count
  FROM cut_result_label_map_expected_counts(result_row.snapshot_job) AS counts;

  PERFORM set_config('erp.cut_label_projection_result_id', p_cut_result_id::TEXT, TRUE);

  BEGIN
  FOR group_entry IN
    SELECT value AS group_json
    FROM jsonb_array_elements(result_row.snapshot_job -> 'groups')
  LOOP
    group_json := group_entry.group_json;
    group_id := (group_json ->> 'cutGroupId')::BIGINT;
    group_key_value := COALESCE(group_json ->> 'groupKey', 'group:' || group_id::TEXT);
    has_active_manual :=
      jsonb_typeof(group_json -> 'manualLayout') = 'object'
      AND COALESCE((group_json #>> '{manualLayout,isActive}')::BOOLEAN, FALSE)
      AND NOT COALESCE((group_json #>> '{manualLayout,isStale}')::BOOLEAN, TRUE);

    FOR sheet_entry IN
      SELECT value AS sheet_json, ordinality::INTEGER AS sheet_ordinal
      FROM jsonb_array_elements(group_json -> 'sheets') WITH ORDINALITY
    LOOP
      sheet_json := sheet_entry.sheet_json;
      expected_sheet_count := expected_sheet_count + 1;
      INSERT INTO cut_result_sheet_map (
        cut_result_id, cut_job_id, cut_group_id, group_key, variant,
        sheet_index, sheet_ordinal, is_effective, sheet_width_mm,
        sheet_height_mm, base_svg
      ) VALUES (
        result_row.cut_result_id,
        result_row.cut_job_id,
        group_id,
        group_key_value,
        'auto',
        (sheet_json ->> 'sheetIndex')::INTEGER,
        sheet_entry.sheet_ordinal,
        NOT has_active_manual,
        (sheet_json #>> '{placements,sheet_width_mm}')::NUMERIC,
        (sheet_json #>> '{placements,sheet_height_mm}')::NUMERIC,
        sheet_json #>> ARRAY['renderSnapshot', 'views', 'r0:raw:top-left:labels-off', 'svg']
      )
      RETURNING cut_result_sheet_map_id INTO sheet_map_id;

      FOR piece_json IN
        SELECT value FROM jsonb_array_elements(sheet_json #> '{placements,pieces}')
      LOOP
        expected_placement_count := expected_placement_count + 1;
        item_id_value := piece_json ->> 'item_id';
        item_json := items_by_id -> item_id_value;
        IF item_json IS NULL THEN
          IF informational_snapshot THEN
            item_json := jsonb_build_object(
              'orderId', piece_json #> '{label,orderId}',
              'orderDetailId', NULL
            );
          ELSE
            RAISE EXCEPTION 'cut result % has unknown item %', p_cut_result_id, item_id_value;
          END IF;
        END IF;
        IF COALESCE(jsonb_typeof(item_json -> 'orderId'), '') <> 'number' THEN
          RAISE EXCEPTION 'cut result % has unknown order for item %', p_cut_result_id, item_id_value;
        END IF;
        INSERT INTO cut_result_placement (
          cut_result_sheet_map_id, cut_result_id, cut_job_id, order_id,
          order_detail_id, item_id, instance, variant, cut_group_id,
          sheet_index, x_mm, y_mm, width_mm, height_mm,
          detail_width_mm, detail_height_mm, rotated
        ) VALUES (
          sheet_map_id,
          result_row.cut_result_id,
          result_row.cut_job_id,
          (item_json ->> 'orderId')::BIGINT,
          (item_json ->> 'orderDetailId')::BIGINT,
          item_id_value,
          (piece_json ->> 'instance')::INTEGER,
          'auto',
          group_id,
          (sheet_json ->> 'sheetIndex')::INTEGER,
          (sheet_json #>> '{placements,trim_mm,left}')::NUMERIC + (piece_json ->> 'x_mm')::NUMERIC,
          (sheet_json #>> '{placements,trim_mm,top}')::NUMERIC + (piece_json ->> 'y_mm')::NUMERIC,
          (piece_json ->> 'width_mm')::NUMERIC,
          (piece_json ->> 'height_mm')::NUMERIC,
          CASE WHEN (piece_json ->> 'rotated')::BOOLEAN
            THEN (piece_json ->> 'height_mm')::NUMERIC ELSE (piece_json ->> 'width_mm')::NUMERIC END,
          CASE WHEN (piece_json ->> 'rotated')::BOOLEAN
            THEN (piece_json ->> 'width_mm')::NUMERIC ELSE (piece_json ->> 'height_mm')::NUMERIC END,
          (piece_json ->> 'rotated')::BOOLEAN
        );
      END LOOP;
    END LOOP;

    IF jsonb_typeof(group_json -> 'manualLayout') = 'object' THEN
      FOR sheet_entry IN
        SELECT value AS sheet_json, ordinality::INTEGER AS sheet_ordinal
        FROM jsonb_array_elements(group_json #> '{manualLayout,sheets}') WITH ORDINALITY
      LOOP
        sheet_json := sheet_entry.sheet_json;
        expected_sheet_count := expected_sheet_count + 1;
        INSERT INTO cut_result_sheet_map (
          cut_result_id, cut_job_id, cut_group_id, group_key, variant,
          sheet_index, sheet_ordinal, is_effective, sheet_width_mm,
          sheet_height_mm, base_svg
        ) VALUES (
          result_row.cut_result_id,
          result_row.cut_job_id,
          group_id,
          group_key_value,
          'manual',
          (sheet_json ->> 'sheetIndex')::INTEGER,
          sheet_entry.sheet_ordinal,
          has_active_manual,
          (sheet_json #>> '{placements,sheet_width_mm}')::NUMERIC,
          (sheet_json #>> '{placements,sheet_height_mm}')::NUMERIC,
          sheet_json #>> ARRAY['renderSnapshot', 'views', 'r0:raw:top-left:labels-off', 'svg']
        )
        RETURNING cut_result_sheet_map_id INTO sheet_map_id;

        FOR piece_json IN
          SELECT value FROM jsonb_array_elements(sheet_json #> '{placements,pieces}')
        LOOP
          expected_placement_count := expected_placement_count + 1;
          item_id_value := piece_json ->> 'item_id';
          item_json := items_by_id -> item_id_value;
          IF item_json IS NULL THEN
            IF informational_snapshot THEN
              item_json := jsonb_build_object(
                'orderId', piece_json #> '{label,orderId}',
                'orderDetailId', NULL
              );
            ELSE
              RAISE EXCEPTION 'cut result % has unknown manual item %', p_cut_result_id, item_id_value;
            END IF;
          END IF;
          IF COALESCE(jsonb_typeof(item_json -> 'orderId'), '') <> 'number' THEN
            RAISE EXCEPTION 'cut result % has unknown order for manual item %', p_cut_result_id, item_id_value;
          END IF;
          INSERT INTO cut_result_placement (
            cut_result_sheet_map_id, cut_result_id, cut_job_id, order_id,
            order_detail_id, item_id, instance, variant, cut_group_id,
            sheet_index, x_mm, y_mm, width_mm, height_mm,
            detail_width_mm, detail_height_mm, rotated
          ) VALUES (
            sheet_map_id,
            result_row.cut_result_id,
            result_row.cut_job_id,
            (item_json ->> 'orderId')::BIGINT,
            (item_json ->> 'orderDetailId')::BIGINT,
            item_id_value,
            (piece_json ->> 'instance')::INTEGER,
            'manual',
            group_id,
            (sheet_json ->> 'sheetIndex')::INTEGER,
            (sheet_json #>> '{placements,trim_mm,left}')::NUMERIC + (piece_json ->> 'x_mm')::NUMERIC,
            (sheet_json #>> '{placements,trim_mm,top}')::NUMERIC + (piece_json ->> 'y_mm')::NUMERIC,
            (piece_json ->> 'width_mm')::NUMERIC,
            (piece_json ->> 'height_mm')::NUMERIC,
            CASE WHEN (piece_json ->> 'rotated')::BOOLEAN
              THEN (piece_json ->> 'height_mm')::NUMERIC ELSE (piece_json ->> 'width_mm')::NUMERIC END,
            CASE WHEN (piece_json ->> 'rotated')::BOOLEAN
              THEN (piece_json ->> 'width_mm')::NUMERIC ELSE (piece_json ->> 'height_mm')::NUMERIC END,
            (piece_json ->> 'rotated')::BOOLEAN
          );
        END LOOP;
      END LOOP;
    END IF;
  END LOOP;

  IF expected_sheet_count IS DISTINCT FROM snapshot_sheet_count
     OR expected_placement_count IS DISTINCT FROM snapshot_placement_count
     OR expected_sheet_count IS DISTINCT FROM (
       SELECT count(*)::INTEGER FROM cut_result_sheet_map WHERE cut_result_id = p_cut_result_id
     ) OR expected_placement_count IS DISTINCT FROM (
       SELECT count(*)::INTEGER FROM cut_result_placement WHERE cut_result_id = p_cut_result_id
     ) THEN
    RAISE EXCEPTION 'cut result % label-map projection count mismatch', p_cut_result_id;
  END IF;

  INSERT INTO cut_result_label_map_projection (
    cut_result_id, snapshot_digest, sheet_count, placement_count
  ) VALUES (
    p_cut_result_id,
    result_row.snapshot_digest,
    expected_sheet_count,
    expected_placement_count
  );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('erp.cut_label_projection_result_id', '', TRUE);
    RAISE;
  END;

  PERFORM set_config('erp.cut_label_projection_result_id', '', TRUE);
END;
$$;

COMMIT;
