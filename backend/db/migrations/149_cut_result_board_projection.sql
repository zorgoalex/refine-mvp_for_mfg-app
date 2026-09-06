-- Compact immutable cut-result metadata for operational MDF reads.
BEGIN;

CREATE TABLE IF NOT EXISTS cut_result_board_projection (
  cut_result_id BIGINT PRIMARY KEY REFERENCES cut_result(cut_result_id) ON DELETE RESTRICT,
  snapshot_digest TEXT NOT NULL,
  is_vacuum BOOLEAN NOT NULL,
  cut_job_name TEXT,
  result_created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cut_result_board_vacuum_created
  ON cut_result_board_projection (result_created_at DESC, cut_result_id DESC)
  WHERE is_vacuum = true;

CREATE OR REPLACE FUNCTION cut_result_snapshot_is_vacuum(p_snapshot JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  flag JSONB := p_snapshot -> 'isVacuum';
BEGIN
  IF flag IS NOT NULL AND flag <> 'null'::JSONB THEN
    IF jsonb_typeof(flag) IN ('boolean', 'string')
       AND p_snapshot ->> 'isVacuum' IN ('true', 'false') THEN
      RETURN p_snapshot ->> 'isVacuum' = 'true';
    END IF;
    RAISE EXCEPTION 'invalid explicit cut-result isVacuum value' USING ERRCODE = '22023';
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_snapshot -> 'groups', '[]'::JSONB)) AS g
    WHERE g -> 'summary' ->> 'engine_used' = 'vacuum_table'
       OR g -> 'summary' ->> 'layout_mode' = 'vacuum_table'
  );
END;
$$;

CREATE OR REPLACE FUNCTION project_cut_result_board_metadata(p_cut_result_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  result_row RECORD;
  vacuum BOOLEAN;
  frozen_name TEXT;
  previous_guard TEXT := current_setting('erp.cut_board_projection_result_id', TRUE);
BEGIN
  SELECT cut_result_id, snapshot_digest, snapshot_job, created_at
    INTO STRICT result_row FROM cut_result WHERE cut_result_id = p_cut_result_id;
  vacuum := cut_result_snapshot_is_vacuum(result_row.snapshot_job);
  frozen_name := result_row.snapshot_job ->> 'name';
  PERFORM set_config('erp.cut_board_projection_result_id', p_cut_result_id::TEXT, TRUE);
  INSERT INTO cut_result_board_projection (
    cut_result_id, snapshot_digest, is_vacuum, cut_job_name, result_created_at
  ) VALUES (
    p_cut_result_id, result_row.snapshot_digest, vacuum, frozen_name, result_row.created_at
  ) ON CONFLICT (cut_result_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM cut_result_board_projection p
    WHERE p.cut_result_id = p_cut_result_id
      AND p.snapshot_digest = result_row.snapshot_digest
      AND p.is_vacuum = vacuum
      AND p.cut_job_name IS NOT DISTINCT FROM frozen_name
      AND p.result_created_at = result_row.created_at
  ) THEN
    RAISE EXCEPTION 'cut-result board projection mismatch for %', p_cut_result_id;
  END IF;
  PERFORM set_config('erp.cut_board_projection_result_id', COALESCE(previous_guard, ''), TRUE);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('erp.cut_board_projection_result_id', COALESCE(previous_guard, ''), TRUE);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION guard_cut_result_board_projection()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'cut-result board projection is append-only' USING ERRCODE = '55000';
  END IF;
  IF current_setting('erp.cut_board_projection_result_id', TRUE)
     IS DISTINCT FROM NEW.cut_result_id::TEXT THEN
    RAISE EXCEPTION 'cut-result board metadata is written only by its projector' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cut_result_board_projection_guard ON cut_result_board_projection;
CREATE TRIGGER trg_cut_result_board_projection_guard
  BEFORE INSERT OR UPDATE OR DELETE ON cut_result_board_projection
  FOR EACH ROW EXECUTE FUNCTION guard_cut_result_board_projection();

CREATE OR REPLACE FUNCTION project_new_cut_result_board_metadata()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM project_cut_result_board_metadata(NEW.cut_result_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cut_result_board_projection ON cut_result;
CREATE TRIGGER trg_cut_result_board_projection
  AFTER INSERT ON cut_result
  FOR EACH ROW EXECUTE FUNCTION project_new_cut_result_board_metadata();

COMMIT;
