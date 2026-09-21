-- Command placement is immutable intent, never physical production evidence.
-- Additive only: old sealed revisions keep NULL, no historical acceptance.
BEGIN;
ALTER TABLE mdf_revision_context
  ADD COLUMN IF NOT EXISTS manual_placement_column TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='mdf_revision_context'::regclass
    AND conname='mdf_context_manual_placement_check') THEN
    ALTER TABLE mdf_revision_context ADD CONSTRAINT mdf_context_manual_placement_check CHECK (
      manual_placement_column IS NULL OR
      (source_kind IN ('packet','bazisCutSet') AND manual_placement_column IN ('parsed','completed','completed_laminated')) OR
      (source_kind='bath' AND manual_placement_column IN ('baths','baths_ready','baths_laminated','completed_baths'))
    );
  END IF;
END $$;
COMMENT ON COLUMN mdf_revision_context.manual_placement_column IS
  'Explicit command placement; NULL clears override. Covered by seal/digest. Does not manufacture or revoke physical quantities.';
CREATE TABLE IF NOT EXISTS mdf_manual_command_results (
  actor_user_id BIGINT NOT NULL CHECK(actor_user_id>0),
  command_key TEXT NOT NULL CHECK(length(command_key) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('packet','bazisCutSet','bath')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 240),
  order_ids BIGINT[] NOT NULL CHECK(cardinality(order_ids) BETWEEN 1 AND 100),
  response JSONB NOT NULL CHECK(jsonb_typeof(response)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_user_id,command_key)
);
DROP TRIGGER IF EXISTS mdf_manual_command_result_immutable ON mdf_manual_command_results;
CREATE TRIGGER mdf_manual_command_result_immutable BEFORE UPDATE OR DELETE ON mdf_manual_command_results
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();
COMMIT;
