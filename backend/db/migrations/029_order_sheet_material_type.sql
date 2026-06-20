-- Migration 029: order-side sheet material link (additive, new-only)
-- Adds sheet_material_type_id to order_details and orders (header). NULL for all
-- existing rows; only NEW orders populate it. material_id is untouched (Variant A).
-- Also rebuilds orders_view so the header material name prefers the sheet name.
-- Plan: spec_erp/plans/2026-06-19-sheet-materials-SP3-orders-implementation-plan.md §13
BEGIN;

ALTER TABLE order_details
  ADD COLUMN IF NOT EXISTS sheet_material_type_id BIGINT NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS sheet_material_type_id BIGINT NULL;

-- SP3-era eligibility marker (Critic rounds 31-32). Semantics: EXISTING rows = false
-- (genuine pre-SP3 orders, stay legacy forever); FUTURE inserts = true (any order
-- created at/after this migration is SP3-era, regardless of which save path created it
-- — backend command OR legacy Hasura — so it is never falsely frozen as legacy before
-- the backend-write rollout). Implemented as: add nullable → backfill existing to false
-- → set DEFAULT true + NOT NULL. "New-only" is keyed on THIS durable marker, not on
-- "the order already has a sheet id".
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sheet_eligible BOOLEAN;
UPDATE orders SET sheet_eligible = false WHERE sheet_eligible IS NULL;
ALTER TABLE orders ALTER COLUMN sheet_eligible SET DEFAULT true;
ALTER TABLE orders ALTER COLUMN sheet_eligible SET NOT NULL;

-- Synthetic shadow bridge (Critic round 23 — decoupled from the SP2 link).
-- The order bridge for a sheet detail is ALWAYS a dedicated SYNTHETIC shadow
-- materials row, NEVER a real SP2-linked catalog row (those are read-only and
-- their unit_id/material_type_id/is_active must not be forced to track the sheet).
-- `is_sheet_shadow` flags the synthetic row; `shadow_of_sheet_material_type_id` is
-- the shadow's link to its sheet type. This is SEPARATE from the SP2 link
-- `materials.sheet_material_type_id` (which stays on real rows for cut/SP2 and is
-- left NULL on shadows, so cut's reverse-link queries never see shadows).
ALTER TABLE materials
  ADD COLUMN IF NOT EXISTS is_sheet_shadow BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE materials
  ADD COLUMN IF NOT EXISTS shadow_of_sheet_material_type_id BIGINT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_order_details_sheet_material_type') THEN
    ALTER TABLE order_details
      ADD CONSTRAINT fk_order_details_sheet_material_type
        FOREIGN KEY (sheet_material_type_id)
        REFERENCES sheet_material_types(sheet_material_type_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_sheet_material_type') THEN
    ALTER TABLE orders
      ADD CONSTRAINT fk_orders_sheet_material_type
        FOREIGN KEY (sheet_material_type_id)
        REFERENCES sheet_material_types(sheet_material_type_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_materials_shadow_of_sheet_material_type') THEN
    ALTER TABLE materials
      ADD CONSTRAINT fk_materials_shadow_of_sheet_material_type
        FOREIGN KEY (shadow_of_sheet_material_type_id)
        REFERENCES sheet_material_types(sheet_material_type_id)
        ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
  -- DB-level invariants (Critic round 26-27) — additive; all existing rows satisfy them
  -- (legacy orders: sheet id NULL; real/SP2 materials: is_sheet_shadow=false, shadow_of NULL).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_sheet_xor_material') THEN
    ALTER TABLE orders
      ADD CONSTRAINT chk_orders_sheet_xor_material
        CHECK (sheet_material_type_id IS NULL OR material_id IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_materials_shadow_flag') THEN
    ALTER TABLE materials
      ADD CONSTRAINT chk_materials_shadow_flag
        CHECK (NOT is_sheet_shadow OR shadow_of_sheet_material_type_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_materials_shadow_shape') THEN
    ALTER TABLE materials
      ADD CONSTRAINT chk_materials_shadow_shape
        CHECK (shadow_of_sheet_material_type_id IS NULL OR (is_sheet_shadow AND sheet_material_type_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_order_details_sheet_material_type_id
  ON order_details(sheet_material_type_id);
CREATE INDEX IF NOT EXISTS idx_orders_sheet_material_type_id
  ON orders(sheet_material_type_id);

-- Concurrency invariant: at most ONE synthetic shadow per sheet type, so concurrent
-- order saves cannot create duplicate shadows. Partial UNIQUE on the SHADOW link
-- (NULLs excluded). This is on shadow_of_sheet_material_type_id, NOT the SP2 link
-- sheet_material_type_id — so it never conflicts with the 7 SP2-linked real rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_materials_shadow_of_sheet_material_type_id
  ON materials(shadow_of_sheet_material_type_id) WHERE shadow_of_sheet_material_type_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_materials_shadow_of_sheet_material_type_id
  ON materials(shadow_of_sheet_material_type_id);

-- Rebuild orders_view: header material name prefers sheet name; expose the id.
-- (Column list copied VERBATIM from the CURRENT live orders_view = migration 003
-- shape PLUS ord.version added by migration 004 — do NOT drop ord.version — plus
-- the two SP3 additions: COALESCE material_name and ord.sheet_material_type_id.)
CREATE OR REPLACE VIEW orders_view AS
SELECT
    ord.order_id,
    ord.order_name,
    CASE
        WHEN order_name_digits.value = '' THEN NULL
        WHEN length(order_name_digits.value) > 10 THEN NULL
        WHEN order_name_digits.value::BIGINT > 2147483647 THEN NULL
        ELSE order_name_digits.value::INTEGER
    END AS order_name_numeric,
    ord.client_id,
    c.client_name,
    ord.order_date,
    ord.priority,
    d.doweling_order_id,
    d.doweling_order_name,
    emd.full_name AS design_engineer,
    ord.completion_date,
    ord.planned_completion_date,
    os.order_status_name,
    ps.payment_status_name,
    pr.production_status_name,
    ord.issue_date,
    ord.total_amount,
    ord.final_amount,
    ord.discount,
    ord.surcharge,
    ord.paid_amount,
    ord.payment_date,
    ord.parts_count,
    ord.total_area,
    mt.milling_type_name,
    et.edge_type_name,
    f.film_name,
    COALESCE(smt.name, m.material_name) AS material_name,
    ord.notes,
    ord.link_cutting_file,
    ord.link_cutting_image_file,
    ord.ref_key_1c AS order_ref_key_1c,
    c.ref_key_1c AS client_ref_key_1c,
    ord.manager_id,
    ord.created_by,
    ord.edited_by,
    ord.created_at,
    ord.updated_at,
    ord.version,
    ord.sheet_material_type_id
FROM orders ord
CROSS JOIN LATERAL (
    VALUES (regexp_replace(COALESCE(ord.order_name, ''), '\D', '', 'g'))
) AS order_name_digits(value)
LEFT JOIN clients c ON ord.client_id = c.client_id
LEFT JOIN doweling_orders d ON ord.order_id = d.order_id
LEFT JOIN employees emd ON d.design_engineer_id = emd.employee_id
LEFT JOIN order_statuses os ON ord.order_status_id = os.order_status_id
LEFT JOIN payment_statuses ps ON ord.payment_status_id = ps.payment_status_id
LEFT JOIN production_statuses pr ON ord.production_status_id = pr.production_status_id
LEFT JOIN milling_types mt ON ord.milling_type_id = mt.milling_type_id
LEFT JOIN edge_types et ON ord.edge_type_id = et.edge_type_id
LEFT JOIN films f ON ord.film_id = f.film_id
LEFT JOIN materials m ON ord.material_id = m.material_id
LEFT JOIN sheet_material_types smt ON ord.sheet_material_type_id = smt.sheet_material_type_id
WHERE ord.delete_flag = false
ORDER BY ord.order_id DESC;

COMMENT ON VIEW orders_view IS 'Агрегированное представление заказов с audit-полями для UI (material_name = COALESCE sheet/material)';

-- Per-DETAIL server-resolved material name view (Critic round 21). The order bridge
-- material_id for the 7 SP2-linked sheet types is a REAL materials row we must NOT
-- mutate, so its material_name can drift from the sheet type after a rename. Display
-- must show the SHEET name, resolved SERVER-SIDE keyed on sheet_material_type_id so
-- no consumer needs sheet_materials.view. Hasura-read mode selects from this view;
-- backend-read mode returns the same COALESCE in the read repo (Task 4).
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
    COALESCE(smt.name, m.material_name) AS material_name,
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
JOIN orders ord ON ord.order_id = od.order_id AND ord.delete_flag = false
LEFT JOIN materials m ON m.material_id = od.material_id
LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
WHERE od.delete_flag = false;

COMMENT ON VIEW order_details_view IS 'Order details with server-resolved material_name = COALESCE(sheet, material); read-side, no sheet_materials.view needed';

COMMIT;
