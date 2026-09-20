-- Explicit command provenance only. No acceptance, allocation, status or backfill.
BEGIN;
CREATE TABLE IF NOT EXISTS mdf_shadow_commands (
  observation_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('packet','bazisCutSet','bath')),
  source_id TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  command_kind TEXT NOT NULL CHECK(command_kind IN ('manual_move','manual_clear','production_return')),
  target_column TEXT,
  audit_event_id UUID NOT NULL UNIQUE,
  composition_digest TEXT NOT NULL CHECK(composition_digest ~ '^[a-f0-9]{64}$'),
  target_stage_id BIGINT,
  target_stage_code TEXT,
  preview_digest TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_kind,source_id,revision_key),
  FOREIGN KEY(source_kind,source_id,revision_key)
    REFERENCES mdf_revision_seals(source_kind,source_id,revision_key) ON DELETE RESTRICT,
  CHECK ((command_kind='manual_clear' AND target_column IS NULL) OR
    (command_kind<>'manual_clear' AND target_column IS NOT NULL AND
      ((source_kind='bath' AND target_column IN ('baths','baths_ready','baths_laminated','completed_baths')) OR
       (source_kind IN ('packet','bazisCutSet') AND target_column IN ('parsed','completed','completed_laminated'))))),
  CHECK ((command_kind='production_return' AND target_stage_id IS NOT NULL AND target_stage_id>0
    AND target_stage_code IS NOT NULL AND length(btrim(target_stage_code)) BETWEEN 1 AND 240
    AND preview_digest IS NOT NULL AND preview_digest ~ '^[a-f0-9]{64}$'
    AND target_column NOT IN ('completed_baths','completed_laminated')) OR
    (command_kind<>'production_return' AND target_stage_id IS NULL AND target_stage_code IS NULL AND preview_digest IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_mdf_shadow_commands_source ON mdf_shadow_commands(source_kind,source_id,observation_id);
DROP TRIGGER IF EXISTS mdf_shadow_commands_immutable ON mdf_shadow_commands;
CREATE TRIGGER mdf_shadow_commands_immutable BEFORE UPDATE OR DELETE ON mdf_shadow_commands
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();
COMMENT ON TABLE mdf_shadow_commands IS
  'Unaccepted explicit command observations. Source-local append order, frozen membership in receipt lines, actor/request in revisions. Clear is visual-only; return is explicit correction intent. Audit UUID intentionally has no retention-coupled FK. Not accepted evidence or replay-ready baseline.';
COMMIT;
