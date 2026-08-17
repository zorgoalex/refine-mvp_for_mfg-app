-- Independent operator-facing cut job numbers for regular cuts and vacuum-table baths.

BEGIN;

ALTER TABLE cut_job
  ADD COLUMN IF NOT EXISTS source_display_number TEXT;

UPDATE cut_job
SET source_display_number = NULLIF(btrim(source_display_number), ''),
    updated_at = now()
WHERE source_display_number IS DISTINCT FROM NULLIF(btrim(source_display_number), '');

WITH vacuum_jobs AS (
  SELECT j.cut_job_id
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
)
UPDATE cut_job job
SET source_display_number = 'В-' || job.source_display_number,
    updated_at = now()
FROM vacuum_jobs
WHERE job.cut_job_id = vacuum_jobs.cut_job_id
  AND job.source_display_number ~ '^[0-9]+$';

WITH duplicate_numbers AS (
  SELECT cut_job_id,
         row_number() OVER (
           PARTITION BY source_display_number
           ORDER BY created_at, cut_job_id
         ) AS rn
  FROM cut_job
  WHERE source_display_number IS NOT NULL
)
UPDATE cut_job job
SET source_display_number = NULL,
    updated_at = now()
FROM duplicate_numbers duplicate
WHERE job.cut_job_id = duplicate.cut_job_id
  AND duplicate.rn > 1;

WITH vacuum_jobs AS (
  SELECT j.cut_job_id
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
regular_max AS (
  SELECT COALESCE(MAX(source_display_number::integer), 0) AS value
  FROM cut_job
  WHERE source_display_number ~ '^[0-9]+$'
),
regular_missing AS (
  SELECT j.cut_job_id,
         row_number() OVER (ORDER BY j.created_at, j.cut_job_id) AS rn
  FROM cut_job j
  WHERE j.source_display_number IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM vacuum_jobs v WHERE v.cut_job_id = j.cut_job_id
    )
)
UPDATE cut_job job
SET source_display_number = (regular_max.value + regular_missing.rn)::text,
    updated_at = now()
FROM regular_missing, regular_max
WHERE job.cut_job_id = regular_missing.cut_job_id;

WITH vacuum_jobs AS (
  SELECT j.cut_job_id
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
vacuum_max AS (
  SELECT COALESCE(MAX(substring(source_display_number FROM 3)::integer), 0) AS value
  FROM cut_job
  WHERE source_display_number ~ '^В-[0-9]+$'
),
vacuum_missing AS (
  SELECT j.cut_job_id,
         row_number() OVER (ORDER BY j.created_at, j.cut_job_id) AS rn
  FROM cut_job j
  JOIN vacuum_jobs v
    ON v.cut_job_id = j.cut_job_id
  WHERE j.source_display_number IS NULL
)
UPDATE cut_job job
SET source_display_number = 'В-' || (vacuum_max.value + vacuum_missing.rn)::text,
    updated_at = now()
FROM vacuum_missing, vacuum_max
WHERE job.cut_job_id = vacuum_missing.cut_job_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cut_job_source_display_number
  ON cut_job ((NULLIF(btrim(source_display_number), '')))
  WHERE NULLIF(btrim(source_display_number), '') IS NOT NULL;

COMMENT ON COLUMN cut_job.source_display_number IS
  'Operator-facing cut job number. Regular jobs use numeric text; vacuum-table jobs use В-<number>; Telegram SVG imports keep cnc_telegram_packets.cutting_sequence_no for regular jobs.';

COMMIT;
