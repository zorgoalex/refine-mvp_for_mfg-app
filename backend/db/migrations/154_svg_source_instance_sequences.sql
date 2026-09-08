-- 154_svg_source_instance_sequences.sql
-- Preserve regular cut snapshots whose lower-numbered instances are unplaced.
BEGIN;

CREATE OR REPLACE FUNCTION cut_result_snapshot_is_complete(
  p_snapshot JSONB,
  p_manifest JSONB,
  p_digest TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
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
          WHERE 'det-' || (snapshot_item.item_json ->> 'orderDetailId') = group_piece.piece_json ->> 'item_id'
            AND snapshot_item.item_json ->> 'cutGroupId' = group_json ->> 'cutGroupId'
        )
      ) THEN
        RETURN FALSE;
      END IF;
    END IF;

    FOR sheet_json IN SELECT value FROM jsonb_array_elements(group_json -> 'sheets') LOOP
      IF jsonb_typeof(sheet_json -> 'placements') IS DISTINCT FROM 'object'
        OR jsonb_typeof(sheet_json #> '{placements,pieces}') IS DISTINCT FROM 'array'
        OR sheet_json #>> '{renderSnapshot,contractVersion}' IS DISTINCT FROM 'cut_sheet_render_v1'
        OR jsonb_typeof(sheet_json #> '{renderSnapshot,views}') IS DISTINCT FROM 'object'
        OR (SELECT count(*) FROM jsonb_object_keys(sheet_json #> '{renderSnapshot,views}')) <> 12
        OR jsonb_typeof(sheet_json #> '{renderSnapshot,pdfMeta}') IS DISTINCT FROM 'object'
        OR jsonb_typeof(sheet_json #> '{renderSnapshot,pdfDetailRows}') IS DISTINCT FROM 'array'
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
          OR sheet_json #>> '{renderSnapshot,contractVersion}' IS DISTINCT FROM 'cut_sheet_render_v1'
          OR jsonb_typeof(sheet_json #> '{renderSnapshot,views}') IS DISTINCT FROM 'object'
          OR (SELECT count(*) FROM jsonb_object_keys(sheet_json #> '{renderSnapshot,views}')) <> 12
          OR jsonb_typeof(sheet_json #> '{renderSnapshot,pdfMeta}') IS DISTINCT FROM 'object'
          OR jsonb_typeof(sheet_json #> '{renderSnapshot,pdfDetailRows}') IS DISTINCT FROM 'array'
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
        SELECT 'det-' || (item.item_json ->> 'orderDetailId') AS item_id,
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
$$;


COMMIT;
