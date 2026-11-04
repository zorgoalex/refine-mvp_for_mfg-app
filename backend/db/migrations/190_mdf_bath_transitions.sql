-- §5.4b bath lifecycle: a cut job has at most one active bath. When its current result changes, the previous
-- bath B is retired (terminal revision: no lines, no demand) and the successor N (if any) is captured, both
-- authenticated by one immutable transition row and accepted ONLY by B's transition job. No backfill.
BEGIN;

DO $$
BEGIN
  IF to_regclass(format('%I.%I',current_schema(),'mdf_evidence_revisions')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_revision_context')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_recalculation_jobs')) IS NULL
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='mdf_recalculation_jobs' AND column_name='effect_policy') THEN
    RAISE EXCEPTION 'MDF migration 190 requires MDF receipts/context/jobs with migration 178 in schema %',current_schema();
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS mdf_bath_transitions (
  transition_id UUID PRIMARY KEY,
  job_id UUID NOT NULL UNIQUE REFERENCES mdf_recalculation_jobs(job_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  cut_job_id BIGINT NOT NULL CHECK (cut_job_id>0),
  retired_source_kind TEXT NOT NULL DEFAULT 'bath' CHECK (retired_source_kind='bath'),
  retired_source_id TEXT NOT NULL CHECK (retired_source_id ~ '^cut-result:[1-9][0-9]*$'),
  retired_revision_key TEXT NOT NULL CHECK (length(btrim(retired_revision_key)) BETWEEN 1 AND 240),
  retired_predecessor_revision_key TEXT NOT NULL CHECK (length(btrim(retired_predecessor_revision_key)) BETWEEN 1 AND 240),
  successor_source_id TEXT CHECK (successor_source_id IS NULL OR successor_source_id ~ '^cut-result:[1-9][0-9]*$'),
  successor_revision_key TEXT CHECK (successor_revision_key IS NULL OR length(btrim(successor_revision_key)) BETWEEN 1 AND 240),
  owner_ids BIGINT[] NOT NULL,
  actor_user_id BIGINT NOT NULL CHECK (actor_user_id>0),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 2000),
  command_key TEXT NOT NULL CHECK (length(btrim(command_key)) BETWEEN 1 AND 400),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(retired_source_id,retired_revision_key),
  UNIQUE(cut_job_id,command_key),
  CHECK ((successor_source_id IS NULL) = (successor_revision_key IS NULL)),
  CHECK (successor_source_id IS DISTINCT FROM retired_source_id),
  CHECK (cardinality(owner_ids) BETWEEN 1 AND 100),
  CHECK (array_position(owner_ids,NULL) IS NULL),
  FOREIGN KEY(retired_source_kind,retired_source_id,retired_predecessor_revision_key)
    REFERENCES mdf_revision_seals(source_kind,source_id,revision_key) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION mdf_guard_bath_transition_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head RECORD;
BEGIN
  PERFORM 1 FROM mdf_evidence_revisions WHERE source_kind='bath' AND source_id=NEW.retired_source_id
    AND revision_key=NEW.retired_revision_key FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM mdf_revision_seals WHERE source_kind='bath' AND source_id=NEW.retired_source_id
    AND revision_key=NEW.retired_revision_key) THEN
    RAISE EXCEPTION 'MDF bath transition must be attached before the retirement seal' USING ERRCODE='55000';
  END IF;
  SELECT * INTO head FROM mdf_source_heads WHERE source_kind='bath' AND source_id=NEW.retired_source_id;
  IF NOT FOUND OR head.accepted_revision_key IS DISTINCT FROM NEW.retired_predecessor_revision_key
    OR head.received_revision_key IS DISTINCT FROM NEW.retired_predecessor_revision_key THEN
    RAISE EXCEPTION 'MDF bath transition predecessor must be the stable accepted head' USING ERRCODE='23514';
  END IF;
  -- The successor receipt is recorded first in the same transaction: its head must hold exactly this one
  -- unaccepted revision (a brand-new source), never an existing bath.
  IF NEW.successor_source_id IS NOT NULL AND (
      NOT EXISTS (SELECT 1 FROM mdf_source_heads WHERE source_kind='bath' AND source_id=NEW.successor_source_id
        AND received_revision_key=NEW.successor_revision_key AND accepted_revision_key IS NULL)
      OR EXISTS (SELECT 1 FROM mdf_evidence_revisions WHERE source_kind='bath' AND source_id=NEW.successor_source_id
        AND revision_key<>NEW.successor_revision_key)) THEN
    RAISE EXCEPTION 'MDF bath successor must be a new source' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.owner_ids) WITH ORDINALITY u(owner_id,ord)
      WHERE owner_id<=0 OR (ord>1 AND owner_id<=NEW.owner_ids[ord-1])) THEN
    RAISE EXCEPTION 'MDF bath transition owners must be positive, sorted and unique' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Deferred: seals, lines and the job are written after the transition row in the same transaction.
CREATE OR REPLACE FUNCTION mdf_validate_bath_transition_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_row mdf_recalculation_jobs%ROWTYPE;
  retired_head RECORD;
BEGIN
  SELECT * INTO job_row FROM mdf_recalculation_jobs WHERE job_id=NEW.job_id;
  IF NOT FOUND OR job_row.source_kind<>'bath' OR job_row.source_id<>NEW.retired_source_id
    OR job_row.revision_key<>NEW.retired_revision_key OR job_row.status<>'pending' OR job_row.effect_policy<>'forward'
    OR job_row.actor_user_id IS DISTINCT FROM NEW.actor_user_id OR job_row.request_id IS DISTINCT FROM NEW.request_id THEN
    RAISE EXCEPTION 'MDF bath transition must bind its pending forward job on the retired bath' USING ERRCODE='23514';
  END IF;
  SELECT * INTO retired_head FROM mdf_source_heads WHERE source_kind='bath' AND source_id=NEW.retired_source_id;
  IF NOT FOUND OR retired_head.received_revision_key IS DISTINCT FROM NEW.retired_revision_key
    OR retired_head.accepted_revision_key IS DISTINCT FROM NEW.retired_predecessor_revision_key THEN
    RAISE EXCEPTION 'MDF bath retirement must leave acceptance to the worker' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mdf_revision_seals WHERE source_kind='bath' AND source_id=NEW.retired_source_id
      AND revision_key=NEW.retired_revision_key)
    OR EXISTS (SELECT 1 FROM mdf_evidence_lines WHERE source_kind='bath' AND source_id=NEW.retired_source_id
      AND revision_key=NEW.retired_revision_key)
    OR EXISTS (SELECT 1 FROM mdf_revision_demand WHERE source_kind='bath' AND source_id=NEW.retired_source_id
      AND revision_key=NEW.retired_revision_key) THEN
    RAISE EXCEPTION 'MDF bath retirement must seal an empty revision' USING ERRCODE='23514';
  END IF;
  IF NEW.successor_source_id IS NOT NULL AND (
      NOT EXISTS (SELECT 1 FROM mdf_revision_seals WHERE source_kind='bath' AND source_id=NEW.successor_source_id
        AND revision_key=NEW.successor_revision_key)
      OR NOT EXISTS (SELECT 1 FROM mdf_source_heads WHERE source_kind='bath' AND source_id=NEW.successor_source_id
        AND received_revision_key=NEW.successor_revision_key AND accepted_revision_key IS NULL)
      OR EXISTS (SELECT 1 FROM mdf_recalculation_jobs WHERE source_kind='bath' AND source_id=NEW.successor_source_id)
      OR EXISTS (SELECT 1 FROM mdf_evidence_lines WHERE source_kind='bath' AND source_id=NEW.successor_source_id
        AND revision_key=NEW.successor_revision_key AND NOT (stage_code='membership' AND evidence_kind='derived'))) THEN
    RAISE EXCEPTION 'MDF bath successor must be an unaccepted membership-only revision without its own job' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mdf_reject_bath_transition_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MDF bath transitions are immutable' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS mdf_bath_transition_insert_guard ON mdf_bath_transitions;
CREATE TRIGGER mdf_bath_transition_insert_guard BEFORE INSERT ON mdf_bath_transitions
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_bath_transition_insert();
DROP TRIGGER IF EXISTS mdf_bath_transition_immutable ON mdf_bath_transitions;
CREATE TRIGGER mdf_bath_transition_immutable BEFORE UPDATE OR DELETE ON mdf_bath_transitions
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_bath_transition_change();
DROP TRIGGER IF EXISTS mdf_bath_transition_commit_guard ON mdf_bath_transitions;
CREATE CONSTRAINT TRIGGER mdf_bath_transition_commit_guard
  AFTER INSERT ON mdf_bath_transitions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mdf_validate_bath_transition_commit();

-- Job of a source revision: its own job, or — for a transition successor, which never gets one — the
-- transition job that accepts it. Consumers that require «the revision's job is done» read this view.
CREATE OR REPLACE VIEW mdf_revision_jobs AS
  SELECT j.job_id,j.source_kind,j.source_id,j.revision_key,j.status,j.created_at FROM mdf_recalculation_jobs j
  UNION ALL
  SELECT j.job_id,'bath'::text,t.successor_source_id,t.successor_revision_key,j.status,j.created_at
    FROM mdf_bath_transitions t JOIN mdf_recalculation_jobs j ON j.job_id=t.job_id
    WHERE t.successor_source_id IS NOT NULL;

COMMENT ON TABLE mdf_bath_transitions IS
  'Immutable bath lifecycle transition: retire bath B (empty terminal revision) and capture successor N, both accepted only by B''s transition job.';

COMMIT;
