-- Diagnostic-only background comparison. No business data backfill/cutover.
BEGIN;
CREATE TABLE IF NOT EXISTS mdf_shadow_comparisons (
  source_kind TEXT NOT NULL, source_id TEXT NOT NULL, revision_key TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('differences','blocked')),
  snapshot_at TIMESTAMPTZ NOT NULL, duration_ms INTEGER NOT NULL CHECK(duration_ms>=0),
  report JSONB NOT NULL CHECK(report @> '{"cutoverReady":false,"surface":"legacy-server-return-model"}'::jsonb),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_kind,source_id,revision_key,algorithm_version),
  FOREIGN KEY(source_kind,source_id,revision_key)
    REFERENCES mdf_shadow_observations(source_kind,source_id,revision_key) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_mdf_shadow_comparison_created ON mdf_shadow_comparisons(created_at DESC);
DROP TRIGGER IF EXISTS mdf_shadow_comparison_immutable ON mdf_shadow_comparisons;
CREATE TRIGGER mdf_shadow_comparison_immutable BEFORE UPDATE OR DELETE ON mdf_shadow_comparisons
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();
CREATE TABLE IF NOT EXISTS mdf_shadow_comparison_attempts (
  source_kind TEXT NOT NULL, source_id TEXT NOT NULL, revision_key TEXT NOT NULL,
  algorithm_version TEXT NOT NULL, attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 3),
  next_attempt_at TIMESTAMPTZ NOT NULL, error_code TEXT NOT NULL,
  PRIMARY KEY(source_kind,source_id,revision_key,algorithm_version),
  FOREIGN KEY(source_kind,source_id,revision_key)
    REFERENCES mdf_shadow_observations(source_kind,source_id,revision_key) ON DELETE RESTRICT
);
COMMENT ON TABLE mdf_shadow_comparisons IS 'Current-state server source-scope comparison, not event replay/browser parity/cutover permission. Diagnostic writes only.';
COMMIT;
