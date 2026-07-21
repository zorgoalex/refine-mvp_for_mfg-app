-- 082_label_cut_maps_backfill.sql
-- Backfill immutable cut-label projections one result per transaction, after
-- migration 081 has released its cut_result DDL lock and enabled dual-write.

CREATE OR REPLACE PROCEDURE backfill_cut_result_label_maps()
LANGUAGE plpgsql
AS $$
DECLARE
  result_id BIGINT;
BEGIN
  FOR result_id IN
    SELECT r.cut_result_id
    FROM cut_result r
    LEFT JOIN cut_result_label_map_projection p USING (cut_result_id)
    WHERE p.cut_result_id IS NULL
    ORDER BY r.cut_result_id
  LOOP
    PERFORM project_cut_result_label_maps(result_id);
    COMMIT;
  END LOOP;
END;
$$;

CALL backfill_cut_result_label_maps();

DROP PROCEDURE backfill_cut_result_label_maps();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cut_result r
    CROSS JOIN LATERAL cut_result_label_map_expected_counts(r.snapshot_job) expected
    LEFT JOIN cut_result_label_map_projection p USING (cut_result_id)
    WHERE p.cut_result_id IS NULL
       OR p.snapshot_digest IS DISTINCT FROM r.snapshot_digest
       OR p.sheet_count IS DISTINCT FROM expected.sheet_count
       OR p.placement_count IS DISTINCT FROM expected.placement_count
       OR p.sheet_count IS DISTINCT FROM (
         SELECT count(*) FROM cut_result_sheet_map s WHERE s.cut_result_id = r.cut_result_id
       )
       OR p.placement_count IS DISTINCT FROM (
         SELECT count(*) FROM cut_result_placement cp WHERE cp.cut_result_id = r.cut_result_id
       )
  ) THEN
    RAISE EXCEPTION 'cut-result label-map backfill coverage validation failed';
  END IF;
END;
$$;
