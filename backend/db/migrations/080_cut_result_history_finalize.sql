-- 080_cut_result_history_finalize.sql
--
-- Finalize only after backfill-cut-result-history and its validation probe pass.

BEGIN;

ALTER TABLE cut_result
  ALTER COLUMN snapshot_job SET NOT NULL,
  ALTER COLUMN snapshot_manifest SET NOT NULL,
  ALTER COLUMN snapshot_digest SET NOT NULL,
  ALTER COLUMN totals_snapshot SET NOT NULL;

ALTER TABLE cut_result
  ADD CONSTRAINT chk_cut_result_command_identity
  CHECK (
    (result_kind = 'legacy' AND command_id IS NULL AND command_payload_hash IS NULL)
    OR
    (result_kind IN ('auto', 'manual') AND command_id IS NOT NULL AND command_payload_hash IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION cut_result_expected_manifest(p_snapshot JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT jsonb_build_object(
    'groups', jsonb_array_length(p_snapshot -> 'groups'),
    'items', jsonb_array_length(p_snapshot -> 'items'),
    'instances', (
      SELECT COALESCE(sum((item.item_json ->> 'qty')::integer), 0)
      FROM jsonb_array_elements(p_snapshot -> 'items') AS item(item_json)
    ),
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
        'renderContract', 'cut_sheet_render_v1',
        'autoRenderViews', COALESCE((
          SELECT jsonb_agg(jsonb_object_length(sheet.sheet_json #> '{renderSnapshot,views}') ORDER BY sheet.ordinality)
          FROM jsonb_array_elements(group_item.group_json -> 'sheets') WITH ORDINALITY AS sheet(sheet_json, ordinality)
        ), '[]'::jsonb),
        'manualRenderViews', CASE WHEN jsonb_typeof(group_item.group_json -> 'manualLayout') = 'object' THEN COALESCE((
          SELECT jsonb_agg(jsonb_object_length(sheet.sheet_json #> '{renderSnapshot,views}') ORDER BY sheet.ordinality)
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
$$;

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
  IF jsonb_array_length(p_snapshot -> 'groups') = 0
    OR jsonb_array_length(p_snapshot -> 'items') = 0
    OR (p_manifest ->> 'groups')::integer <> jsonb_array_length(p_snapshot -> 'groups')
    OR (p_manifest ->> 'items')::integer <> jsonb_array_length(p_snapshot -> 'items')
    OR (p_manifest ->> 'unplaced')::integer <> jsonb_array_length(p_snapshot -> 'unplaced')
    OR jsonb_array_length(p_manifest -> 'variants') <> jsonb_array_length(p_snapshot -> 'groups')
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

  FOR group_json IN SELECT value FROM jsonb_array_elements(p_snapshot -> 'groups') LOOP
    IF jsonb_typeof(group_json) IS DISTINCT FROM 'object'
      OR jsonb_typeof(group_json -> 'sheets') IS DISTINCT FROM 'array'
      OR jsonb_array_length(group_json -> 'sheets') = 0
      OR NOT COALESCE(jsonb_typeof(group_json -> 'manualLayout') IN ('null', 'object'), FALSE)
    THEN
      RETURN FALSE;
    END IF;
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
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_snapshot -> 'items') AS snapshot_item(item_json)
        WHERE 'det-' || (snapshot_item.item_json ->> 'orderDetailId') = group_piece.piece_json ->> 'item_id'
          AND snapshot_item.item_json ->> 'cutGroupId' = group_json ->> 'cutGroupId'
      )
    ) THEN
      RETURN FALSE;
    END IF;
    FOR sheet_json IN SELECT value FROM jsonb_array_elements(group_json -> 'sheets') LOOP
      IF jsonb_typeof(sheet_json -> 'placements') IS DISTINCT FROM 'object'
        OR jsonb_typeof(sheet_json #> '{placements,pieces}') IS DISTINCT FROM 'array'
        OR sheet_json #>> '{renderSnapshot,contractVersion}' IS DISTINCT FROM 'cut_sheet_render_v1'
        OR jsonb_typeof(sheet_json #> '{renderSnapshot,views}') IS DISTINCT FROM 'object'
        OR jsonb_object_length(sheet_json #> '{renderSnapshot,views}') <> 12
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
          OR jsonb_object_length(sheet_json #> '{renderSnapshot,views}') <> 12
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
      FROM all_instances GROUP BY item_id
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
  IF p_manifest IS DISTINCT FROM cut_result_expected_manifest(p_snapshot) THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

ALTER TABLE cut_result
  ADD CONSTRAINT chk_cut_result_snapshot_shape
  CHECK (cut_result_snapshot_is_complete(snapshot_job, snapshot_manifest, snapshot_digest));

ALTER TABLE cut_job
  ADD CONSTRAINT chk_cut_job_next_result_no CHECK (next_cut_result_no > 0),
  ADD CONSTRAINT fk_cut_job_current_result_same_job
  FOREIGN KEY (cut_job_id, current_cut_result_id)
  REFERENCES cut_result(cut_job_id, cut_result_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION reject_cut_result_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cut result history is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_cut_result_append_only ON cut_result;
CREATE TRIGGER trg_cut_result_append_only
BEFORE UPDATE OR DELETE ON cut_result
FOR EACH ROW EXECUTE FUNCTION reject_cut_result_mutation();

CREATE OR REPLACE FUNCTION validate_cut_result_command_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'completed' AND (
    NEW.cut_result_id IS NULL OR NEW.failure_code IS NOT NULL
    OR NEW.completed_at IS NULL OR NEW.owner_token IS NOT NULL
    OR NEW.lease_expires_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'invalid completed cut result command state';
  END IF;
  IF NEW.status = 'failed' AND (
    NEW.cut_result_id IS NOT NULL OR NEW.failure_code IS NULL
    OR NEW.completed_at IS NULL OR NEW.owner_token IS NOT NULL
    OR NEW.lease_expires_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'invalid failed cut result command state';
  END IF;
  IF NEW.status = 'in_progress' AND (
    NEW.cut_result_id IS NOT NULL OR NEW.failure_code IS NOT NULL OR NEW.completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'invalid in-progress cut result command state';
  END IF;
  IF NEW.status = 'in_progress' AND NEW.command_type = 'calculate' AND (
    NEW.owner_token IS NULL OR NEW.lease_expires_at IS NULL OR NEW.claimed_job_version IS NULL
  ) THEN
    RAISE EXCEPTION 'calculate command lease ownership and claimed version are required';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cut_result_command_state ON cut_result_command;
CREATE CONSTRAINT TRIGGER trg_cut_result_command_state
AFTER INSERT OR UPDATE ON cut_result_command
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_cut_result_command_state();

CREATE OR REPLACE FUNCTION reject_cut_result_command_terminal_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cut result command ledger is append-preserving';
  END IF;
  IF OLD.status IN ('completed', 'failed') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal cut result command is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cut_result_command_terminal_immutable ON cut_result_command;
CREATE TRIGGER trg_cut_result_command_terminal_immutable
BEFORE UPDATE OR DELETE ON cut_result_command
FOR EACH ROW EXECUTE FUNCTION reject_cut_result_command_terminal_mutation();

CREATE OR REPLACE FUNCTION validate_cut_result_ledger_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.result_kind <> 'legacy' AND NOT EXISTS (
    SELECT 1
    FROM cut_result_command c
    WHERE c.cut_job_id = NEW.cut_job_id
      AND c.command_id = NEW.command_id
      AND c.payload_hash = NEW.command_payload_hash
      AND c.status = 'completed'
      AND c.cut_result_id = NEW.cut_result_id
  ) THEN
    RAISE EXCEPTION 'cut result requires its completed command ledger row';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cut_result_ledger_state ON cut_result;
CREATE CONSTRAINT TRIGGER trg_cut_result_ledger_state
AFTER INSERT ON cut_result
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_cut_result_ledger_state();

COMMIT;
