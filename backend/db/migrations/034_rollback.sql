-- 034_rollback.sql — Variant B reverse rollback: restore Variant-A shadow bridge from sheet refs.
-- Idempotent: each step is guarded against double-application.
-- WARNING: this restores the Variant-A STRUCTURE (shadow bridge keyed on sheet_material_type_id),
-- NOT the original pre-SP3 legacy material identity of backfilled rows.
-- The forward path (034) is preferred; use this only for an emergency Variant-A revert.

BEGIN;

-- 1. Recreate ONE synthetic shadow per sheet type referenced by any order_detail (idempotent).
INSERT INTO materials (
  material_name,
  unit_id,
  material_type_id,
  is_active,
  is_sheet_shadow,
  shadow_of_sheet_material_type_id
)
SELECT
  s.name || ' [лист #' || s.sheet_material_type_id || ']',
  s.unit_id,
  s.material_type_id,
  true,
  true,
  s.sheet_material_type_id
FROM sheet_material_types s
WHERE EXISTS (
  SELECT 1 FROM order_details od WHERE od.sheet_material_type_id = s.sheet_material_type_id
)
  AND NOT EXISTS (
  SELECT 1 FROM materials m WHERE m.shadow_of_sheet_material_type_id = s.sheet_material_type_id
);

-- 2. Drop the post-034 sheet-only constraint before re-pointing material_id.
ALTER TABLE order_details DROP CONSTRAINT IF EXISTS chk_order_details_sheet_only;

-- 3. Re-point every sheet detail at its shadow material (idempotent: only rows with material_id IS NULL).
UPDATE order_details od
   SET material_id = sh.material_id
  FROM materials sh
 WHERE sh.shadow_of_sheet_material_type_id = od.sheet_material_type_id
   AND sh.is_sheet_shadow = true
   AND od.material_id IS NULL;

-- 4. Restore NOT NULL on order_details.material_id (Variant-A invariant).
ALTER TABLE order_details ALTER COLUMN material_id SET NOT NULL;

-- 5. Restore sheet_material_type_id to nullable (Variant-A: optional SP3 column).
ALTER TABLE order_details ALTER COLUMN sheet_material_type_id DROP NOT NULL;

-- 6. Drop the post-034 header constraint and restore the Variant-A XOR check.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_material_id_null;
ALTER TABLE orders ADD CONSTRAINT chk_orders_sheet_xor_material
  CHECK (sheet_material_type_id IS NULL OR material_id IS NULL)
  NOT VALID;

-- 7. Restore the 030 trigger (shadow pairing on order_details INSERT/UPDATE).
--    The trigger function shadow_pairing_trigger() was created by 030 and is still present
--    (we never dropped it in 034, only the trigger binding). Re-create the binding.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'order_detail_shadow_pairing'
      AND tgrelid = 'order_details'::regclass
  ) THEN
    CREATE TRIGGER order_detail_shadow_pairing
      BEFORE INSERT OR UPDATE ON order_details
      FOR EACH ROW EXECUTE FUNCTION shadow_pairing_trigger();
  END IF;
END$$;

-- 8. Restore the 029 COALESCE-based views (material_id OR sheet lookup).
--    order_details_view: COALESCE(m.material_name, smt.name) AS material_name
CREATE OR REPLACE VIEW order_details_view AS
SELECT
  od.detail_id,
  od.order_id,
  od.detail_number,
  od.detail_name,
  od.height,
  od.width,
  od.quantity,
  od.area,
  od.material_id,
  od.sheet_material_type_id,
  COALESCE(m.material_name, smt.name) AS material_name,
  od.milling_type_id,
  od.edge_type_id,
  od.film_id,
  od.milling_cost_per_sqm,
  od.detail_cost,
  od.priority,
  od.production_status_id,
  od.joint_order_id,
  od.note,
  od.link_cutting_file,
  od.link_cutting_image_file,
  od.link_cad_file,
  od.link_pdf_file,
  od.ref_key_1c
FROM order_details od
LEFT JOIN materials m ON m.material_id = od.material_id
LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
WHERE od.delete_flag = false;

COMMIT;
