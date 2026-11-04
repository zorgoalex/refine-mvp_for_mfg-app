-- Authenticated order-demand cascade: an order command changed the live MDF demand of an accepted
-- source without touching its MDF-present positions. The receipt carries the predecessor's lines
-- verbatim with the new frozen demand; only the MDF worker may accept it. No backfill, no producer
-- is enabled by this migration.
BEGIN;

DO $$
BEGIN
  IF to_regclass(format('%I.%I',current_schema(),'mdf_evidence_revisions')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_revision_context')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_recalculation_jobs')) IS NULL
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='mdf_recalculation_jobs' AND column_name='effect_policy') THEN
    RAISE EXCEPTION 'MDF migration 188 requires MDF receipts/context/jobs with migration 178 in schema %',current_schema();
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS mdf_order_cascade_intents (
  intent_id UUID PRIMARY KEY,
  job_id UUID NOT NULL UNIQUE REFERENCES mdf_recalculation_jobs(job_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('packet','bazisCutSet','bath')),
  source_id TEXT NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 240),
  revision_key TEXT NOT NULL CHECK (length(btrim(revision_key)) BETWEEN 1 AND 240),
  predecessor_revision_key TEXT NOT NULL CHECK (length(btrim(predecessor_revision_key)) BETWEEN 1 AND 240),
  previous_demand_digest TEXT NOT NULL CHECK (previous_demand_digest ~ '^[a-f0-9]{64}$'),
  next_demand_digest TEXT NOT NULL CHECK (next_demand_digest ~ '^[a-f0-9]{64}$'),
  order_ids BIGINT[] NOT NULL,
  actor_user_id BIGINT NOT NULL CHECK (actor_user_id>0),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 2000),
  command_key TEXT NOT NULL CHECK (length(btrim(command_key)) BETWEEN 1 AND 400),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_kind,source_id,revision_key),
  UNIQUE(source_kind,source_id,command_key),
  FOREIGN KEY(source_kind,source_id,predecessor_revision_key)
    REFERENCES mdf_revision_seals(source_kind,source_id,revision_key) ON DELETE RESTRICT,
  CHECK (previous_demand_digest<>next_demand_digest),
  CHECK (cardinality(order_ids) BETWEEN 1 AND 100),
  CHECK (array_position(order_ids,NULL) IS NULL)
);

CREATE OR REPLACE FUNCTION mdf_guard_order_cascade_intent_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_head RECORD;
  context_row RECORD;
  predecessor_context RECORD;
BEGIN
  PERFORM 1 FROM mdf_evidence_revisions WHERE source_kind=NEW.source_kind
    AND source_id=NEW.source_id AND revision_key=NEW.revision_key FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM mdf_revision_seals WHERE source_kind=NEW.source_kind
    AND source_id=NEW.source_id AND revision_key=NEW.revision_key) THEN
    RAISE EXCEPTION 'MDF order cascade intent must be attached before its seal' USING ERRCODE='55000';
  END IF;
  SELECT * INTO context_row FROM mdf_revision_context WHERE source_kind=NEW.source_kind
    AND source_id=NEW.source_id AND revision_key=NEW.revision_key;
  SELECT * INTO predecessor_context FROM mdf_revision_context WHERE source_kind=NEW.source_kind
    AND source_id=NEW.source_id AND revision_key=NEW.predecessor_revision_key;
  IF context_row IS NULL OR predecessor_context IS NULL
    OR NOT context_row.acceptance_requested OR NOT context_row.composition_complete
    OR NOT predecessor_context.composition_complete
    OR context_row.effect_policy<>'forward'
    OR context_row.predecessor_accepted_revision_key IS DISTINCT FROM NEW.predecessor_revision_key
    OR context_row.predecessor_received_revision_key IS DISTINCT FROM NEW.predecessor_revision_key
    OR context_row.demand_digest IS DISTINCT FROM NEW.next_demand_digest
    OR predecessor_context.demand_digest IS DISTINCT FROM NEW.previous_demand_digest THEN
    RAISE EXCEPTION 'MDF order cascade intent differs from frozen receipt contexts' USING ERRCODE='23514';
  END IF;
  SELECT * INTO current_head FROM mdf_source_heads WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id;
  IF NOT FOUND OR current_head.received_revision_key IS DISTINCT FROM NEW.predecessor_revision_key
    OR current_head.accepted_revision_key IS DISTINCT FROM NEW.predecessor_revision_key THEN
    RAISE EXCEPTION 'MDF order cascade predecessor must be the stable accepted head' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.order_ids) WITH ORDINALITY u(order_id,ord)
    WHERE order_id<=0 OR (ord>1 AND order_id<=NEW.order_ids[ord-1])
  ) THEN
    RAISE EXCEPTION 'MDF order cascade order scope must be positive, sorted and unique' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Deferred: lines, seal and job are written after the intent in the same transaction.
CREATE OR REPLACE FUNCTION mdf_validate_order_cascade_intent_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_row mdf_recalculation_jobs%ROWTYPE;
  head_row mdf_source_heads%ROWTYPE;
BEGIN
  SELECT * INTO job_row FROM mdf_recalculation_jobs WHERE job_id=NEW.job_id;
  IF NOT FOUND OR job_row.source_kind IS DISTINCT FROM NEW.source_kind OR job_row.source_id IS DISTINCT FROM NEW.source_id
    OR job_row.revision_key IS DISTINCT FROM NEW.revision_key OR job_row.status<>'pending'
    OR job_row.effect_policy<>'forward' OR job_row.actor_user_id IS DISTINCT FROM NEW.actor_user_id
    OR job_row.request_id IS DISTINCT FROM NEW.request_id
    OR EXISTS (SELECT 1 FROM mdf_recalculation_job_rules r WHERE r.job_id=NEW.job_id) THEN
    RAISE EXCEPTION 'MDF order cascade intent must bind its pending rules-free forward job' USING ERRCODE='23514';
  END IF;
  SELECT * INTO head_row FROM mdf_source_heads WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id;
  IF NOT FOUND OR head_row.received_revision_key IS DISTINCT FROM NEW.revision_key
    OR head_row.accepted_revision_key IS DISTINCT FROM NEW.predecessor_revision_key THEN
    RAISE EXCEPTION 'MDF order cascade must leave acceptance to the worker' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mdf_revision_seals WHERE source_kind=NEW.source_kind
      AND source_id=NEW.source_id AND revision_key=NEW.revision_key)
    OR EXISTS (
      (SELECT line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework FROM mdf_evidence_lines
        WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id AND revision_key=NEW.revision_key
       EXCEPT ALL
       SELECT line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework FROM mdf_evidence_lines
        WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id AND revision_key=NEW.predecessor_revision_key)
      UNION ALL
      (SELECT line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework FROM mdf_evidence_lines
        WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id AND revision_key=NEW.predecessor_revision_key
       EXCEPT ALL
       SELECT line_key,order_id,detail_id,quantity,stage_code,evidence_kind,rework FROM mdf_evidence_lines
        WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id AND revision_key=NEW.revision_key)
    ) THEN
    RAISE EXCEPTION 'MDF order cascade must seal the predecessor lines verbatim' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mdf_reject_order_cascade_intent_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MDF order cascade intents are immutable' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS mdf_order_cascade_intent_insert_guard ON mdf_order_cascade_intents;
CREATE TRIGGER mdf_order_cascade_intent_insert_guard BEFORE INSERT ON mdf_order_cascade_intents
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_order_cascade_intent_insert();
DROP TRIGGER IF EXISTS mdf_order_cascade_intent_immutable ON mdf_order_cascade_intents;
CREATE TRIGGER mdf_order_cascade_intent_immutable BEFORE UPDATE OR DELETE ON mdf_order_cascade_intents
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_order_cascade_intent_change();
DROP TRIGGER IF EXISTS mdf_order_cascade_intent_commit_guard ON mdf_order_cascade_intents;
CREATE CONSTRAINT TRIGGER mdf_order_cascade_intent_commit_guard
  AFTER INSERT ON mdf_order_cascade_intents DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mdf_validate_order_cascade_intent_commit();

COMMENT ON TABLE mdf_order_cascade_intents IS
  'Immutable order-demand cascade marker: predecessor lines carried verbatim with new frozen demand; accepted only by the MDF worker.';

COMMIT;
