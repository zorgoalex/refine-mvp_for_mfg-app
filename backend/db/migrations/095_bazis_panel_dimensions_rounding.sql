-- 095_bazis_panel_dimensions_rounding.sql
-- Normalize existing Bazis panel dimensions to whole millimetres and keep all
-- future imports on the same half-up contract (< .5 down, >= .5 up).

UPDATE bazis_nodes
SET length_mm = round(length_mm),
    width_mm = round(width_mm)
WHERE object_type = 'Панель'
  AND (
    length_mm IS DISTINCT FROM round(length_mm)
    OR width_mm IS DISTINCT FROM round(width_mm)
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_bazis_panel_dimensions_integer'
      AND conrelid = 'bazis_nodes'::regclass
  ) THEN
    ALTER TABLE bazis_nodes
      ADD CONSTRAINT chk_bazis_panel_dimensions_integer
      CHECK (
        object_type IS DISTINCT FROM 'Панель'
        OR (
          (length_mm IS NULL OR length_mm = round(length_mm))
          AND (width_mm IS NULL OR width_mm = round(width_mm))
        )
      ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE bazis_nodes
  VALIDATE CONSTRAINT chk_bazis_panel_dimensions_integer;
