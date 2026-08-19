-- Keep the split bath-number sequence above every number shown before migration 133.
-- Legacy baths used В-<cut_job_id>; reusing those values makes a new bath look
-- identical to an older card, including cards already in «Завершенные ванны».

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('cut_job_display_number:vacuum'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE filename = '133_cut_job_split_display_numbers.sql'
  ) THEN
    RAISE EXCEPTION 'migration 133 boundary is required for vacuum-number remediation';
  END IF;
END $$;

CREATE TEMP TABLE vacuum_number_remap ON COMMIT DROP AS
WITH boundary AS (
  SELECT applied_at
  FROM schema_migrations
  WHERE filename = '133_cut_job_split_display_numbers.sql'
),
vacuum_jobs AS (
  SELECT j.cut_job_id, j.created_at
  FROM cut_job j
  LEFT JOIN cut_param_profiles profile
    ON profile.cut_param_profile_id = j.param_profile_id
  WHERE profile.params->>'layout_mode' = 'vacuum_table'
     OR j.last_calc_params->>'layout_mode' = 'vacuum_table'
     OR EXISTS (
       SELECT 1
       FROM cut_group g
       WHERE g.cut_job_id = j.cut_job_id
         AND (
           g.summary->>'engine_used' = 'vacuum_table'
           OR g.summary->>'layout_mode' = 'vacuum_table'
         )
     )
),
legacy_floor AS (
  SELECT COALESCE(MAX(v.cut_job_id), 0) AS value
  FROM vacuum_jobs v
  CROSS JOIN boundary b
  WHERE v.created_at < b.applied_at
)
SELECT
  v.cut_job_id,
  CASE
    WHEN v.created_at < b.applied_at THEN 'В-' || v.cut_job_id::text
    ELSE 'В-' || (
      floor.value
      + row_number() OVER (
          PARTITION BY (v.created_at >= b.applied_at)
          ORDER BY v.created_at, v.cut_job_id
        )
    )::text
  END AS source_display_number
FROM vacuum_jobs v
CROSS JOIN boundary b
CROSS JOIN legacy_floor floor;

-- Clear the old compact values first so the unique index cannot reject a
-- valid swap such as old job 21 reclaiming В-21 from a newly created job.
UPDATE cut_job job
SET source_display_number = NULL,
    updated_at = now()
FROM vacuum_number_remap remap
WHERE remap.cut_job_id = job.cut_job_id;

UPDATE cut_job job
SET source_display_number = remap.source_display_number,
    updated_at = now()
FROM vacuum_number_remap remap
WHERE remap.cut_job_id = job.cut_job_id;

COMMIT;
