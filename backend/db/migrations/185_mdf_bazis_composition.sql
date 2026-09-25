-- Persist bounded BASIS assignment intent separately from physical proof.
-- This does not enable public routes, producers, schedulers, or engine mode.
BEGIN;

DO $$
BEGIN
  IF to_regclass(format('%I.%I',current_schema(),'mdf_evidence_revisions')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_revision_context')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_revision_demand')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_revision_seals')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_evidence_lines')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_source_heads')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_physical_lineage_contracts')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_physical_lineage_transitions')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_recalculation_jobs')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_bath_allocations')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'bazis_cut_sets')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'bazis_cut_set_details')) IS NULL THEN
    RAISE EXCEPTION 'MDF migration 185 requires local MDF receipt, lineage, job, allocation, and BASIS tables in schema %',current_schema();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname=current_schema() AND r.relname='mdf_source_heads'
      AND t.tgname='mdf_physical_lineage_source_head_guard' AND t.tgenabled='O' AND NOT t.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname=current_schema() AND r.relname='mdf_revision_seals'
      AND t.tgname='mdf_physical_lineage_seal_guard' AND t.tgenabled='O' AND NOT t.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname=current_schema() AND r.relname='mdf_revision_context'
      AND t.tgname='mdf_context_immutable' AND t.tgenabled='O' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'MDF migration 185 requires enabled immutable receipt and lineage guards';
  END IF;
END;
$$;

-- One immutable record per sealed BASIS revision. assignment_state_id remains
-- stable across receipts whose exact eligible membership is unchanged.
CREATE TABLE IF NOT EXISTS mdf_bazis_assignment_states (
  source_kind TEXT NOT NULL DEFAULT 'bazisCutSet' CHECK (source_kind='bazisCutSet'),
  source_id TEXT NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 240),
  revision_key TEXT NOT NULL CHECK (length(btrim(revision_key)) BETWEEN 1 AND 240),
  assignment_state_id UUID NOT NULL,
  root_intent_id UUID NOT NULL,
  predecessor_revision_key TEXT,
  predecessor_state_id UUID,
  membership_digest TEXT NOT NULL CHECK (membership_digest ~ '^[a-f0-9]{64}$'),
  intentional_empty BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_kind,source_id,revision_key),
  UNIQUE(source_kind,source_id,revision_key,assignment_state_id),
  FOREIGN KEY(source_kind,source_id,revision_key)
    REFERENCES mdf_revision_seals(source_kind,source_id,revision_key) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(source_kind,source_id,predecessor_revision_key)
    REFERENCES mdf_revision_seals(source_kind,source_id,revision_key) ON DELETE RESTRICT,
  CHECK ((predecessor_revision_key IS NULL)=(predecessor_state_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_mdf_bazis_assignment_state_id
  ON mdf_bazis_assignment_states(source_kind,source_id,assignment_state_id,revision_key);

-- A command-time snapshot, consumed only by the exact queued job/revision.
-- Command-only pin digests are deliberately not inherited by later receipts.
CREATE TABLE IF NOT EXISTS mdf_bazis_composition_intents (
  intent_id UUID PRIMARY KEY,
  job_id UUID NOT NULL UNIQUE REFERENCES mdf_recalculation_jobs(job_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  source_kind TEXT NOT NULL DEFAULT 'bazisCutSet' CHECK (source_kind='bazisCutSet'),
  source_id TEXT NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 240),
  revision_key TEXT NOT NULL CHECK (length(btrim(revision_key)) BETWEEN 1 AND 240),
  predecessor_revision_key TEXT NOT NULL CHECK (length(btrim(predecessor_revision_key)) BETWEEN 1 AND 240),
  assignment_state_id UUID NOT NULL,
  set_id BIGINT NOT NULL CHECK (set_id>0),
  set_version BIGINT NOT NULL CHECK (set_version>0),
  raw_snapshot_digest TEXT NOT NULL CHECK (raw_snapshot_digest ~ '^[a-f0-9]{64}$'),
  membership_digest TEXT NOT NULL CHECK (membership_digest ~ '^[a-f0-9]{64}$'),
  intentional_empty BOOLEAN NOT NULL,
  owner_ids BIGINT[] NOT NULL,
  allocation_snapshot_digest TEXT NOT NULL CHECK (allocation_snapshot_digest ~ '^[a-f0-9]{64}$'),
  preview_digest TEXT NOT NULL CHECK (preview_digest ~ '^[a-f0-9]{64}$'),
  actor_user_id BIGINT NOT NULL CHECK (actor_user_id>0),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 2000),
  command_key TEXT NOT NULL CHECK (length(btrim(command_key)) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_kind,source_id,revision_key),
  UNIQUE(actor_user_id,command_key),
  FOREIGN KEY(source_kind,source_id,revision_key,assignment_state_id)
    REFERENCES mdf_bazis_assignment_states(source_kind,source_id,revision_key,assignment_state_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(source_kind,source_id,predecessor_revision_key)
    REFERENCES mdf_revision_seals(source_kind,source_id,revision_key) ON DELETE RESTRICT,
  CHECK (set_id::text=source_id),
  CHECK (cardinality(owner_ids) BETWEEN 1 AND 100),
  CHECK (array_position(owner_ids,NULL) IS NULL)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=current_schema()
      AND r.relname='mdf_bazis_assignment_states' AND c.conname='fk_mdf_bazis_assignment_root_intent') THEN
    ALTER TABLE mdf_bazis_assignment_states ADD CONSTRAINT fk_mdf_bazis_assignment_root_intent
      FOREIGN KEY(root_intent_id) REFERENCES mdf_bazis_composition_intents(intent_id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_mdf_bazis_composition_intent_job
  ON mdf_bazis_composition_intents(source_kind,source_id,revision_key,created_at);

CREATE OR REPLACE FUNCTION mdf_guard_bazis_assignment_state_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member_count BIGINT;
BEGIN
  PERFORM 1 FROM mdf_evidence_revisions WHERE source_kind=NEW.source_kind
    AND source_id=NEW.source_id AND revision_key=NEW.revision_key FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM mdf_revision_seals WHERE source_kind=NEW.source_kind
    AND source_id=NEW.source_id AND revision_key=NEW.revision_key) THEN
    RAISE EXCEPTION 'MDF BASIS assignment state must be attached before its seal' USING ERRCODE='55000';
  END IF;
  SELECT count(*) INTO member_count FROM mdf_evidence_lines
    WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id AND revision_key=NEW.revision_key
      AND stage_code='membership' AND evidence_kind='derived';
  IF NEW.intentional_empty IS DISTINCT FROM (member_count=0) THEN
    RAISE EXCEPTION 'MDF BASIS intentional-empty marker differs from sealed membership' USING ERRCODE='23514';
  END IF;
  IF NEW.predecessor_revision_key IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM mdf_revision_context c WHERE c.source_kind=NEW.source_kind AND c.source_id=NEW.source_id
      AND c.revision_key=NEW.revision_key
      AND c.predecessor_accepted_revision_key=NEW.predecessor_revision_key
      AND c.predecessor_received_revision_key=NEW.predecessor_revision_key
  ) THEN
    RAISE EXCEPTION 'MDF BASIS assignment predecessor differs from frozen context' USING ERRCODE='23514';
  END IF;
  IF NEW.predecessor_revision_key IS NULL AND NOT EXISTS (SELECT 1 FROM mdf_bazis_composition_intents i
    WHERE i.intent_id=NEW.root_intent_id AND i.source_kind=NEW.source_kind
      AND i.source_id=NEW.source_id AND i.revision_key=NEW.revision_key
      AND i.assignment_state_id=NEW.assignment_state_id
      AND i.membership_digest=NEW.membership_digest
      AND i.intentional_empty=NEW.intentional_empty) AND NEW.predecessor_revision_key IS NULL THEN
    RAISE EXCEPTION 'MDF BASIS root assignment state requires its exact composition intent' USING ERRCODE='23514';
  END IF;
  IF NEW.predecessor_revision_key IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM mdf_bazis_assignment_states p WHERE p.source_kind=NEW.source_kind
      AND p.source_id=NEW.source_id AND p.revision_key=NEW.predecessor_revision_key
      AND p.assignment_state_id=NEW.predecessor_state_id
      AND p.assignment_state_id=NEW.assignment_state_id
      AND p.root_intent_id=NEW.root_intent_id
      AND p.membership_digest=NEW.membership_digest
      AND p.intentional_empty=NEW.intentional_empty
  ) THEN
    RAISE EXCEPTION 'MDF BASIS assignment predecessor state differs' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mdf_guard_bazis_composition_intent_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_head RECORD;
  context_row RECORD;
BEGIN
  PERFORM 1 FROM mdf_evidence_revisions WHERE source_kind=NEW.source_kind
    AND source_id=NEW.source_id AND revision_key=NEW.revision_key FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM mdf_revision_seals WHERE source_kind=NEW.source_kind
    AND source_id=NEW.source_id AND revision_key=NEW.revision_key) THEN
    RAISE EXCEPTION 'MDF BASIS composition intent must be attached before its seal' USING ERRCODE='55000';
  END IF;
  -- The exact queued job is inserted later in the same transaction. A deferred
  -- FK plus deferred validation binds it without reversing job/owner lock order.
  SELECT * INTO context_row FROM mdf_revision_context WHERE source_kind=NEW.source_kind
    AND source_id=NEW.source_id AND revision_key=NEW.revision_key;
  IF NOT FOUND OR NOT context_row.acceptance_requested OR NOT context_row.composition_complete
    OR context_row.effect_policy<>'forward'
    OR context_row.predecessor_accepted_revision_key IS DISTINCT FROM NEW.predecessor_revision_key
    OR context_row.predecessor_received_revision_key IS DISTINCT FROM NEW.predecessor_revision_key THEN
    RAISE EXCEPTION 'MDF BASIS composition intent differs from frozen receipt context' USING ERRCODE='23514';
  END IF;
  SELECT * INTO current_head FROM mdf_source_heads WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id;
  IF NOT FOUND OR current_head.received_revision_key IS DISTINCT FROM NEW.predecessor_revision_key
    OR current_head.accepted_revision_key IS DISTINCT FROM NEW.predecessor_revision_key THEN
    RAISE EXCEPTION 'MDF BASIS composition predecessor must be the stable accepted head' USING ERRCODE='23514';
  END IF;
  IF NEW.intentional_empty IS DISTINCT FROM (NOT EXISTS (
    SELECT 1 FROM mdf_evidence_lines e WHERE e.source_kind=NEW.source_kind AND e.source_id=NEW.source_id
      AND e.revision_key=NEW.revision_key AND e.stage_code='membership' AND e.evidence_kind='derived'
  )) THEN
    RAISE EXCEPTION 'MDF BASIS intent empty state differs from frozen membership' USING ERRCODE='23514';
  END IF;
  IF array_position(NEW.owner_ids,NULL) IS NOT NULL OR EXISTS (
    SELECT 1 FROM unnest(NEW.owner_ids) WITH ORDINALITY u(owner_id,ord)
    WHERE owner_id<=0 OR (ord>1 AND owner_id<=NEW.owner_ids[ord-1])
  ) THEN
    RAISE EXCEPTION 'MDF BASIS composition owner scope must be positive, sorted and unique' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mdf_guard_bazis_assignment_state_seal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  member_count BIGINT;
  assignment_state mdf_bazis_assignment_states%ROWTYPE;
BEGIN
  SELECT count(*) INTO member_count FROM mdf_evidence_lines e WHERE e.source_kind=NEW.source_kind
    AND e.source_id=NEW.source_id AND e.revision_key=NEW.revision_key
    AND e.stage_code='membership' AND e.evidence_kind='derived';
  IF (EXISTS (SELECT 1 FROM mdf_bazis_composition_intents i WHERE i.source_kind=NEW.source_kind
        AND i.source_id=NEW.source_id AND i.revision_key=NEW.revision_key)
      OR EXISTS (SELECT 1 FROM mdf_bazis_assignment_states p WHERE p.source_kind=NEW.source_kind
        AND p.source_id=NEW.source_id AND p.revision_key=(SELECT c.predecessor_accepted_revision_key
          FROM mdf_revision_context c WHERE c.source_kind=NEW.source_kind AND c.source_id=NEW.source_id
            AND c.revision_key=NEW.revision_key)))
    AND NOT EXISTS (SELECT 1 FROM mdf_bazis_assignment_states s WHERE s.source_kind=NEW.source_kind
      AND s.source_id=NEW.source_id AND s.revision_key=NEW.revision_key) THEN
    RAISE EXCEPTION 'MDF BASIS assignment marker missing before seal' USING ERRCODE='23514';
  END IF;
  SELECT * INTO assignment_state FROM mdf_bazis_assignment_states s WHERE s.source_kind=NEW.source_kind
    AND s.source_id=NEW.source_id AND s.revision_key=NEW.revision_key;
  IF FOUND AND assignment_state.intentional_empty IS DISTINCT FROM (member_count=0) THEN
    RAISE EXCEPTION 'MDF BASIS sealed membership differs from assignment marker' USING ERRCODE='23514';
  END IF;
  IF FOUND AND EXISTS (SELECT 1 FROM mdf_bazis_composition_intents i WHERE i.source_kind=NEW.source_kind
      AND i.source_id=NEW.source_id AND i.revision_key=NEW.revision_key
      AND (i.intent_id<>assignment_state.root_intent_id OR i.assignment_state_id<>assignment_state.assignment_state_id
        OR i.membership_digest<>assignment_state.membership_digest
        OR i.intentional_empty<>assignment_state.intentional_empty)) THEN
    RAISE EXCEPTION 'MDF BASIS sealed assignment state differs from composition intent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mdf_validate_bazis_composition_intent_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_row mdf_recalculation_jobs%ROWTYPE;
  head_row mdf_source_heads%ROWTYPE;
  state_row mdf_bazis_assignment_states%ROWTYPE;
BEGIN
  SELECT * INTO job_row FROM mdf_recalculation_jobs WHERE job_id=NEW.job_id;
  IF NOT FOUND OR job_row.source_kind IS DISTINCT FROM NEW.source_kind OR job_row.source_id IS DISTINCT FROM NEW.source_id
    OR job_row.revision_key IS DISTINCT FROM NEW.revision_key OR job_row.status<>'pending'
    OR job_row.effect_policy<>'forward' OR job_row.actor_user_id IS DISTINCT FROM NEW.actor_user_id
    OR job_row.request_id IS DISTINCT FROM NEW.request_id THEN
    RAISE EXCEPTION 'MDF BASIS composition intent must bind its pending forward job' USING ERRCODE='23514';
  END IF;
  SELECT * INTO head_row FROM mdf_source_heads WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id;
  IF NOT FOUND OR head_row.received_revision_key IS DISTINCT FROM NEW.revision_key
    OR head_row.accepted_revision_key IS DISTINCT FROM NEW.predecessor_revision_key THEN
    RAISE EXCEPTION 'MDF BASIS composition intent is not the current pending predecessor transition' USING ERRCODE='23514';
  END IF;
  SELECT * INTO state_row FROM mdf_bazis_assignment_states WHERE source_kind=NEW.source_kind
    AND source_id=NEW.source_id AND revision_key=NEW.revision_key;
  IF NOT FOUND OR state_row.assignment_state_id IS DISTINCT FROM NEW.assignment_state_id
    OR state_row.root_intent_id IS DISTINCT FROM NEW.intent_id
    OR state_row.membership_digest IS DISTINCT FROM NEW.membership_digest
    OR state_row.intentional_empty IS DISTINCT FROM NEW.intentional_empty THEN
    RAISE EXCEPTION 'MDF BASIS composition intent differs from sealed assignment state' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mdf_reject_bazis_composition_marker_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MDF BASIS composition markers are immutable' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS mdf_bazis_assignment_state_insert_guard ON mdf_bazis_assignment_states;
CREATE TRIGGER mdf_bazis_assignment_state_insert_guard BEFORE INSERT ON mdf_bazis_assignment_states
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_bazis_assignment_state_insert();
DROP TRIGGER IF EXISTS mdf_bazis_assignment_state_immutable ON mdf_bazis_assignment_states;
CREATE TRIGGER mdf_bazis_assignment_state_immutable BEFORE UPDATE OR DELETE ON mdf_bazis_assignment_states
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_bazis_composition_marker_change();
DROP TRIGGER IF EXISTS mdf_bazis_composition_intent_insert_guard ON mdf_bazis_composition_intents;
CREATE TRIGGER mdf_bazis_composition_intent_insert_guard BEFORE INSERT ON mdf_bazis_composition_intents
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_bazis_composition_intent_insert();
DROP TRIGGER IF EXISTS mdf_bazis_composition_intent_immutable ON mdf_bazis_composition_intents;
CREATE TRIGGER mdf_bazis_composition_intent_immutable BEFORE UPDATE OR DELETE ON mdf_bazis_composition_intents
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_bazis_composition_marker_change();
DROP TRIGGER IF EXISTS mdf_bazis_composition_intent_job_guard ON mdf_bazis_composition_intents;
CREATE CONSTRAINT TRIGGER mdf_bazis_composition_intent_job_guard
  AFTER INSERT ON mdf_bazis_composition_intents DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mdf_validate_bazis_composition_intent_job();
DROP TRIGGER IF EXISTS mdf_bazis_assignment_state_seal_guard ON mdf_revision_seals;
CREATE TRIGGER mdf_bazis_assignment_state_seal_guard BEFORE INSERT ON mdf_revision_seals
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_bazis_assignment_state_seal();

COMMENT ON TABLE mdf_bazis_assignment_states IS
  'Immutable per-revision MDF BASIS assignment authority; intentional empty requires an explicit composition command.';
COMMENT ON TABLE mdf_bazis_composition_intents IS
  'Immutable command-time BASIS composition snapshot bound to one deferred queued receipt/job; pin snapshot is not inherited.';
COMMIT;
