-- Immutable provenance for future manual-SVG Telegram sends observed by CNC.
-- Successful transport settlement is independent from MDF eligibility.
BEGIN;

DO $$
BEGIN
  IF to_regclass(format('%I.%I',current_schema(),'cnc_manual_svg_telegram_send_requests')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'cnc_manual_svg_telegram_send_request_files')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'cnc_manual_svg_upload_files')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'cnc_telegram_packets')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_cnc_observation_targets')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_source_heads')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_revision_context')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_revision_seals')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_revision_demand')) IS NULL
    OR to_regprocedure(format('%I.mdf_reject_evidence_change()',current_schema())) IS NULL
    OR to_regprocedure(format('%I.mdf_guard_cnc_observation_target()',current_schema())) IS NULL THEN
    RAISE EXCEPTION 'CNC manual-send observation migration 181 requires local send, packet, MDF observation and immutable guard tables in schema %',current_schema();
  END IF;
END;
$$;

-- Snapshot the exact task before external Telegram I/O. Only the send-request FK
-- is present: taking packet/head key-share locks while a request row is held
-- would invert the ordinary owner/source/packet/request writer order.
CREATE TABLE IF NOT EXISTS cnc_manual_svg_observation_claim_snapshots (
  send_request_id UUID NOT NULL REFERENCES cnc_manual_svg_telegram_send_requests(request_id) ON DELETE RESTRICT,
  lease_generation BIGINT NOT NULL CHECK (lease_generation > 0),
  worker_instance_id UUID NOT NULL,
  session_generation BIGINT NOT NULL CHECK (session_generation > 0),
  lease_token_hash TEXT NOT NULL CHECK (lease_token_hash ~ '^[a-f0-9]{64}$'),
  packet_id UUID NOT NULL,
  destination_chat_id TEXT NOT NULL CHECK (length(btrim(destination_chat_id)) BETWEEN 1 AND 120),
  requested_file_count INTEGER NOT NULL CHECK (requested_file_count BETWEEN 0 AND 10),
  files_qualified BOOLEAN NOT NULL,
  files_snapshot JSONB NOT NULL CHECK (jsonb_typeof(files_snapshot)='array'),
  source_eligible BOOLEAN NOT NULL,
  source_fence JSONB NOT NULL CHECK (jsonb_typeof(source_fence)='object'),
  ineligible_reason TEXT CHECK (ineligible_reason IS NULL OR ineligible_reason IN
    ('FILES_INCOMPLETE','SOURCE_UNACCEPTED','SOURCE_CONTEXT_INVALID','SOURCE_NOT_MDF')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (send_request_id,lease_generation),
  CONSTRAINT chk_cnc_manual_svg_observation_snapshot_shape CHECK (
    (files_qualified AND requested_file_count BETWEEN 1 AND 3
      AND jsonb_array_length(files_snapshot)=requested_file_count)
    OR (NOT files_qualified AND ineligible_reason='FILES_INCOMPLETE')
  )
);

CREATE TABLE IF NOT EXISTS cnc_manual_svg_observation_send_bindings (
  send_request_id UUID NOT NULL,
  lease_generation BIGINT NOT NULL CHECK (lease_generation > 0),
  sent_chat_id TEXT NOT NULL CHECK (length(btrim(sent_chat_id)) BETWEEN 1 AND 120),
  transport_message_ids JSONB NOT NULL CHECK (jsonb_typeof(transport_message_ids)='array'
    AND jsonb_array_length(transport_message_ids) BETWEEN 1 AND 10),
  sent_files JSONB CHECK (sent_files IS NULL OR (jsonb_typeof(sent_files)='array'
    AND jsonb_array_length(sent_files) BETWEEN 1 AND 3)),
  binding_error TEXT CHECK (binding_error IS NULL OR binding_error='MEDIA_VERIFICATION_FAILED'),
  completion_digest TEXT NOT NULL CHECK (completion_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (send_request_id,lease_generation),
  FOREIGN KEY (send_request_id,lease_generation)
    REFERENCES cnc_manual_svg_observation_claim_snapshots(send_request_id,lease_generation) ON DELETE RESTRICT,
  CONSTRAINT chk_cnc_manual_svg_observation_binding_choice CHECK (
    sent_files IS NULL OR binding_error IS NULL
  )
);

CREATE TABLE IF NOT EXISTS cnc_manual_svg_observation_registration_work (
  send_request_id UUID NOT NULL,
  lease_generation BIGINT NOT NULL CHECK (lease_generation > 0),
  work_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (work_state IN ('pending','registered','ineligible','needs_reconciliation')),
  reason TEXT CHECK (reason IS NULL OR reason IN
    ('FILES_INCOMPLETE','SOURCE_UNACCEPTED','SOURCE_CONTEXT_INVALID','SOURCE_NOT_MDF',
     'MEDIA_VERIFICATION_FAILED','SENT_BINDING_MISSING','SENT_BINDING_INVALID',
     'SOURCE_STALE','TARGET_ALREADY_BOUND','OWNER_SCOPE_INVALID','MEMBERSHIP_CHANGED',
     'REGISTRATION_RETRY_EXHAUSTED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (send_request_id,lease_generation),
  FOREIGN KEY (send_request_id,lease_generation)
    REFERENCES cnc_manual_svg_observation_send_bindings(send_request_id,lease_generation) ON DELETE RESTRICT,
  CONSTRAINT chk_cnc_manual_svg_observation_work_reason CHECK (
    (work_state='pending' AND reason IS NULL)
    OR (work_state='registered' AND reason IS NULL)
    OR (work_state IN ('ineligible','needs_reconciliation') AND reason IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_cnc_manual_svg_observation_registration_due
  ON cnc_manual_svg_observation_registration_work(next_attempt_at,send_request_id,lease_generation)
  WHERE work_state='pending';

CREATE OR REPLACE FUNCTION mdf_guard_cnc_manual_svg_observation_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CNC manual-send observation provenance is immutable' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER cnc_manual_svg_observation_claim_immutable BEFORE UPDATE OR DELETE
  ON cnc_manual_svg_observation_claim_snapshots FOR EACH ROW EXECUTE FUNCTION mdf_guard_cnc_manual_svg_observation_append_only();
CREATE TRIGGER cnc_manual_svg_observation_binding_immutable BEFORE UPDATE OR DELETE
  ON cnc_manual_svg_observation_send_bindings FOR EACH ROW EXECUTE FUNCTION mdf_guard_cnc_manual_svg_observation_append_only();

CREATE OR REPLACE FUNCTION mdf_guard_cnc_manual_svg_observation_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'CNC manual-send observation work is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    RETURN NEW;
  END IF;
  IF NEW.send_request_id IS DISTINCT FROM OLD.send_request_id
    OR NEW.lease_generation IS DISTINCT FROM OLD.lease_generation
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.attempt_count < OLD.attempt_count
    OR (OLD.work_state<>'pending' AND NEW IS DISTINCT FROM OLD)
    OR (OLD.work_state='pending' AND NEW.work_state NOT IN ('pending','registered','ineligible','needs_reconciliation')) THEN
    RAISE EXCEPTION 'CNC manual-send observation work transition is invalid' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cnc_manual_svg_observation_work_guard BEFORE INSERT OR UPDATE OR DELETE
  ON cnc_manual_svg_observation_registration_work FOR EACH ROW EXECUTE FUNCTION mdf_guard_cnc_manual_svg_observation_work();

ALTER TABLE mdf_cnc_observation_targets
  ADD COLUMN IF NOT EXISTS registration_kind TEXT NOT NULL DEFAULT 'import',
  ADD COLUMN IF NOT EXISTS manual_send_request_id UUID REFERENCES cnc_manual_svg_telegram_send_requests(request_id) ON DELETE RESTRICT;
ALTER TABLE mdf_cnc_observation_targets ALTER COLUMN import_item_id DROP NOT NULL;
ALTER TABLE mdf_cnc_observation_targets ALTER COLUMN candidate_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mdf_cnc_observation_manual_send
  ON mdf_cnc_observation_targets(manual_send_request_id) WHERE manual_send_request_id IS NOT NULL;
ALTER TABLE mdf_cnc_observation_targets
  ADD CONSTRAINT chk_mdf_cnc_observation_target_registration_kind CHECK (
    (registration_kind='import' AND import_item_id IS NOT NULL AND candidate_id IS NOT NULL AND manual_send_request_id IS NULL)
    OR (registration_kind='manual_send' AND import_item_id IS NULL AND candidate_id IS NULL AND manual_send_request_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION mdf_guard_cnc_observation_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'MDF CNC observation target is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.registration_kind NOT IN ('import','manual_send')
      OR (NEW.registration_kind='import' AND (NEW.import_item_id IS NULL OR NEW.candidate_id IS NULL OR NEW.manual_send_request_id IS NOT NULL))
      OR (NEW.registration_kind='manual_send' AND (NEW.import_item_id IS NOT NULL OR NEW.candidate_id IS NOT NULL OR NEW.manual_send_request_id IS NULL))
      OR jsonb_typeof(NEW.message_bindings)<>'array' THEN
      RAISE EXCEPTION 'MDF CNC observation target provenance is malformed' USING ERRCODE='23514';
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
    OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id OR NEW.registration_kind IS DISTINCT FROM OLD.registration_kind
    OR NEW.manual_send_request_id IS DISTINCT FROM OLD.manual_send_request_id
    OR NEW.source_chat_id IS DISTINCT FROM OLD.source_chat_id
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

COMMENT ON TABLE cnc_manual_svg_observation_claim_snapshots IS
  'Immutable manual-SVG Telegram send-task files and accepted MDF source fence captured before external send I/O.';
COMMENT ON TABLE cnc_manual_svg_observation_send_bindings IS
  'Immutable successful transport settlement and exact per-file Telegram message/media bindings; no claim is physical cut proof.';
COMMENT ON TABLE cnc_manual_svg_observation_registration_work IS
  'Bounded deferred registrar state; only successful manual sends with unchanged accepted source fences can create observation targets.';
COMMENT ON COLUMN mdf_cnc_observation_targets.source_group_message_id IS
  'Import source group message or, for manual_send provenance only, the exact SVG message anchor.';
COMMIT;
