-- Hybrid MDF board: a bath member's cut coverage (allocated machine-file/BASIS pieces) frozen with the publication that
-- placed the bath, so the board never mixes live allocations with an older published column. NULL = not published yet
-- (older publications and non-bath members); the board then shows "no accounting data". Placement inputs are unchanged.
BEGIN;

DO $$
BEGIN
  IF to_regclass(format('%I.%I',current_schema(),'mdf_published_source_members')) IS NULL THEN
    RAISE EXCEPTION 'MDF migration 273 requires migration 174 in schema %',current_schema();
  END IF;
END;
$$;

ALTER TABLE mdf_published_source_members ADD COLUMN IF NOT EXISTS covered_quantity BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mdf_published_member_covered_quantity_check'
    AND conrelid=to_regclass(format('%I.%I',current_schema(),'mdf_published_source_members'))) THEN
    ALTER TABLE mdf_published_source_members ADD CONSTRAINT mdf_published_member_covered_quantity_check
      CHECK (covered_quantity IS NULL OR (source_kind='bath' AND covered_quantity>=0));
  END IF;
END;
$$;

COMMIT;
