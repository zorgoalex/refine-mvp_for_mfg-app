-- Additive foundation only. No source producers or new automation are enabled.
BEGIN;

CREATE TABLE IF NOT EXISTS mdf_engine_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  mode TEXT NOT NULL DEFAULT 'legacy' CHECK (mode IN ('legacy','shadow','active','read_only')),
  published_revision BIGINT NOT NULL DEFAULT 0 CHECK (published_revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO mdf_engine_state(singleton) VALUES (true) ON CONFLICT DO NOTHING;

-- Deliberately no FK to deletable source/order/user rows: historical identity
-- must survive source removal. Current identity/authorization is command-owned.
CREATE TABLE IF NOT EXISTS mdf_evidence_revisions (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('packet','bazisCutSet','bath','order','orderDetail')),
  source_id TEXT NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 240),
  revision_key TEXT NOT NULL CHECK (length(btrim(revision_key)) BETWEEN 1 AND 240),
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  origin TEXT NOT NULL CHECK (origin IN ('cnc','manual','order_cascade','legacy','derived')),
  actor_user_id BIGINT,
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) > 0),
  cause_key TEXT NOT NULL CHECK (length(btrim(cause_key)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_kind,source_id,revision_key)
);

CREATE TABLE IF NOT EXISTS mdf_revision_seals (
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  sealed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_kind,source_id,revision_key),
  FOREIGN KEY(source_kind,source_id,revision_key)
    REFERENCES mdf_evidence_revisions(source_kind,source_id,revision_key) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS mdf_source_heads (
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  received_revision_key TEXT NOT NULL,
  accepted_revision_key TEXT,
  correction_epoch BIGINT NOT NULL DEFAULT 0 CHECK (correction_epoch >= 0),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_kind,source_id),
  FOREIGN KEY(source_kind,source_id,received_revision_key)
    REFERENCES mdf_revision_seals(source_kind,source_id,revision_key) ON DELETE RESTRICT,
  FOREIGN KEY(source_kind,source_id,accepted_revision_key)
    REFERENCES mdf_revision_seals(source_kind,source_id,revision_key) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS mdf_evidence_lines (
  evidence_line_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  line_key TEXT NOT NULL CHECK (length(btrim(line_key)) BETWEEN 1 AND 240),
  order_id BIGINT NOT NULL CHECK (order_id > 0),
  detail_id BIGINT NOT NULL CHECK (detail_id > 0),
  quantity BIGINT NOT NULL CHECK (quantity BETWEEN 1 AND 9007199254740991),
  stage_code TEXT NOT NULL CHECK (length(btrim(stage_code)) > 0),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('physical','declaration','derived')),
  rework BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_kind,source_id,revision_key,line_key),
  UNIQUE(evidence_line_id,order_id,detail_id),
  FOREIGN KEY(source_kind,source_id,revision_key)
    REFERENCES mdf_evidence_revisions(source_kind,source_id,revision_key) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_mdf_evidence_position
  ON mdf_evidence_lines(order_id,detail_id,stage_code,source_kind,source_id,revision_key);

CREATE TABLE IF NOT EXISTS mdf_bath_allocations (
  allocation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_line_id UUID NOT NULL,
  bath_id TEXT NOT NULL CHECK (length(btrim(bath_id)) BETWEEN 1 AND 240),
  bath_revision TEXT NOT NULL CHECK (length(btrim(bath_revision)) BETWEEN 1 AND 240),
  order_id BIGINT NOT NULL,
  detail_id BIGINT NOT NULL,
  quantity BIGINT NOT NULL CHECK (quantity BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('reserved','consumed','released')),
  cause_key TEXT NOT NULL CHECK (length(btrim(cause_key)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(evidence_line_id,order_id,detail_id)
    REFERENCES mdf_evidence_lines(evidence_line_id,order_id,detail_id) ON DELETE RESTRICT,
  UNIQUE(cause_key,evidence_line_id,bath_id,bath_revision)
);
CREATE INDEX IF NOT EXISTS idx_mdf_allocation_supply ON mdf_bath_allocations(evidence_line_id)
  WHERE state <> 'released';
CREATE INDEX IF NOT EXISTS idx_mdf_allocation_bath ON mdf_bath_allocations(bath_id,bath_revision);
CREATE INDEX IF NOT EXISTS idx_mdf_allocation_position ON mdf_bath_allocations(order_id,detail_id)
  WHERE state <> 'released';

CREATE TABLE IF NOT EXISTS mdf_recalculation_jobs (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE CHECK (length(btrim(event_key)) > 0),
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  correction_epoch BIGINT NOT NULL CHECK (correction_epoch >= 0),
  actor_user_id BIGINT,
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','superseded','needs_attention')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  FOREIGN KEY(source_kind,source_id,revision_key)
    REFERENCES mdf_revision_seals(source_kind,source_id,revision_key) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_mdf_job_pending ON mdf_recalculation_jobs(next_attempt_at,created_at,job_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_mdf_job_source ON mdf_recalculation_jobs(source_kind,source_id,created_at DESC);
CREATE TABLE IF NOT EXISTS mdf_recalculation_job_rules (
  job_id UUID NOT NULL REFERENCES mdf_recalculation_jobs(job_id) ON DELETE RESTRICT,
  rule_id BIGINT NOT NULL CHECK (rule_id > 0),
  rule_version BIGINT NOT NULL CHECK (rule_version > 0),
  PRIMARY KEY(job_id,rule_id)
);

CREATE OR REPLACE FUNCTION mdf_reject_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MDF evidence is append-only' USING ERRCODE='55000';
END;
$$;
DROP TRIGGER IF EXISTS mdf_revision_immutable ON mdf_evidence_revisions;
CREATE TRIGGER mdf_revision_immutable BEFORE UPDATE OR DELETE ON mdf_evidence_revisions
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();
DROP TRIGGER IF EXISTS mdf_line_immutable ON mdf_evidence_lines;
CREATE TRIGGER mdf_line_immutable BEFORE UPDATE OR DELETE ON mdf_evidence_lines
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();
DROP TRIGGER IF EXISTS mdf_seal_immutable ON mdf_revision_seals;
CREATE TRIGGER mdf_seal_immutable BEFORE UPDATE OR DELETE ON mdf_revision_seals
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();
DROP TRIGGER IF EXISTS mdf_job_rules_immutable ON mdf_recalculation_job_rules;
CREATE TRIGGER mdf_job_rules_immutable BEFORE UPDATE OR DELETE ON mdf_recalculation_job_rules
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();

-- Both seal and line insertion serialize on the parent revision. A committed
-- seal closes membership forever, including when heads advance to other versions.
CREATE OR REPLACE FUNCTION mdf_guard_revision_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM mdf_evidence_revisions
    WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id AND revision_key=NEW.revision_key
    FOR UPDATE;
  IF TG_TABLE_NAME='mdf_evidence_lines' AND EXISTS (
    SELECT 1 FROM mdf_revision_seals
    WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id AND revision_key=NEW.revision_key
  ) THEN RAISE EXCEPTION 'MDF revision is sealed' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mdf_line_insert_guard ON mdf_evidence_lines;
CREATE TRIGGER mdf_line_insert_guard BEFORE INSERT ON mdf_evidence_lines
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_revision_membership();
DROP TRIGGER IF EXISTS mdf_seal_insert_guard ON mdf_revision_seals;
CREATE TRIGGER mdf_seal_insert_guard BEFORE INSERT ON mdf_revision_seals
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_revision_membership();

CREATE OR REPLACE FUNCTION mdf_guard_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence mdf_evidence_lines%ROWTYPE; accepted TEXT; used NUMERIC;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'MDF allocation history cannot be deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'state'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'updated_at')
      OR (OLD.state='released' AND NEW.state<>'released')
      OR (OLD.state='consumed' AND NEW.state='reserved') THEN
      RAISE EXCEPTION 'MDF allocation requires explicit release and replacement' USING ERRCODE='55000';
    END IF;
  END IF;
  SELECT * INTO evidence FROM mdf_evidence_lines WHERE evidence_line_id=NEW.evidence_line_id;
  IF NOT FOUND OR evidence.order_id<>NEW.order_id OR evidence.detail_id<>NEW.detail_id THEN
    RAISE EXCEPTION 'MDF allocation position mismatch' USING ERRCODE='23503';
  END IF;
  -- Lock head before evidence: acceptance and concurrent allocations use same order.
  SELECT accepted_revision_key INTO accepted FROM mdf_source_heads
    WHERE source_kind=evidence.source_kind AND source_id=evidence.source_id FOR UPDATE;
  PERFORM 1 FROM mdf_evidence_lines WHERE evidence_line_id=NEW.evidence_line_id FOR UPDATE;
  IF NEW.state<>'released' THEN
    IF accepted IS DISTINCT FROM evidence.revision_key OR evidence.rework
      OR evidence.evidence_kind<>'physical' OR evidence.stage_code<>'cut' THEN
      RAISE EXCEPTION 'MDF allocation requires accepted normal cut evidence' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(SUM(quantity),0) INTO used FROM mdf_bath_allocations
      WHERE evidence_line_id=NEW.evidence_line_id AND state<>'released'
        AND allocation_id IS DISTINCT FROM NEW.allocation_id;
    IF used+NEW.quantity>evidence.quantity THEN
      RAISE EXCEPTION 'MDF cut supply already allocated' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mdf_allocation_guard ON mdf_bath_allocations;
CREATE TRIGGER mdf_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON mdf_bath_allocations
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_allocation();

CREATE OR REPLACE FUNCTION mdf_guard_accepted_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.accepted_revision_key IS DISTINCT FROM OLD.accepted_revision_key AND EXISTS (
    SELECT 1 FROM mdf_evidence_lines e JOIN mdf_bath_allocations a USING(evidence_line_id)
    WHERE e.source_kind=OLD.source_kind AND e.source_id=OLD.source_id
      AND e.revision_key=OLD.accepted_revision_key AND a.state<>'released'
  ) THEN
    RAISE EXCEPTION 'MDF accepted revision still has allocations' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mdf_accepted_revision_guard ON mdf_source_heads;
CREATE TRIGGER mdf_accepted_revision_guard BEFORE UPDATE ON mdf_source_heads
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_accepted_revision();

COMMENT ON TABLE mdf_evidence_revisions IS
  'mdf-engine-foundation-v1: frozen source revisions; no production behavior enabled by this migration';
COMMENT ON TABLE mdf_evidence_lines IS
  'Accepted head selects accounting revision. Derived states are not supply; rework is statistics only.';
COMMENT ON TABLE mdf_bath_allocations IS
  'Durable cut consumption. Executor must lock complete owning orders and supply before writes; hiding a bath does not release use.';
COMMENT ON TABLE mdf_recalculation_jobs IS
  'Dedicated MDF execution inbox, independent of notification flags. No active scheduler until all producers and safe cutover are wired.';
COMMIT;
