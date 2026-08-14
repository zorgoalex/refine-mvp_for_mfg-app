-- 128_order_detail_hdf_parameter_override.sql
-- Per-order-detail override for the HDF calculation parameter inherited from milling resources.

BEGIN;

ALTER TABLE order_details
  ADD COLUMN IF NOT EXISTS hdf_parameter_override_mm NUMERIC(10,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_order_details_hdf_parameter_override_mm'
      AND conrelid = 'public.order_details'::regclass
  ) THEN
    ALTER TABLE order_details
      ADD CONSTRAINT chk_order_details_hdf_parameter_override_mm
      CHECK (hdf_parameter_override_mm IS NULL OR hdf_parameter_override_mm > 0);
  END IF;
END $$;

COMMENT ON COLUMN order_details.hdf_parameter_override_mm IS
  'Optional per-detail override for the HDF calculation parameter in millimeters; NULL uses milling resource/default.';

UPDATE milling_type_extra_resources
   SET parameter_name = 'Параметр',
       updated_at = now()
 WHERE hdf_auto_enabled = true
   AND parameter_name = 'Отступ от края';

COMMIT;
