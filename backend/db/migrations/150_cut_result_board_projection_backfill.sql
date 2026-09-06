-- Run outside a wrapping transaction: release locks between historical results.
CREATE OR REPLACE PROCEDURE backfill_cut_result_board_metadata()
LANGUAGE plpgsql AS $$
DECLARE result_id BIGINT;
BEGIN
  FOR result_id IN
    SELECT r.cut_result_id FROM cut_result r
    LEFT JOIN cut_result_board_projection p USING (cut_result_id)
    WHERE p.cut_result_id IS NULL
    ORDER BY r.cut_result_id
  LOOP
    PERFORM project_cut_result_board_metadata(result_id);
    COMMIT;
  END LOOP;
END;
$$;

CALL backfill_cut_result_board_metadata();
DROP PROCEDURE backfill_cut_result_board_metadata();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cut_result r
    LEFT JOIN cut_result_board_projection p USING (cut_result_id)
    WHERE p.cut_result_id IS NULL
       OR p.snapshot_digest IS DISTINCT FROM r.snapshot_digest
       OR p.result_created_at IS DISTINCT FROM r.created_at
       OR p.is_vacuum IS DISTINCT FROM cut_result_snapshot_is_vacuum(r.snapshot_job)
       OR p.cut_job_name IS DISTINCT FROM r.snapshot_job ->> 'name'
  ) THEN
    RAISE EXCEPTION 'cut-result board projection coverage validation failed';
  END IF;
END;
$$;
