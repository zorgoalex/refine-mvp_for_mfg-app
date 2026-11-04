-- §5.4d read-time placement: a published card stores its rank-independent placement inputs; the board
-- reader and commands combine them with the members' live production ranks. Inputs are usable only when
-- `mdf_placement_inputs_valid` holds (same rule for reader, commands and the activation gate). Rows
-- published before this migration keep NULL (reader: MDF_PLACEMENT_INPUTS_MISSING). No backfill.
BEGIN;

DO $$
BEGIN
  IF to_regclass(format('%I.%I',current_schema(),'mdf_published_sources')) IS NULL THEN
    RAISE EXCEPTION 'MDF migration 189 requires mdf_published_sources (migration 174) in schema %',current_schema();
  END IF;
END;
$$;

ALTER TABLE mdf_published_sources ADD COLUMN IF NOT EXISTS placement_inputs JSONB;
ALTER TABLE mdf_published_sources DROP CONSTRAINT IF EXISTS mdf_published_sources_placement_inputs_object;
ALTER TABLE mdf_published_sources ADD CONSTRAINT mdf_published_sources_placement_inputs_object
  CHECK (placement_inputs IS NULL OR jsonb_typeof(placement_inputs)='object');

-- Mirror of `parseMdfPlacementInputs` (domain/mdf-placement.ts). Null-safe: any missing/mistyped field,
-- unknown key, unsupported schema or revision mismatch yields false, never NULL.
CREATE OR REPLACE FUNCTION mdf_placement_inputs_valid(inputs JSONB, published_revision BIGINT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(inputs)='object'
    AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(inputs) k WHERE k NOT IN ('schemaVersion','publishedRevision',
      'kind','verified','intentionalEmpty','manual','fullCut','fullRolled','balanceBlocked','bathReadiness','priorColumn'))
    AND inputs->'schemaVersion' = '1'::jsonb
    AND jsonb_typeof(inputs->'publishedRevision')='string'
    AND inputs->>'publishedRevision' ~ '^[1-9][0-9]{0,18}$'
    AND inputs->>'publishedRevision' = published_revision::text
    AND jsonb_typeof(inputs->'kind')='string' AND inputs->>'kind' IN ('packet','bazisCutSet','bath')
    AND jsonb_typeof(inputs->'verified')='boolean'
    AND jsonb_typeof(inputs->'intentionalEmpty')='boolean'
    AND jsonb_typeof(inputs->'fullCut')='boolean'
    AND jsonb_typeof(inputs->'fullRolled')='boolean'
    AND jsonb_typeof(inputs->'balanceBlocked')='boolean'
    AND jsonb_typeof(inputs->'bathReadiness')='string' AND inputs->>'bathReadiness' IN ('ready','not_ready','unknown')
    AND (jsonb_typeof(inputs->'manual')='null' OR (jsonb_typeof(inputs->'manual')='string' AND inputs->>'manual' IN
      ('parsed','completed','completed_laminated','baths','baths_ready','baths_laminated','completed_baths')))
    AND (jsonb_typeof(inputs->'priorColumn')='null' OR (jsonb_typeof(inputs->'priorColumn')='string'
      AND inputs->>'priorColumn' IN
      ('parsed','completed','completed_laminated','baths','baths_ready','baths_laminated','completed_baths'))),
    false)
$$;

COMMENT ON COLUMN mdf_published_sources.placement_inputs IS
  'Rank-independent placement inputs bound to published_revision; column = mdfPlacement(inputs, live member ranks).';
COMMENT ON FUNCTION mdf_placement_inputs_valid(JSONB, BIGINT) IS
  'Single validity rule for read-time placement: reader, commands and the activation gate (count of false must be 0).';

COMMIT;
