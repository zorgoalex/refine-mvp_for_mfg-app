-- Prefix vacuum-table cut numbers with the Cyrillic "В-" marker.

BEGIN;

WITH bath_candidates AS (
  SELECT snapshot.bazis_cut_set_detail_id,
         cj.cut_job_id,
         cr.result_no,
         row_number() OVER (
           PARTITION BY snapshot.bazis_cut_set_detail_id
           ORDER BY cj.cut_job_id DESC
         ) AS rank
  FROM bazis_cut_set_details snapshot
  JOIN cut_job_item item
    ON item.order_detail_id = snapshot.source_order_detail_id
   AND item.is_active = true
  JOIN cut_job cj
    ON cj.cut_job_id = item.cut_job_id
   AND cj.status = 'ready'
   AND cj.last_calc_basis IS NOT NULL
  JOIN cut_result cr
    ON cr.cut_result_id = cj.current_cut_result_id
   AND cr.cut_job_id = cj.cut_job_id
  LEFT JOIN cut_result_archive_state archived
    ON archived.cut_job_id = cr.cut_job_id
   AND archived.result_no = cr.result_no
  LEFT JOIN cut_param_profiles profile
    ON profile.cut_param_profile_id = cj.param_profile_id
  WHERE archived.cut_job_id IS NULL
    AND COALESCE(
      cj.last_calc_params->>'layout_mode',
      profile.params->>'layout_mode',
      cj.params->>'layout_mode'
    ) = 'vacuum_table'
)
UPDATE bazis_cut_set_details snapshot
SET source_bath_cut_number = 'В-' || candidate.cut_job_id::text || '-' || candidate.result_no::text
FROM bath_candidates candidate
WHERE candidate.bazis_cut_set_detail_id = snapshot.bazis_cut_set_detail_id
  AND candidate.rank = 1
  AND snapshot.source_bath_cut_number IS DISTINCT FROM 'В-' || candidate.cut_job_id::text || '-' || candidate.result_no::text;

UPDATE bazis_cut_set_details
SET source_bath_cut_number = 'В-' || source_bath_cut_number
WHERE source_bath_cut_number ~ '^[0-9]+-[0-9]+$';

COMMENT ON COLUMN bazis_cut_set_details.source_bath_cut_number IS
  'bazis-cut-bath-number-v2: frozen В-<cut job id>-<current result number>';

COMMIT;
