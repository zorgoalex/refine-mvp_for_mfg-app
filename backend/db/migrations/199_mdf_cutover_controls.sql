-- §5.8 cutover controls: a durable RECOVERY freeze (every write rejected, incl. CNC receipts and catalog edits),
-- durable demand-drift conflicts of the reconciler, and a catalog guard that refuses a rename removing MDF
-- classification from details that are members of accepted engine sources (active/read_only only).
-- Plan: spec_erp/reviews/mdf-cutover-58-plan*-20260928.md (GPT-6 R5 APPROVED).
DO $$
BEGIN
  IF to_regclass(format('%I.mdf_freeze_guard', current_schema())) IS NULL THEN
    RAISE EXCEPTION 'MDF migration 199 requires migration 195 in schema %', current_schema();
  END IF;
END $$;

ALTER TABLE mdf_freeze_guard ADD COLUMN IF NOT EXISTS recovery_frozen_at TIMESTAMPTZ;
ALTER TABLE mdf_freeze_guard ADD COLUMN IF NOT EXISTS recovery_reason TEXT
  CHECK (recovery_reason IS NULL OR length(btrim(recovery_reason)) BETWEEN 1 AND 500);

-- The audited mode/freeze CLI is the only writer admitted during a recovery freeze.
CREATE OR REPLACE FUNCTION mdf_recovery_owned() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('mdf.command_writer', true) IS NOT DISTINCT FROM 'mdf.recovery'
$$;

CREATE OR REPLACE FUNCTION mdf_guard_freeze_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'MDF freeze guard cannot be deleted' USING ERRCODE='55000'; END IF;
  IF NOT (mdf_baseline_owned() OR mdf_recovery_owned()) THEN
    RAISE EXCEPTION 'MDF freeze guard is owned by the baseline run or the recovery command' USING ERRCODE='55000';
  END IF;
  -- The baseline run never touches the recovery freeze and the recovery command never the run freeze.
  IF TG_OP = 'UPDATE' AND mdf_baseline_owned()
     AND (NEW.recovery_frozen_at IS DISTINCT FROM OLD.recovery_frozen_at OR NEW.recovery_reason IS DISTINCT FROM OLD.recovery_reason) THEN
    RAISE EXCEPTION 'MDF recovery freeze is owned by the recovery command' USING ERRCODE='55000';
  END IF;
  IF TG_OP = 'UPDATE' AND mdf_recovery_owned() AND NEW.freeze_run_id IS DISTINCT FROM OLD.freeze_run_id THEN
    RAISE EXCEPTION 'MDF baseline freeze is owned by the baseline run' USING ERRCODE='55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.changed_at := now(); END IF;
  RETURN NEW;
END $$;

-- Fence: unchanged fail-fast lock step; a recovery freeze rejects every write except the recovery command itself;
-- the baseline freeze rejects every write except the baseline run.
CREATE OR REPLACE FUNCTION mdf_cutover_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE frozen UUID; recovery TIMESTAMPTZ;
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0)) THEN
    RAISE EXCEPTION 'MDF_CUTOVER_IN_PROGRESS' USING ERRCODE='55P03', DETAIL=TG_TABLE_NAME;
  END IF;
  SELECT freeze_run_id, recovery_frozen_at INTO frozen, recovery FROM mdf_freeze_guard WHERE singleton FOR SHARE;
  IF recovery IS NOT NULL AND NOT mdf_recovery_owned() THEN
    RAISE EXCEPTION 'MDF_RECOVERY_FREEZE' USING ERRCODE='55P03', DETAIL=TG_TABLE_NAME;
  END IF;
  IF frozen IS NOT NULL AND NOT mdf_baseline_owned() THEN
    RAISE EXCEPTION 'MDF_CUTOVER_IN_PROGRESS' USING ERRCODE='55P03', DETAIL=TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END $$;

-- Durable reconciler conflicts (one row per affected source and transition; upserted, never duplicated).
-- Mode-change provenance (§5.8): set by the database on every mode change, monotonic, and untouchable by any other
-- writer (publication also updates mdf_engine_state.updated_at). The command boundary and the job worker refuse a
-- transaction that started at or before it, so every engine write under a new mode is stamped after the change and
-- the rollback loss check (created_at > activation) cannot miss it.
ALTER TABLE mdf_engine_state ADD COLUMN IF NOT EXISTS mode_changed_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE OR REPLACE FUNCTION mdf_stamp_mode_changed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM OLD.mode THEN
    NEW.mode_changed_at := GREATEST(OLD.mode_changed_at, clock_timestamp());
  ELSE
    NEW.mode_changed_at := OLD.mode_changed_at;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mdf_mode_changed_at_stamp ON mdf_engine_state;
CREATE TRIGGER mdf_mode_changed_at_stamp BEFORE UPDATE ON mdf_engine_state
  FOR EACH ROW EXECUTE FUNCTION mdf_stamp_mode_changed_at();

CREATE TABLE IF NOT EXISTS mdf_demand_drift_conflicts (
  conflict_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('packet','bazisCutSet','bath','order')),
  source_id TEXT NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 240),
  predecessor_revision_key TEXT NOT NULL,
  frozen_demand_digest TEXT NOT NULL CHECK (frozen_demand_digest ~ '^[a-f0-9]{64}$'),
  live_demand_digest TEXT NOT NULL CHECK (live_demand_digest ~ '^[a-f0-9]{64}$'),
  owner_ids BIGINT[] NOT NULL,
  code TEXT NOT NULL CHECK (code IN ('CONFIRMATION_REQUIRED','HARD_CONFLICT','BLOCKED_BY_CLOSURE','MDF_RECONCILE_SCOPE_LIMIT')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  detected_request_id TEXT NOT NULL,
  resolved_request_id TEXT,
  resolved_by_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  UNIQUE (source_kind, source_id, predecessor_revision_key, live_demand_digest)
);
CREATE INDEX IF NOT EXISTS idx_mdf_demand_drift_conflicts_open ON mdf_demand_drift_conflicts(status, detected_at)
  WHERE status = 'open';
DO $$
BEGIN
  IF to_regclass(format('%I.mdf_demand_drift_conflicts', current_schema())) IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS mdf_cutover_fence ON mdf_demand_drift_conflicts';
    EXECUTE 'CREATE TRIGGER mdf_cutover_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON mdf_demand_drift_conflicts '
      || 'FOR EACH STATEMENT EXECUTE FUNCTION mdf_cutover_fence()';
  END IF;
END $$;

-- The baseline inventory reads result archive state (a bath is active only for a non-archived current result), so
-- the table joins the fence list of migration 195 (pinned by the static coverage test).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['cut_result_archive_state']
  LOOP
    IF to_regclass(format('%I.%I', current_schema(), t)) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS mdf_cutover_fence ON %I', t);
      EXECUTE format('CREATE TRIGGER mdf_cutover_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I '
        || 'FOR EACH STATEMENT EXECUTE FUNCTION mdf_cutover_fence()', t);
    END IF;
  END LOOP;
END $$;

-- Catalog guard (active/read_only): a rename that removes MDF classification (same regexes as
-- `backend/src/shared/cnc-material` — pinned by a static test) from any live detail that is a member of an accepted
-- engine source is refused; such details must be changed through orders (cascade with confirmation).
CREATE OR REPLACE FUNCTION mdf_material_is_mdf(name TEXT) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(name,'') ~* '(mdf|мдф)'
    AND COALESCE(name,'') !~* '(^|[^a-zа-яё])(hdf|хдф|лдсп|ldsp|lдсп|дсп|dsp|двп|dvp|osb|осп|fanera|фанера|plywood|акрил|acrylic|пластик|plastic|khdf|xdf|osp|akril|plastik)([^a-zа-яё]|$)'
$$;

CREATE OR REPLACE FUNCTION mdf_guard_catalog_classification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE engine_mode TEXT; affected BIGINT;
BEGIN
  SELECT mode INTO engine_mode FROM mdf_engine_state WHERE singleton;
  IF engine_mode NOT IN ('active','read_only') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'sheet_material_types' THEN
    IF NOT (mdf_material_is_mdf(OLD.name) AND NOT mdf_material_is_mdf(NEW.name)) THEN RETURN NEW; END IF;
    SELECT count(DISTINCT d.detail_id) INTO affected FROM order_details d
      WHERE d.sheet_material_type_id = OLD.sheet_material_type_id AND NOT d.delete_flag
        AND EXISTS (SELECT 1 FROM mdf_evidence_lines l JOIN mdf_source_heads h ON h.source_kind=l.source_kind
          AND h.source_id=l.source_id AND l.revision_key=h.accepted_revision_key
          WHERE l.detail_id=d.detail_id AND l.stage_code='membership');
  ELSE
    IF NOT (mdf_material_is_mdf(OLD.material_name) AND NOT mdf_material_is_mdf(NEW.material_name)) THEN RETURN NEW; END IF;
    SELECT count(DISTINCT d.detail_id) INTO affected FROM order_details d
      LEFT JOIN sheet_material_types mt ON mt.sheet_material_type_id=d.sheet_material_type_id
      WHERE d.material_id = OLD.material_id AND mt.sheet_material_type_id IS NULL AND NOT d.delete_flag
        AND EXISTS (SELECT 1 FROM mdf_evidence_lines l JOIN mdf_source_heads h ON h.source_kind=l.source_kind
          AND h.source_id=l.source_id AND l.revision_key=h.accepted_revision_key
          WHERE l.detail_id=d.detail_id AND l.stage_code='membership');
  END IF;
  IF affected > 0 THEN
    RAISE EXCEPTION 'MDF_CATALOG_CHANGE_AFFECTS_PRODUCTION' USING ERRCODE='23514',
      DETAIL=format('%s detail(s) on MDF board cards would stop being MDF', affected);
  END IF;
  RETURN NEW;
END $$;
DO $$
BEGIN
  IF to_regclass(format('%I.sheet_material_types', current_schema())) IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS mdf_catalog_classification_guard ON sheet_material_types';
    EXECUTE 'CREATE TRIGGER mdf_catalog_classification_guard BEFORE UPDATE OF name ON sheet_material_types '
      || 'FOR EACH ROW EXECUTE FUNCTION mdf_guard_catalog_classification()';
  END IF;
  IF to_regclass(format('%I.materials', current_schema())) IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS mdf_catalog_classification_guard ON materials';
    EXECUTE 'CREATE TRIGGER mdf_catalog_classification_guard BEFORE UPDATE OF material_name ON materials '
      || 'FOR EACH ROW EXECUTE FUNCTION mdf_guard_catalog_classification()';
  END IF;
END $$;
