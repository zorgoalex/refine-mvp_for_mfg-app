-- MDF bath readiness from credited (declared) cut, infrastructure part.
-- 1) declared_covered_quantity: pieces of a bath member closed by credited cut that is NOT a physical allocation
--    (manual move of a machine file to «Распилено»), frozen with the publication. covered_quantity stays physical.
-- 2) mdf_republish_jobs: immutable marker (own trigger function; no dependency on 179) of an internal re-publication job. Such a job keeps the sealed effect
--    policy of its revision and only projects/publishes: no rule effects, no CNC authority effects.
--    No FK to mdf_recalculation_jobs (same lock order as mdf_correction_job_effect_suppressions, migration 179).
BEGIN;

DO $$
BEGIN
  IF to_regclass(format('%I.%I',current_schema(),'mdf_published_source_members')) IS NULL THEN
    RAISE EXCEPTION 'MDF migration 277 requires migrations 174 and 273 in schema %',current_schema();
  END IF;
END;
$$;

ALTER TABLE mdf_published_source_members ADD COLUMN IF NOT EXISTS declared_covered_quantity BIGINT NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mdf_published_member_declared_coverage_check'
    AND conrelid=to_regclass(format('%I.%I',current_schema(),'mdf_published_source_members'))) THEN
    ALTER TABLE mdf_published_source_members ADD CONSTRAINT mdf_published_member_declared_coverage_check
      CHECK (declared_covered_quantity>=0 AND (declared_covered_quantity=0
        OR (source_kind='bath' AND declared_covered_quantity+COALESCE(covered_quantity,0)<=quantity)));
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS mdf_republish_jobs (
  job_id UUID PRIMARY KEY,
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 128),
  command_key TEXT NOT NULL CHECK (length(command_key) BETWEEN 1 AND 128),
  actor_user_id BIGINT NOT NULL CHECK (actor_user_id > 0),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mdf_republish_jobs_run ON mdf_republish_jobs(run_id,job_id);
CREATE OR REPLACE FUNCTION mdf_reject_republish_job_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MDF republish job markers are immutable' USING ERRCODE='55000';
END;
$$;
DROP TRIGGER IF EXISTS mdf_republish_job_immutable ON mdf_republish_jobs;
CREATE TRIGGER mdf_republish_job_immutable
  BEFORE UPDATE OR DELETE ON mdf_republish_jobs
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_republish_job_change();
COMMENT ON TABLE mdf_republish_jobs IS
  'Immutable marker: internal MDF re-publication job (sealed effect policy kept; projection/publication only, no effects).';

COMMIT;
