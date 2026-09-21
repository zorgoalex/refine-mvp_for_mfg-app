-- Frozen execution inputs + compact publication. No producer or mode activation.
BEGIN;

CREATE TABLE IF NOT EXISTS mdf_revision_context (
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version=1),
  source_created_at TIMESTAMPTZ NOT NULL,
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 2000),
  prior_column TEXT CHECK (prior_column IN ('parsed','completed','completed_laminated',
    'baths','baths_ready','baths_laminated','completed_baths')),
  composition_complete BOOLEAN NOT NULL,
  demand_digest TEXT NOT NULL CHECK (demand_digest ~ '^[a-f0-9]{64}$'),
  acceptance_requested BOOLEAN NOT NULL DEFAULT false,
  predecessor_accepted_revision_key TEXT,
  predecessor_received_revision_key TEXT,
  PRIMARY KEY(source_kind,source_id,revision_key),
  FOREIGN KEY(source_kind,source_id,revision_key)
    REFERENCES mdf_evidence_revisions(source_kind,source_id,revision_key) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS mdf_revision_demand (
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  order_id BIGINT NOT NULL CHECK (order_id BETWEEN 1 AND 9007199254740991),
  detail_id BIGINT NOT NULL CHECK (detail_id BETWEEN 1 AND 9007199254740991),
  quantity BIGINT NOT NULL CHECK (quantity BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(source_kind,source_id,revision_key,detail_id),
  FOREIGN KEY(source_kind,source_id,revision_key)
    REFERENCES mdf_revision_context(source_kind,source_id,revision_key) ON DELETE RESTRICT
);

-- Context belongs to the same seal as evidence; no late attachment/promotion
-- of a diagnostic shadow receipt after its original transaction committed.
CREATE OR REPLACE FUNCTION mdf_guard_execution_context_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM mdf_evidence_revisions WHERE source_kind=NEW.source_kind
    AND source_id=NEW.source_id AND revision_key=NEW.revision_key FOR UPDATE;
  IF EXISTS (SELECT 1 FROM mdf_revision_seals WHERE source_kind=NEW.source_kind
    AND source_id=NEW.source_id AND revision_key=NEW.revision_key) THEN
    RAISE EXCEPTION 'MDF revision is sealed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mdf_context_insert_guard ON mdf_revision_context;
CREATE TRIGGER mdf_context_insert_guard BEFORE INSERT ON mdf_revision_context
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_execution_context_insert();
DROP TRIGGER IF EXISTS mdf_demand_insert_guard ON mdf_revision_demand;
CREATE TRIGGER mdf_demand_insert_guard BEFORE INSERT ON mdf_revision_demand
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_execution_context_insert();
DROP TRIGGER IF EXISTS mdf_context_immutable ON mdf_revision_context;
CREATE TRIGGER mdf_context_immutable BEFORE UPDATE OR DELETE ON mdf_revision_context
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();
DROP TRIGGER IF EXISTS mdf_demand_immutable ON mdf_revision_demand;
CREATE TRIGGER mdf_demand_immutable BEFORE UPDATE OR DELETE ON mdf_revision_demand
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();

CREATE TABLE IF NOT EXISTS mdf_published_sources (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('packet','bazisCutSet','bath')),
  source_id TEXT NOT NULL,
  received_revision_key TEXT NOT NULL,
  accepted_revision_key TEXT,
  source_created_at TIMESTAMPTZ NOT NULL,
  display_name TEXT NOT NULL,
  column_key TEXT CHECK (column_key IN ('parsed','completed','completed_laminated',
    'baths','baths_ready','baths_laminated','completed_baths')),
  reason TEXT NOT NULL,
  issues TEXT[] NOT NULL DEFAULT '{}',
  published_revision BIGINT NOT NULL CHECK (published_revision>0),
  PRIMARY KEY(source_kind,source_id),
  FOREIGN KEY(source_kind,source_id) REFERENCES mdf_source_heads(source_kind,source_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_mdf_published_source_window
  ON mdf_published_sources(source_created_at DESC,source_kind,source_id);
CREATE TABLE IF NOT EXISTS mdf_published_source_members (
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  order_id BIGINT NOT NULL,
  detail_id BIGINT NOT NULL,
  quantity BIGINT NOT NULL CHECK (quantity>0),
  PRIMARY KEY(source_kind,source_id,order_id,detail_id),
  FOREIGN KEY(source_kind,source_id) REFERENCES mdf_published_sources(source_kind,source_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_mdf_published_member_order ON mdf_published_source_members(order_id,source_kind,source_id);
CREATE TABLE IF NOT EXISTS mdf_published_positions (
  order_id BIGINT NOT NULL,
  detail_id BIGINT NOT NULL,
  required_quantity BIGINT NOT NULL CHECK (required_quantity>=0),
  cut_quantity BIGINT NOT NULL CHECK (cut_quantity>=0),
  rolled_quantity BIGINT NOT NULL CHECK (rolled_quantity>=0),
  credited_cut BIGINT NOT NULL CHECK (credited_cut>=0),
  credited_rolled BIGINT NOT NULL CHECK (credited_rolled>=0),
  remaining BIGINT NOT NULL CHECK (remaining>=0),
  issues TEXT[] NOT NULL DEFAULT '{}',
  published_revision BIGINT NOT NULL CHECK (published_revision>0),
  PRIMARY KEY(order_id,detail_id),
  CHECK (credited_cut+credited_rolled+remaining=required_quantity)
);
COMMENT ON TABLE mdf_revision_context IS
  'Immutable command-time execution context. Prior column is display continuity, not physical evidence.';
COMMENT ON TABLE mdf_revision_demand IS
  'Frozen owning MDF demand; later quantity growth cannot inherit completion. No live order-detail foreign key.';
COMMENT ON TABLE mdf_published_sources IS
  'Compact current projection. Writer publishes global revision last; reader uses one repeatable-read snapshot.';
COMMIT;
