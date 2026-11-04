-- §5.7b initial population (baseline) of the MDF engine: run manifest, durable freeze guard, fence triggers on every
-- inventory/engine table, baseline markers on the sealed context, legacy-acceptance guard and the guarded reset of a
-- never-activated baseline. Plan: spec_erp/plans/mdf-baseline-population-impl-2026-09-27.md (GPT-6 R7/R8).
DO $$
BEGIN
  IF to_regclass(format('%I.mdf_revision_presentation', current_schema())) IS NULL THEN
    RAISE EXCEPTION 'MDF migration 195 requires migration 192 in schema %', current_schema();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS mdf_baseline_runs (
  run_id UUID PRIMARY KEY,
  run_seq BIGSERIAL NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('started','recorded','activated','aborted','drifted','reset')),
  operator_user_id BIGINT,
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) > 0),
  manifest JSONB NOT NULL,
  item_count INTEGER CHECK (item_count >= 0),
  items_digest TEXT CHECK (items_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status = 'started' OR status IN ('aborted','reset') OR (item_count IS NOT NULL AND items_digest IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS mdf_baseline_run_items (
  run_id UUID NOT NULL REFERENCES mdf_baseline_runs(run_id) ON DELETE RESTRICT,
  item_key TEXT NOT NULL CHECK (length(btrim(item_key)) BETWEEN 1 AND 300),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('source','order_closure')),
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  item_digest TEXT NOT NULL CHECK (item_digest ~ '^[a-f0-9]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, item_key),
  UNIQUE (source_kind, source_id, revision_key),
  CHECK ((item_kind = 'order_closure') = (source_kind = 'order'))
);

-- Diagnostic engine rows that existed before the run (R8): restored/kept by reset, admitted by resume/handoff.
CREATE TABLE IF NOT EXISTS mdf_baseline_run_preexisting (
  run_id UUID NOT NULL REFERENCES mdf_baseline_runs(run_id) ON DELETE RESTRICT,
  row_kind TEXT NOT NULL CHECK (row_kind IN ('head','revision','job')),
  row_key TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  PRIMARY KEY (run_id, row_kind, row_key)
);

CREATE TABLE IF NOT EXISTS mdf_freeze_guard (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  freeze_run_id UUID REFERENCES mdf_baseline_runs(run_id) ON DELETE RESTRICT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO mdf_freeze_guard(singleton) VALUES (true) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION mdf_baseline_owned() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('mdf.command_writer', true) IS NOT DISTINCT FROM 'mdf.baseline'
$$;

CREATE OR REPLACE FUNCTION mdf_guard_freeze_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'MDF freeze guard cannot be deleted' USING ERRCODE='55000'; END IF;
  IF NOT mdf_baseline_owned() THEN RAISE EXCEPTION 'MDF freeze guard is owned by the baseline run' USING ERRCODE='55000'; END IF;
  IF TG_OP = 'UPDATE' THEN NEW.changed_at := now(); RETURN NEW; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mdf_freeze_guard_row ON mdf_freeze_guard;
CREATE TRIGGER mdf_freeze_guard_row BEFORE UPDATE OR DELETE ON mdf_freeze_guard
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_freeze_guard();
DROP TRIGGER IF EXISTS mdf_freeze_guard_truncate ON mdf_freeze_guard;
CREATE TRIGGER mdf_freeze_guard_truncate BEFORE TRUNCATE ON mdf_freeze_guard
  FOR EACH STATEMENT EXECUTE FUNCTION mdf_guard_freeze_guard();

-- Run manifest: only the baseline runner writes; manifest and identity immutable; only allowed status transitions.
CREATE OR REPLACE FUNCTION mdf_guard_baseline_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT mdf_baseline_owned() THEN RAISE EXCEPTION 'MDF baseline run is owned by the baseline runner' USING ERRCODE='55000'; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'MDF baseline runs are history' USING ERRCODE='55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'started' THEN RAISE EXCEPTION 'MDF baseline run starts as started' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.run_id <> OLD.run_id OR NEW.run_seq <> OLD.run_seq OR NEW.manifest <> OLD.manifest
     OR NEW.request_id <> OLD.request_id OR NEW.operator_user_id IS DISTINCT FROM OLD.operator_user_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'MDF baseline run identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.item_count IS NOT NULL AND (NEW.item_count IS DISTINCT FROM OLD.item_count OR NEW.items_digest IS DISTINCT FROM OLD.items_digest) THEN
    RAISE EXCEPTION 'MDF baseline run manifest totals are immutable' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.status, NEW.status) IN (('started','recorded'),('recorded','activated'),('started','aborted'),
      ('recorded','aborted'),('recorded','drifted'),('aborted','reset'),('drifted','reset'))
      OR OLD.status = NEW.status) THEN
    RAISE EXCEPTION 'MDF baseline run transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE='23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mdf_baseline_run_guard ON mdf_baseline_runs;
CREATE TRIGGER mdf_baseline_run_guard BEFORE INSERT OR UPDATE OR DELETE ON mdf_baseline_runs
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_baseline_run();

CREATE OR REPLACE FUNCTION mdf_guard_baseline_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT mdf_baseline_owned() THEN RAISE EXCEPTION 'MDF baseline rows are owned by the baseline runner' USING ERRCODE='55000'; END IF;
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'MDF baseline rows are append-only' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mdf_baseline_item_guard ON mdf_baseline_run_items;
CREATE TRIGGER mdf_baseline_item_guard BEFORE INSERT OR UPDATE OR DELETE ON mdf_baseline_run_items
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_baseline_append_only();
DROP TRIGGER IF EXISTS mdf_baseline_preexisting_guard ON mdf_baseline_run_preexisting;
CREATE TRIGGER mdf_baseline_preexisting_guard BEFORE INSERT OR UPDATE OR DELETE ON mdf_baseline_run_preexisting
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_baseline_append_only();

-- Baseline markers on the sealed execution context (immutable like the rest of the row).
ALTER TABLE mdf_revision_context ADD COLUMN IF NOT EXISTS baseline_run_id UUID REFERENCES mdf_baseline_runs(run_id) ON DELETE RESTRICT;
ALTER TABLE mdf_revision_context ADD COLUMN IF NOT EXISTS closure TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mdf_context_baseline_check'
      AND conrelid=format('%I.mdf_revision_context', current_schema())::regclass) THEN
    ALTER TABLE mdf_revision_context ADD CONSTRAINT mdf_context_baseline_check CHECK (
      (closure IS NULL
        OR (closure = 'by_status' AND source_kind = 'order' AND baseline_run_id IS NOT NULL)
        OR (closure = 'carried' AND source_kind = 'order' AND baseline_run_id IS NULL AND effect_policy = 'publish_only'))
      AND (baseline_run_id IS NULL OR effect_policy = 'publish_only'));
  END IF;
END $$;

-- Historical coverage carried across a demand change ('carried') exists only as the successor of an accepted
-- historical-status closure ('by_status') or of an earlier carried revision of the same order.
CREATE OR REPLACE FUNCTION mdf_guard_carried_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.closure = 'carried' AND NOT EXISTS (SELECT 1 FROM mdf_revision_context p
      WHERE p.source_kind = NEW.source_kind AND p.source_id = NEW.source_id
        AND p.revision_key = NEW.predecessor_accepted_revision_key AND p.closure IN ('by_status','carried')) THEN
    RAISE EXCEPTION 'MDF carried closure requires an accepted closure predecessor' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mdf_carried_closure_guard ON mdf_revision_context;
CREATE TRIGGER mdf_carried_closure_guard BEFORE INSERT ON mdf_revision_context
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_carried_closure();

-- Legacy-origin acceptance exists only as a sealed baseline item of a run.
CREATE OR REPLACE FUNCTION mdf_guard_legacy_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.accepted_revision_key IS NOT NULL AND NEW.accepted_revision_key IS DISTINCT FROM
      (CASE WHEN TG_OP = 'UPDATE' THEN OLD.accepted_revision_key END)
    AND EXISTS (SELECT 1 FROM mdf_evidence_revisions r WHERE r.source_kind=NEW.source_kind AND r.source_id=NEW.source_id
      AND r.revision_key=NEW.accepted_revision_key AND r.origin='legacy')
    AND NOT EXISTS (SELECT 1 FROM mdf_baseline_run_items i JOIN mdf_revision_context c
        ON c.source_kind=i.source_kind AND c.source_id=i.source_id AND c.revision_key=i.revision_key
          AND c.baseline_run_id=i.run_id
      WHERE i.source_kind=NEW.source_kind AND i.source_id=NEW.source_id AND i.revision_key=NEW.accepted_revision_key) THEN
    RAISE EXCEPTION 'MDF legacy acceptance requires a baseline run item' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mdf_legacy_acceptance_guard ON mdf_source_heads;
CREATE TRIGGER mdf_legacy_acceptance_guard BEFORE INSERT OR UPDATE ON mdf_source_heads
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_legacy_acceptance();

-- Fence (R4–R7): fail fast while a population run holds the exclusive cutover lock, and reject every write that is not
-- the run itself while a run is unfinished (durable across crashes). The guard read is a locking read on a row only the
-- freeze lifecycle updates: a stale RR/SERIALIZABLE snapshot aborts with 40001 instead of missing the freeze.
CREATE OR REPLACE FUNCTION mdf_cutover_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE frozen UUID;
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0)) THEN
    RAISE EXCEPTION 'MDF_CUTOVER_IN_PROGRESS' USING ERRCODE='55P03', DETAIL=TG_TABLE_NAME;
  END IF;
  SELECT freeze_run_id INTO frozen FROM mdf_freeze_guard WHERE singleton FOR SHARE;
  IF frozen IS NOT NULL AND NOT mdf_baseline_owned() THEN
    RAISE EXCEPTION 'MDF_CUTOVER_IN_PROGRESS' USING ERRCODE='55P03', DETAIL=TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- inventory (5.7a/5.7b loaders; pinned by the static coverage test)
    'cnc_telegram_packets','cnc_telegram_packet_items','cnc_telegram_packet_whole_order_keys','bazis_cut_sets',
    'bazis_cut_set_details','cut_result','cut_result_placement','cut_result_sheet_map','cut_result_board_projection',
    'cut_job','mdf_board_manual_moves','orders','order_details','order_statuses','production_statuses','materials',
    'sheet_material_types','mdf_board_history_events',
    -- engine authority
    'mdf_engine_state','mdf_source_heads','mdf_evidence_revisions','mdf_evidence_lines','mdf_revision_seals',
    'mdf_revision_context','mdf_revision_demand','mdf_revision_presentation','mdf_recalculation_jobs',
    'mdf_recalculation_job_rules','mdf_bath_allocations','mdf_published_sources','mdf_published_source_members',
    'mdf_published_positions','mdf_shadow_commands','mdf_shadow_observations','mdf_position_detachments',
    'mdf_physical_lineage_contracts','mdf_physical_lineage_transitions','mdf_bath_transitions',
    'mdf_order_cascade_intents','mdf_bazis_composition_intents','mdf_bazis_assignment_states']
  LOOP
    IF to_regclass(format('%I.%I', current_schema(), t)) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS mdf_cutover_fence ON %I', t);
      EXECUTE format('CREATE TRIGGER mdf_cutover_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I '
        || 'FOR EACH STATEMENT EXECUTE FUNCTION mdf_cutover_fence()', t);
    END IF;
  END LOOP;
END $$;

-- Row removal with RI/immutability triggers off. The function-level SET restores session_replication_role on EVERY
-- exit (return or error), so the bypass never outlives this call; the caller re-validates FK equivalence afterwards.
CREATE OR REPLACE FUNCTION mdf_reset_delete_baseline_rows(p_run UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT SET session_replication_role = replica AS $$
BEGIN
  IF NOT mdf_baseline_owned() THEN RAISE EXCEPTION 'MDF baseline reset rows are owned by the reset' USING ERRCODE='55000'; END IF;
  IF (SELECT status FROM mdf_baseline_runs WHERE run_id = p_run) NOT IN ('aborted','drifted') THEN
    RAISE EXCEPTION 'MDF baseline reset requires an aborted or drifted run' USING ERRCODE='55000';
  END IF;
  DELETE FROM mdf_recalculation_job_rules jr USING mdf_recalculation_jobs j, (SELECT source_kind, source_id, revision_key FROM mdf_baseline_run_items WHERE run_id = p_run) x
    WHERE jr.job_id=j.job_id AND (j.source_kind,j.source_id,j.revision_key)=(x.source_kind,x.source_id,x.revision_key);
  DELETE FROM mdf_recalculation_jobs j USING (SELECT source_kind, source_id, revision_key FROM mdf_baseline_run_items WHERE run_id = p_run) x
    WHERE (j.source_kind,j.source_id,j.revision_key)=(x.source_kind,x.source_id,x.revision_key);
  DELETE FROM mdf_revision_presentation t USING (SELECT source_kind, source_id, revision_key FROM mdf_baseline_run_items WHERE run_id = p_run) x
    WHERE (t.source_kind,t.source_id,t.revision_key)=(x.source_kind,x.source_id,x.revision_key);
  DELETE FROM mdf_revision_demand t USING (SELECT source_kind, source_id, revision_key FROM mdf_baseline_run_items WHERE run_id = p_run) x
    WHERE (t.source_kind,t.source_id,t.revision_key)=(x.source_kind,x.source_id,x.revision_key);
  DELETE FROM mdf_revision_context t USING (SELECT source_kind, source_id, revision_key FROM mdf_baseline_run_items WHERE run_id = p_run) x
    WHERE (t.source_kind,t.source_id,t.revision_key)=(x.source_kind,x.source_id,x.revision_key);
  DELETE FROM mdf_evidence_lines t USING (SELECT source_kind, source_id, revision_key FROM mdf_baseline_run_items WHERE run_id = p_run) x
    WHERE (t.source_kind,t.source_id,t.revision_key)=(x.source_kind,x.source_id,x.revision_key);
  -- Heads: restore pre-existing diagnostic heads exactly, delete heads the run created.
  UPDATE mdf_source_heads h SET received_revision_key = p.snapshot->>'received',
      accepted_revision_key = p.snapshot->>'accepted', version = (p.snapshot->>'version')::bigint,
      correction_epoch = (p.snapshot->>'correctionEpoch')::bigint, updated_at = (p.snapshot->>'updatedAt')::timestamptz
    FROM mdf_baseline_run_preexisting p
    WHERE p.run_id=p_run AND p.row_kind='head' AND p.row_key=format('%s:%s', h.source_kind, h.source_id);
  DELETE FROM mdf_source_heads h WHERE NOT EXISTS (SELECT 1 FROM mdf_baseline_run_preexisting p
    WHERE p.run_id=p_run AND p.row_kind='head' AND p.row_key=format('%s:%s', h.source_kind, h.source_id));
  DELETE FROM mdf_revision_seals t USING (SELECT source_kind, source_id, revision_key FROM mdf_baseline_run_items WHERE run_id = p_run) x
    WHERE (t.source_kind,t.source_id,t.revision_key)=(x.source_kind,x.source_id,x.revision_key);
  DELETE FROM mdf_evidence_revisions t USING (SELECT source_kind, source_id, revision_key FROM mdf_baseline_run_items WHERE run_id = p_run) x
    WHERE (t.source_kind,t.source_id,t.revision_key)=(x.source_kind,x.source_id,x.revision_key);
END $$;
REVOKE ALL ON FUNCTION mdf_reset_delete_baseline_rows(UUID) FROM PUBLIC;

-- Guarded reset of a never-activated baseline run (R2/R3/R8). One transaction; deletes exactly the run's rows,
-- restores pre-existing diagnostic heads, clears the freeze and returns the engine to legacy.
CREATE OR REPLACE FUNCTION mdf_reset_unactivated_baseline(p_run UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE run_status TEXT; bad TEXT;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'MDF baseline reset requires the schema owner' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mdf-engine-cutover',0));
  SELECT status INTO run_status FROM mdf_baseline_runs WHERE run_id = p_run FOR UPDATE;
  IF run_status IS NULL OR run_status NOT IN ('aborted','drifted') THEN
    RAISE EXCEPTION 'MDF baseline reset requires an aborted or drifted run' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM mdf_baseline_runs WHERE status = 'activated') THEN
    RAISE EXCEPTION 'MDF engine was activated; baseline reset is forbidden' USING ERRCODE='55000';
  END IF;
  IF (SELECT mode FROM mdf_engine_state WHERE singleton) NOT IN ('legacy','read_only')
     OR (SELECT published_revision FROM mdf_engine_state WHERE singleton) <> 0 THEN
    RAISE EXCEPTION 'MDF baseline reset requires a never-published engine' USING ERRCODE='55000';
  END IF;
  -- Nothing outside this run and its pre-existing diagnostic set may exist.
  SELECT format('%s:%s:%s', r.source_kind, r.source_id, r.revision_key) INTO bad FROM mdf_evidence_revisions r
    WHERE NOT EXISTS (SELECT 1 FROM mdf_baseline_run_items i WHERE i.run_id=p_run AND i.source_kind=r.source_kind
        AND i.source_id=r.source_id AND i.revision_key=r.revision_key)
      AND NOT EXISTS (SELECT 1 FROM mdf_baseline_run_preexisting p WHERE p.run_id=p_run AND p.row_kind='revision'
        AND p.row_key=format('%s:%s:%s', r.source_kind, r.source_id, r.revision_key)) LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'MDF baseline reset: foreign revision %', bad USING ERRCODE='55000'; END IF;
  SELECT job_id::text INTO bad FROM mdf_recalculation_jobs j
    WHERE NOT EXISTS (SELECT 1 FROM mdf_baseline_run_items i WHERE i.run_id=p_run AND i.source_kind=j.source_kind
        AND i.source_id=j.source_id AND i.revision_key=j.revision_key)
      AND NOT EXISTS (SELECT 1 FROM mdf_baseline_run_preexisting p WHERE p.run_id=p_run AND p.row_kind='job'
        AND p.row_key=j.job_id::text) LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'MDF baseline reset: foreign job %', bad USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM mdf_bath_allocations) OR EXISTS (SELECT 1 FROM mdf_published_sources)
     OR EXISTS (SELECT 1 FROM mdf_published_positions) OR EXISTS (SELECT 1 FROM mdf_position_detachments)
     OR EXISTS (SELECT 1 FROM mdf_physical_lineage_contracts) OR EXISTS (SELECT 1 FROM mdf_bath_transitions)
     OR EXISTS (SELECT 1 FROM mdf_order_cascade_intents) OR EXISTS (SELECT 1 FROM mdf_bazis_composition_intents) THEN
    RAISE EXCEPTION 'MDF baseline reset: engine holds non-baseline authority' USING ERRCODE='55000';
  END IF;

  PERFORM set_config('mdf.command_writer', 'mdf.baseline', true);
  PERFORM mdf_reset_delete_baseline_rows(p_run);

  -- FK-equivalent orphan checks (replica mode skipped the RI triggers above).
  IF EXISTS (SELECT 1 FROM mdf_evidence_lines l WHERE NOT EXISTS (SELECT 1 FROM mdf_evidence_revisions r
        WHERE (r.source_kind,r.source_id,r.revision_key)=(l.source_kind,l.source_id,l.revision_key)))
     OR EXISTS (SELECT 1 FROM mdf_revision_context c WHERE NOT EXISTS (SELECT 1 FROM mdf_evidence_revisions r
        WHERE (r.source_kind,r.source_id,r.revision_key)=(c.source_kind,c.source_id,c.revision_key)))
     OR EXISTS (SELECT 1 FROM mdf_revision_demand d WHERE NOT EXISTS (SELECT 1 FROM mdf_revision_context c
        WHERE (c.source_kind,c.source_id,c.revision_key)=(d.source_kind,d.source_id,d.revision_key)))
     OR EXISTS (SELECT 1 FROM mdf_revision_presentation t WHERE NOT EXISTS (SELECT 1 FROM mdf_evidence_revisions r
        WHERE (r.source_kind,r.source_id,r.revision_key)=(t.source_kind,t.source_id,t.revision_key)))
     OR EXISTS (SELECT 1 FROM mdf_revision_seals s WHERE NOT EXISTS (SELECT 1 FROM mdf_evidence_revisions r
        WHERE (r.source_kind,r.source_id,r.revision_key)=(s.source_kind,s.source_id,s.revision_key)))
     OR EXISTS (SELECT 1 FROM mdf_recalculation_jobs j WHERE NOT EXISTS (SELECT 1 FROM mdf_revision_seals s
        WHERE (s.source_kind,s.source_id,s.revision_key)=(j.source_kind,j.source_id,j.revision_key)))
     OR EXISTS (SELECT 1 FROM mdf_recalculation_job_rules jr WHERE NOT EXISTS (SELECT 1 FROM mdf_recalculation_jobs j
        WHERE j.job_id=jr.job_id))
     OR EXISTS (SELECT 1 FROM mdf_source_heads h WHERE NOT EXISTS (SELECT 1 FROM mdf_revision_seals s
        WHERE (s.source_kind,s.source_id,s.revision_key)=(h.source_kind,h.source_id,h.received_revision_key))
        OR (h.accepted_revision_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mdf_revision_seals s
        WHERE (s.source_kind,s.source_id,s.revision_key)=(h.source_kind,h.source_id,h.accepted_revision_key))))
     OR EXISTS (SELECT 1 FROM mdf_shadow_commands c WHERE NOT EXISTS (SELECT 1 FROM mdf_revision_seals s
        WHERE (s.source_kind,s.source_id,s.revision_key)=(c.source_kind,c.source_id,c.revision_key)))
     OR EXISTS (SELECT 1 FROM mdf_shadow_observations o WHERE NOT EXISTS (SELECT 1 FROM mdf_revision_seals s
        WHERE (s.source_kind,s.source_id,s.revision_key)=(o.source_kind,o.source_id,o.revision_key))) THEN
    RAISE EXCEPTION 'MDF baseline reset left orphaned engine rows' USING ERRCODE='23503';
  END IF;

  UPDATE mdf_baseline_runs SET status = 'reset' WHERE run_id = p_run;
  UPDATE mdf_freeze_guard SET freeze_run_id = NULL WHERE singleton;
  UPDATE mdf_engine_state SET mode = 'legacy' WHERE singleton;
END $$;
REVOKE ALL ON FUNCTION mdf_reset_unactivated_baseline(UUID) FROM PUBLIC;
