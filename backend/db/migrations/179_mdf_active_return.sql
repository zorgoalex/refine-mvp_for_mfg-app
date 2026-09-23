-- Durable active correction command results, prior-job effect fences, and CNC
-- correction-time freshness baselines. No producer/worker is activated here.
BEGIN;

DO $$
BEGIN
  IF to_regclass(format('%I.%I',current_schema(),'mdf_source_heads')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_recalculation_jobs')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'cnc_telegram_packets')) IS NULL
    OR to_regprocedure(format('%I.mdf_reject_evidence_change()',current_schema())) IS NULL THEN
    RAISE EXCEPTION 'MDF migration 179 requires local source heads, jobs, CNC packets, and immutable evidence guard in schema %', current_schema();
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS mdf_correction_command_results (
  actor_user_id BIGINT NOT NULL CHECK (actor_user_id > 0),
  command_key TEXT NOT NULL CHECK (length(command_key) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('packet','bazisCutSet','bath')),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 240),
  order_ids BIGINT[] NOT NULL CHECK (cardinality(order_ids) BETWEEN 1 AND 100),
  response JSONB NOT NULL CHECK (jsonb_typeof(response)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id,command_key)
);

DROP TRIGGER IF EXISTS mdf_correction_command_result_immutable ON mdf_correction_command_results;
CREATE TRIGGER mdf_correction_command_result_immutable
  BEFORE UPDATE OR DELETE ON mdf_correction_command_results
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();

-- Intentionally no FK to mdf_recalculation_jobs: the worker locks a job before
-- it locks owners. The correction may be holding owner locks while recording a
-- fence for that worker's pending job, so an FK key-share lock could invert.
CREATE TABLE IF NOT EXISTS mdf_correction_job_effect_suppressions (
  job_id UUID NOT NULL,
  affected_order_id BIGINT NOT NULL CHECK (affected_order_id > 0),
  correction_source_kind TEXT NOT NULL CHECK (correction_source_kind IN ('packet','bazisCutSet','bath')),
  correction_source_id TEXT NOT NULL CHECK (length(correction_source_id) BETWEEN 1 AND 240),
  correction_epoch BIGINT NOT NULL CHECK (correction_epoch > 0),
  command_key TEXT NOT NULL CHECK (length(command_key) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id,affected_order_id)
);
CREATE INDEX IF NOT EXISTS idx_mdf_correction_job_effect_suppressions_order
  ON mdf_correction_job_effect_suppressions(affected_order_id,job_id);

DROP TRIGGER IF EXISTS mdf_correction_job_effect_suppression_immutable ON mdf_correction_job_effect_suppressions;
CREATE TRIGGER mdf_correction_job_effect_suppression_immutable
  BEFORE UPDATE OR DELETE ON mdf_correction_job_effect_suppressions
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();

CREATE TABLE IF NOT EXISTS mdf_cnc_return_fences (
  packet_id UUID PRIMARY KEY REFERENCES cnc_telegram_packets(packet_id) ON DELETE RESTRICT,
  correction_epoch BIGINT NOT NULL CHECK (correction_epoch > 0),
  baseline_source_version BIGINT NOT NULL CHECK (baseline_source_version > 0),
  pending_source_version BIGINT,
  completion_source_version BIGINT,
  state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mdf_cnc_return_fences_state_check CHECK (
    (state='waiting_pending' AND pending_source_version IS NULL AND completion_source_version IS NULL)
    OR (state='waiting_completion' AND pending_source_version IS NOT NULL
      AND pending_source_version > baseline_source_version AND completion_source_version IS NULL)
    OR (state='satisfied' AND pending_source_version IS NOT NULL AND completion_source_version IS NOT NULL
      AND pending_source_version > baseline_source_version AND completion_source_version > pending_source_version)
  )
);

CREATE OR REPLACE FUNCTION mdf_guard_cnc_return_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'MDF CNC return freshness history is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state <> 'waiting_pending' OR NEW.pending_source_version IS NOT NULL
      OR NEW.completion_source_version IS NOT NULL THEN
      RAISE EXCEPTION 'MDF CNC return fence must start waiting for a fresh pending signal' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.packet_id IS DISTINCT FROM OLD.packet_id THEN
    RAISE EXCEPTION 'MDF CNC return fence identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.correction_epoch > OLD.correction_epoch THEN
    IF NEW.baseline_source_version < GREATEST(OLD.baseline_source_version,OLD.pending_source_version,OLD.completion_source_version)
      OR NEW.state <> 'waiting_pending'
      OR NEW.pending_source_version IS NOT NULL OR NEW.completion_source_version IS NOT NULL THEN
      RAISE EXCEPTION 'MDF CNC return fence reset is invalid' USING ERRCODE='23514';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'MDF CNC return fence creation time is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.correction_epoch <> OLD.correction_epoch
    OR NEW.baseline_source_version IS DISTINCT FROM OLD.baseline_source_version THEN
    RAISE EXCEPTION 'MDF CNC return fence baseline is immutable within an epoch' USING ERRCODE='55000';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'MDF CNC return fence creation time is immutable' USING ERRCODE='55000';
  END IF;

  IF OLD.state='waiting_pending' AND NEW.state='waiting_completion'
    AND NEW.pending_source_version > OLD.baseline_source_version
    AND NEW.completion_source_version IS NULL THEN
    RETURN NEW;
  ELSIF OLD.state='waiting_completion' AND NEW.state='satisfied'
    AND NEW.pending_source_version=OLD.pending_source_version
    AND NEW.completion_source_version > OLD.pending_source_version THEN
    RETURN NEW;
  ELSIF OLD.state=NEW.state AND NEW.pending_source_version IS NOT DISTINCT FROM OLD.pending_source_version
    AND NEW.completion_source_version IS NOT DISTINCT FROM OLD.completion_source_version THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'MDF CNC return fence transition is invalid' USING ERRCODE='23514';
END;
$$;

DROP TRIGGER IF EXISTS mdf_cnc_return_fence_guard ON mdf_cnc_return_fences;
CREATE TRIGGER mdf_cnc_return_fence_guard
  BEFORE INSERT OR UPDATE OR DELETE ON mdf_cnc_return_fences
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_cnc_return_fence();

COMMENT ON TABLE mdf_correction_command_results IS
  'Immutable actor/key replay response for accepted MDF correction commands; every replay reauthorizes stored owners.';
COMMENT ON TABLE mdf_correction_job_effect_suppressions IS
  'Immutable per-job/per-order fence preventing pre-correction forward automation from undoing confirmed corrections.';
COMMENT ON TABLE mdf_cnc_return_fences IS
  'Correction-time CNC source_version baseline. Ingress consumption remains disconnected until its separate cutover gate.';

COMMIT;
