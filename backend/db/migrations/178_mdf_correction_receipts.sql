-- Bind correction publication policy to its immutable sealed execution context.
-- This migration is intentionally additive; existing receipts/jobs remain forward.
BEGIN;

DO $$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'mdf_revision_context')) IS NULL
    OR to_regclass(format('%I.%I', current_schema(), 'mdf_revision_seals')) IS NULL
    OR to_regclass(format('%I.%I', current_schema(), 'mdf_recalculation_jobs')) IS NULL THEN
    RAISE EXCEPTION 'MDF migration 178 requires local context, seal, and job tables in schema %', current_schema();
  END IF;
END;
$$;

ALTER TABLE mdf_revision_context
  ADD COLUMN IF NOT EXISTS effect_policy TEXT NOT NULL DEFAULT 'forward'
  CHECK (effect_policy IN ('forward','publish_only'));

ALTER TABLE mdf_recalculation_jobs
  ADD COLUMN IF NOT EXISTS effect_policy TEXT NOT NULL DEFAULT 'forward'
  CHECK (effect_policy IN ('forward','publish_only'));

CREATE OR REPLACE FUNCTION mdf_guard_job_effect_policy_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sealed_policy TEXT;
BEGIN
  IF TG_OP='UPDATE' AND NEW.effect_policy IS DISTINCT FROM OLD.effect_policy THEN
    RAISE EXCEPTION 'MDF job effect policy is immutable' USING ERRCODE='55000';
  END IF;

  SELECT c.effect_policy INTO sealed_policy
  FROM mdf_revision_context c
  JOIN mdf_revision_seals s USING(source_kind,source_id,revision_key)
  WHERE c.source_kind=NEW.source_kind AND c.source_id=NEW.source_id AND c.revision_key=NEW.revision_key;

  IF FOUND THEN
    IF NEW.effect_policy IS DISTINCT FROM sealed_policy THEN
      RAISE EXCEPTION 'MDF job effect policy does not match sealed context' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.effect_policy <> 'forward' THEN
    RAISE EXCEPTION 'MDF publish-only job requires sealed execution context' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mdf_job_effect_policy_binding ON mdf_recalculation_jobs;
CREATE TRIGGER mdf_job_effect_policy_binding
  BEFORE INSERT OR UPDATE ON mdf_recalculation_jobs
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_job_effect_policy_binding();

COMMENT ON COLUMN mdf_revision_context.effect_policy IS
  'Immutable durable effects authorization sealed with this receipt; legacy contexts default to forward.';
COMMENT ON COLUMN mdf_recalculation_jobs.effect_policy IS
  'Immutable copy of sealed context effects authorization; old jobs default to forward.';

COMMIT;
