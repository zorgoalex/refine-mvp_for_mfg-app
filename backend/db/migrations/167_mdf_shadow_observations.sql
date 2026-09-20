-- Diagnostic intake only. Nothing here changes board columns or accepts facts.
BEGIN;
CREATE TABLE IF NOT EXISTS mdf_shadow_observations (
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  issues TEXT[] NOT NULL DEFAULT '{}',
  candidate_quantities JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_kind,source_id,revision_key),
  FOREIGN KEY(source_kind,source_id,revision_key)
    REFERENCES mdf_revision_seals(source_kind,source_id,revision_key) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_mdf_shadow_created ON mdf_shadow_observations(created_at DESC);
DROP TRIGGER IF EXISTS mdf_shadow_immutable ON mdf_shadow_observations;
CREATE TRIGGER mdf_shadow_immutable BEFORE UPDATE OR DELETE ON mdf_shadow_observations
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();
COMMENT ON TABLE mdf_shadow_observations IS
  'Unaccepted command-scoped candidate quantities. Not a board parity comparison or production truth; join revision for actor/request/cause and lines for order/detail dimensions.';
COMMIT;
