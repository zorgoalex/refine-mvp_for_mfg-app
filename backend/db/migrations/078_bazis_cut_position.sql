-- 078_bazis_cut_position.sql
-- Build frozen cutting positions from ERP Basis product/detail designations.

BEGIN;

ALTER TABLE bazis_cut_set_details
  DROP CONSTRAINT IF EXISTS chk_bazis_cut_set_details_position;

ALTER TABLE bazis_cut_set_details
  ALTER COLUMN position TYPE TEXT;

UPDATE bazis_cut_set_details AS snapshot
SET position = CASE
  WHEN NULLIF(btrim(COALESCE(source.basis_product, '')), '') IS NULL
    AND NULLIF(btrim(COALESCE(source.basis_designation, '')), '') IS NULL
    THEN ''
  ELSE COALESCE(NULLIF(btrim(source.basis_product), ''), '')
    || '.'
    || COALESCE(NULLIF(btrim(source.basis_designation), ''), '')
END
FROM order_details AS source
WHERE snapshot.source_order_detail_id = source.detail_id;

COMMIT;
