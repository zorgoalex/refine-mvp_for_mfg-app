BEGIN;

ALTER TABLE milling_types
  ADD COLUMN IF NOT EXISTS min_width_mm integer,
  ADD COLUMN IF NOT EXISTS min_height_mm integer;

ALTER TABLE milling_types
  DROP CONSTRAINT IF EXISTS chk_milling_types_min_width_mm,
  DROP CONSTRAINT IF EXISTS chk_milling_types_min_height_mm;

ALTER TABLE milling_types
  ADD CONSTRAINT chk_milling_types_min_width_mm
    CHECK (min_width_mm IS NULL OR min_width_mm > 0),
  ADD CONSTRAINT chk_milling_types_min_height_mm
    CHECK (min_height_mm IS NULL OR min_height_mm > 0);

COMMENT ON COLUMN milling_types.min_width_mm IS
  'Optional minimum detail width in millimetres for assigning this milling type';
COMMENT ON COLUMN milling_types.min_height_mm IS
  'Optional minimum detail height in millimetres for assigning this milling type';

COMMIT;
