-- Migration 030: DB-boundary guard for the SP3 Variant-A shadow bridge.
-- Tier2 critic BLOCKER [DATA-INTEGRITY/HASURA-BOUNDARY]: nothing structurally forbade an
-- order_details row from pointing material_id at a hidden sheet-shadow material while
-- sheet_material_type_id IS NULL (a sheet material disguised as legacy). The backend
-- command path now rejects this (anti-injection on every save), but a direct Hasura/raw
-- GraphQL write bypassed the app entirely. This trigger closes the gap at the DB so EVERY
-- writer is covered.
--
-- Rule (shadow side of Variant-A pairing): if order_details.material_id references a
-- materials row with is_sheet_shadow=true, then sheet_material_type_id MUST be non-null
-- and equal that shadow's shadow_of_sheet_material_type_id. Legacy rows (non-shadow
-- material_id) are untouched. Additive + idempotent + reversible (down section below).
-- Plan: spec_erp/plans/2026-06-19-sheet-materials-SP3-orders-implementation-plan.md
-- (tier2 critic remediation, finding 1).
BEGIN;

CREATE OR REPLACE FUNCTION assert_order_detail_shadow_pairing()
RETURNS trigger AS $$
DECLARE
  v_is_shadow BOOLEAN;
  v_shadow_of BIGINT;
BEGIN
  IF NEW.material_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT is_sheet_shadow, shadow_of_sheet_material_type_id
    INTO v_is_shadow, v_shadow_of
    FROM materials
   WHERE material_id = NEW.material_id;

  -- Only shadow materials are constrained; legacy (non-shadow) material_ids pass through.
  IF v_is_shadow IS TRUE THEN
    IF NEW.sheet_material_type_id IS NULL
       OR v_shadow_of IS NULL
       OR NEW.sheet_material_type_id <> v_shadow_of THEN
      RAISE EXCEPTION
        'order_details.material_id % is a hidden sheet shadow; sheet_material_type_id must equal % (got %)',
        NEW.material_id, v_shadow_of, NEW.sheet_material_type_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_detail_shadow_pairing ON order_details;
CREATE TRIGGER trg_order_detail_shadow_pairing
  BEFORE INSERT OR UPDATE OF material_id, sheet_material_type_id ON order_details
  FOR EACH ROW
  EXECUTE FUNCTION assert_order_detail_shadow_pairing();

COMMIT;

-- Rollback (operator window):
--   DROP TRIGGER IF EXISTS trg_order_detail_shadow_pairing ON order_details;
--   DROP FUNCTION IF EXISTS assert_order_detail_shadow_pairing();
