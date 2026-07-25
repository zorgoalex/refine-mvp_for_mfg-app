BEGIN;

ALTER TABLE deadline_default_stage_durations
  ADD COLUMN IF NOT EXISTS parallel_with_previous BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE deadline_default_stage_durations
  DROP CONSTRAINT IF EXISTS chk_deadline_default_stage_first_not_parallel;

ALTER TABLE deadline_default_stage_durations
  ADD CONSTRAINT chk_deadline_default_stage_first_not_parallel
  CHECK (position > 1 OR parallel_with_previous = false);

COMMIT;
