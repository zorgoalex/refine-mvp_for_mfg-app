-- Bounded, explicit-import CNC observations. This stores exact Telegram work
-- identities and server observation sequence without changing raw packet
-- content versions (label/evidence projections are keyed by that version).
BEGIN;

DO $$
BEGIN
  IF to_regclass(format('%I.%I',current_schema(),'cnc_telegram_packets')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'cnc_telegram_import_candidates')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'cnc_telegram_import_items')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_source_heads')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_recalculation_jobs')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_cnc_return_fences')) IS NULL
    OR to_regprocedure(format('%I.mdf_reject_evidence_change()',current_schema())) IS NULL THEN
    RAISE EXCEPTION 'MDF migration 180 requires local CNC import, MDF receipt, return-fence, and immutable guard tables in schema %',current_schema();
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS mdf_cnc_observation_targets (
  packet_id UUID PRIMARY KEY REFERENCES cnc_telegram_packets(packet_id) ON DELETE RESTRICT,
  import_item_id UUID NOT NULL UNIQUE REFERENCES cnc_telegram_import_items(import_item_id) ON DELETE RESTRICT,
  candidate_id UUID NOT NULL REFERENCES cnc_telegram_import_candidates(candidate_id) ON DELETE RESTRICT,
  source_chat_id TEXT NOT NULL CHECK (length(btrim(source_chat_id)) BETWEEN 1 AND 200),
  source_group_message_id BIGINT NOT NULL CHECK (source_group_message_id BETWEEN 1 AND 2147483647),
  message_bindings JSONB NOT NULL CHECK (CASE WHEN jsonb_typeof(message_bindings)='array'
    THEN jsonb_array_length(message_bindings) BETWEEN 1 AND 3 ELSE false END),
  registered_revision_key TEXT NOT NULL CHECK (length(btrim(registered_revision_key)) BETWEEN 1 AND 240),
  registered_membership_digest TEXT NOT NULL CHECK (registered_membership_digest ~ '^[a-f0-9]{64}$'),
  accepted_revision_key TEXT NOT NULL CHECK (length(btrim(accepted_revision_key)) BETWEEN 1 AND 240),
  last_observation_version BIGINT NOT NULL CHECK (last_observation_version > 0),
  work_state TEXT NOT NULL DEFAULT 'active' CHECK (work_state IN ('active','completed','needs_reconciliation')),
  next_due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_id UUID,
  claim_token_hash TEXT CHECK (claim_token_hash IS NULL OR claim_token_hash ~ '^[a-f0-9]{64}$'),
  claim_generation BIGINT NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  claim_worker_instance_id UUID,
  claim_session_generation BIGINT,
  claim_expires_at TIMESTAMPTZ,
  claim_head_version BIGINT,
  claim_correction_epoch BIGINT,
  claim_raw_source_version BIGINT,
  claim_observation_version BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_mdf_cnc_observation_target_claim CHECK (
    (claim_id IS NULL AND claim_token_hash IS NULL AND claim_worker_instance_id IS NULL
      AND claim_session_generation IS NULL AND claim_expires_at IS NULL AND claim_head_version IS NULL
      AND claim_correction_epoch IS NULL AND claim_raw_source_version IS NULL AND claim_observation_version IS NULL)
    OR (claim_id IS NOT NULL AND claim_token_hash IS NOT NULL AND claim_generation > 0
      AND claim_worker_instance_id IS NOT NULL AND claim_session_generation IS NOT NULL AND claim_session_generation > 0
      AND claim_expires_at IS NOT NULL AND claim_head_version IS NOT NULL AND claim_head_version > 0
      AND claim_correction_epoch IS NOT NULL AND claim_correction_epoch >= 0
      AND claim_raw_source_version IS NOT NULL AND claim_raw_source_version > 0
      AND claim_observation_version IS NOT NULL AND claim_observation_version > 0)
  )
);
CREATE INDEX IF NOT EXISTS idx_mdf_cnc_observation_due
  ON mdf_cnc_observation_targets(source_chat_id,next_due_at,packet_id) WHERE work_state='active';

CREATE TABLE IF NOT EXISTS mdf_cnc_observation_receipts (
  claim_id UUID PRIMARY KEY,
  packet_id UUID NOT NULL REFERENCES mdf_cnc_observation_targets(packet_id) ON DELETE RESTRICT,
  claim_generation BIGINT NOT NULL CHECK (claim_generation > 0),
  claim_token_hash TEXT NOT NULL CHECK (claim_token_hash ~ '^[a-f0-9]{64}$'),
  worker_instance_id UUID NOT NULL,
  session_generation BIGINT NOT NULL CHECK (session_generation > 0),
  head_version BIGINT NOT NULL CHECK (head_version > 0),
  correction_epoch BIGINT NOT NULL CHECK (correction_epoch >= 0),
  raw_source_version BIGINT NOT NULL CHECK (raw_source_version > 0),
  observation_version BIGINT NOT NULL CHECK (observation_version > 0),
  report_state TEXT NOT NULL CHECK (report_state IN ('pending','completed','failed')),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN
    ('FETCH_FAILED','MESSAGE_MISSING','MESSAGE_MEDIA_MISMATCH','MESSAGE_GROUP_INCOMPLETE')),
  report_digest TEXT NOT NULL CHECK (report_digest ~ '^[a-f0-9]{64}$'),
  report JSONB NOT NULL CHECK (jsonb_typeof(report)='array'),
  result JSONB NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_mdf_cnc_observation_receipt_failure CHECK
    ((report_state='failed' AND failure_code IS NOT NULL) OR (report_state<>'failed' AND failure_code IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_mdf_cnc_observation_receipt_sequence
  ON mdf_cnc_observation_receipts(packet_id,observation_version,created_at);

-- No FK to recalculation_jobs: the accepted worker locks jobs before owners.
-- This marker is committed with an observation job and makes the general job
-- runner quarantine CNC-origin physical work before any effects.
CREATE TABLE IF NOT EXISTS mdf_cnc_observation_job_authorities (
  job_id UUID PRIMARY KEY,
  packet_id UUID NOT NULL REFERENCES mdf_cnc_observation_targets(packet_id) ON DELETE RESTRICT,
  claim_id UUID NOT NULL UNIQUE REFERENCES mdf_cnc_observation_receipts(claim_id) ON DELETE RESTRICT,
  authority TEXT NOT NULL CHECK (authority='cnc_autocut'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION mdf_guard_cnc_observation_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'MDF CNC observation target is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF jsonb_typeof(NEW.message_bindings)<>'array' THEN
      RAISE EXCEPTION 'MDF CNC observation group must be an array' USING ERRCODE='23514';
    END IF;
    IF jsonb_array_length(NEW.message_bindings)<1 OR jsonb_array_length(NEW.message_bindings)>3 THEN
      RAISE EXCEPTION 'MDF CNC observation group must be bounded' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.message_bindings) AS item(value)
      WHERE jsonb_typeof(item.value)<>'object' OR NOT (item.value ? 'messageId')
        OR NOT (item.value ? 'role') OR NOT (item.value ? 'sha256')
        OR jsonb_typeof(item.value->'messageId')<>'string'
        OR jsonb_typeof(item.value->'role')<>'string'
        OR jsonb_typeof(item.value->'sha256')<>'string'
        OR CASE WHEN item.value->>'messageId' ~ '^[1-9][0-9]*$'
          THEN length(item.value->>'messageId')>10 OR (item.value->>'messageId')::numeric>2147483647
          ELSE true END
        OR item.value->>'role' NOT IN ('svg','gcode','image')
        OR lower(item.value->>'sha256') !~ '^[a-f0-9]{64}$')
      OR (SELECT count(DISTINCT item.value->>'messageId') FROM jsonb_array_elements(NEW.message_bindings) AS item(value))
        <> jsonb_array_length(NEW.message_bindings)
      OR (SELECT count(DISTINCT item.value->>'role') FROM jsonb_array_elements(NEW.message_bindings) AS item(value))
        <> jsonb_array_length(NEW.message_bindings)
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.message_bindings) AS item(value)
        WHERE jsonb_typeof(item.value->'role')='string' AND item.value->>'role'='svg') THEN
      RAISE EXCEPTION 'MDF CNC observation group binding is malformed' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.packet_id IS DISTINCT FROM OLD.packet_id OR NEW.import_item_id IS DISTINCT FROM OLD.import_item_id
    OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id OR NEW.source_chat_id IS DISTINCT FROM OLD.source_chat_id
    OR NEW.source_group_message_id IS DISTINCT FROM OLD.source_group_message_id
    OR NEW.message_bindings IS DISTINCT FROM OLD.message_bindings
    OR NEW.registered_revision_key IS DISTINCT FROM OLD.registered_revision_key
    OR NEW.registered_membership_digest IS DISTINCT FROM OLD.registered_membership_digest
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'MDF CNC observation binding is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.last_observation_version < OLD.last_observation_version THEN
    RAISE EXCEPTION 'MDF CNC observation sequence cannot decrease' USING ERRCODE='23514';
  END IF;
  IF NEW.claim_generation < OLD.claim_generation THEN
    RAISE EXCEPTION 'MDF CNC observation claim generation cannot decrease' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mdf_cnc_observation_target_guard ON mdf_cnc_observation_targets;
CREATE TRIGGER mdf_cnc_observation_target_guard BEFORE INSERT OR UPDATE OR DELETE
  ON mdf_cnc_observation_targets FOR EACH ROW EXECUTE FUNCTION mdf_guard_cnc_observation_target();

DROP TRIGGER IF EXISTS mdf_cnc_observation_receipt_immutable ON mdf_cnc_observation_receipts;
CREATE TRIGGER mdf_cnc_observation_receipt_immutable BEFORE UPDATE OR DELETE
  ON mdf_cnc_observation_receipts FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();
DROP TRIGGER IF EXISTS mdf_cnc_observation_job_authority_immutable ON mdf_cnc_observation_job_authorities;
CREATE TRIGGER mdf_cnc_observation_job_authority_immutable BEFORE UPDATE OR DELETE
  ON mdf_cnc_observation_job_authorities FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();

COMMENT ON TABLE mdf_cnc_observation_targets IS
  'Bounded exact-message observer work registered only from accepted explicit Telegram imports; polling remains opt-in.';
COMMENT ON TABLE mdf_cnc_observation_receipts IS
  'Immutable server-versioned observation reports; raw packet content versions are unchanged.';
COMMENT ON TABLE mdf_cnc_observation_job_authorities IS
  'Durable CNC AutoCut authority marker; general MDF job processing quarantines these jobs until its dedicated executor exists.';

COMMIT;
