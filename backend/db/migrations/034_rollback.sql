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

-- 6. Drop the post-034 header constraint and restore the Variant-A XOR check (idempotent).
ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_material_id_null;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_orders_sheet_xor_material'
      AND conrelid = 'orders'::regclass
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT chk_orders_sheet_xor_material
      CHECK (sheet_material_type_id IS NULL OR material_id IS NULL)
      NOT VALID;
  END IF;
END$$;

-- 7. Restore the 030 trigger (shadow pairing on order_details INSERT/UPDATE).
--    Migration 034 dropped assert_order_detail_shadow_pairing() + its trigger binding.
--    Recreate the function first, then the trigger (idempotent via OR REPLACE / IF NOT EXISTS).
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'order_detail_shadow_pairing'
      AND tgrelid = 'order_details'::regclass
  ) THEN
    CREATE TRIGGER order_detail_shadow_pairing
      BEFORE INSERT OR UPDATE ON order_details
      FOR EACH ROW EXECUTE FUNCTION assert_order_detail_shadow_pairing();
  END IF;
END$$;

-- 8. Restore the 029-era COALESCE-based views (material_id OR sheet lookup).
--    Dependency order: order_details_view first (no deps), then orders_view,
--    doweling_orders_view, orders_alias_view, details_of_order.

--    order_details_view: COALESCE(m.material_name, smt.name) AS material_name
--    Source: migration 029 (latest pre-034 definition).
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

--    orders_view: header material_name = COALESCE(sheet, material).
--    Source: migration 029 (latest pre-034 definition, verbatim column list).
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

--    doweling_orders_view: restore pre-034 legacy form (m.material_name via orders.material_id).
--    Source: postgresql_schema_v_14.sql §3658 (latest pre-034 definition — 034 was first to add sheet join).
CREATE OR REPLACE VIEW doweling_orders_view AS
SELECT
    d.doweling_order_id,
    d.doweling_order_name,
    odl.order_id,
    ord.order_name,
    ord.client_id,
    c.client_name,
    d.doweling_order_date,
    ps.payment_status_name,
    pr.production_status_name,
    d.issue_date,
    d.total_amount,
    d.final_amount,
    d.discount,
    d.surcharge,
    d.paid_amount,
    d.payment_date,
    d.parts_count,
    mt.milling_type_name,
    et.edge_type_name,
    m.material_name,
    d.design_engineer_id,
    emd.full_name AS design_engineer,
    d.operator_id,
    emo.full_name AS operator,
    d.link_cad_file,
    d.link_pdf_file,
    d.version,
    d.ref_key_1c AS order_ref_key_1c,
    c.ref_key_1c AS client_ref_key_1c,
    d.created_by,
    d.edited_by,
    d.created_at,
    d.updated_at
FROM doweling_orders d
LEFT JOIN order_doweling_links odl ON d.doweling_order_id = odl.doweling_order_id
LEFT JOIN orders          ord ON odl.order_id = ord.order_id
LEFT JOIN clients          c  ON ord.client_id = c.client_id
LEFT JOIN payment_statuses ps ON d.payment_status_id = ps.payment_status_id
LEFT JOIN production_statuses pr ON d.production_status_id = pr.production_status_id
LEFT JOIN milling_types    mt ON ord.milling_type_id = mt.milling_type_id
LEFT JOIN edge_types       et ON ord.edge_type_id = et.edge_type_id
LEFT JOIN materials        m  ON ord.material_id = m.material_id
LEFT JOIN employees        emd ON d.design_engineer_id = emd.employee_id
LEFT JOIN employees        emo ON d.operator_id = emo.employee_id
WHERE d.delete_flag = false
ORDER BY d.doweling_order_id DESC;

COMMENT ON VIEW doweling_orders_view IS 'Агрегированное представление заказов присадки с audit-полями для UI';

--    orders_alias_view: restore pre-034 legacy form (m.material_name, Russian-quoted columns).
--    Source: postgresql_schema_v_14.sql §3564 (latest pre-034 definition — 034 was first to add sheet join).
CREATE OR REPLACE VIEW orders_alias_view AS
SELECT
    o.order_id                                      AS "Id заказа",
    o.order_name                                    AS "Имя заказа",
    c.client_name                                   AS "Имя клиента",
    to_char(o.order_date, 'DD-MM-YYYY')             AS "Дата заказа",
    o.priority                                      AS "Приоритет заказа",
    to_char(o.completion_date, 'DD-MM-YYYY')        AS "Дата готовности",
    to_char(o.planned_completion_date,'DD-MM-YYYY') AS "Планируемая дата готовности",
    os.order_status_name                            AS "Статус заказа",
    ps.payment_status_name                          AS "Статус оплаты заказа",
    to_char(o.issue_date, 'DD-MM-YYYY')             AS "Дата выдачи заказа",
    o.total_amount                                  AS "Сумма стоимости заказа",
    o.final_amount                                  AS "Сумма с учетом скидки",
    o.discount                                      AS "Сумма скидки",
    o.surcharge                                     AS "Сумма наценки",
    o.paid_amount                                   AS "Сумма оплаты заказа",
    to_char(o.payment_date, 'DD-MM-YYYY')           AS "Дата оплаты заказа",
    o.parts_count                                   AS "Количество деталей",
    o.total_area                                    AS "Сумма площади заказа",
    mt.milling_type_name                            AS "Тип фрезеровки",
    et.edge_type_name                               AS "Тип обката",
    f.film_name                                     AS "Имя пленки",
    m.material_name                                 AS "Имя материала",
    o.link_cutting_file                             AS "Ссылка на файл раскроя",
    o.link_cutting_image_file                       AS "Ссылка на файл картинки раскроя",
    o.ref_key_1c                                    AS "Ref_Key_1C заказа",
    c.ref_key_1c                                    AS "Ref_Key_1C клиента",
    o.manager_id                                    AS "ID менеджера",
    o.created_by                                    AS "ID создавшего",
    o.edited_by                                     AS "ID редактировавшего",
    to_char(o.created_at, 'DD-MM-YYYY HH24:MI:SS')  AS "Дата создания",
    to_char(o.updated_at, 'DD-MM-YYYY HH24:MI:SS')  AS "Дата изменения"
FROM orders o
LEFT JOIN clients          c  ON o.client_id = c.client_id
LEFT JOIN order_statuses   os ON o.order_status_id = os.order_status_id
LEFT JOIN payment_statuses ps ON o.payment_status_id = ps.payment_status_id
LEFT JOIN milling_types    mt ON o.milling_type_id = mt.milling_type_id
LEFT JOIN edge_types       et ON o.edge_type_id = et.edge_type_id
LEFT JOIN films            f  ON o.film_id = f.film_id
LEFT JOIN materials        m  ON o.material_id = m.material_id
WHERE o.delete_flag = false
ORDER BY o.order_id DESC;

COMMENT ON VIEW orders_alias_view IS 'Представление заказов с русскими названиями столбцов и audit-полями';

--    details_of_order: restore pre-034 legacy form (m.material_name via order_details.material_id).
--    Source: postgresql_schema_v_14.sql §3614 (latest pre-034 definition — 034 was first to add sheet join).
CREATE OR REPLACE VIEW details_of_order AS
SELECT
    od.detail_number,
    od.height,
    od.width,
    od.quantity,
    mt.milling_type_name,
    od.note,
    ord.order_name,
    od.order_id,
    od.detail_id,
    od.area,
    m.material_name,
    et.edge_type_name,
    f.film_name,
    od.milling_cost_per_sqm,
    od.detail_cost,
    od.priority,
    ps.production_status_name,
    od.joint_order_id,
    od.link_cutting_file,
    od.link_cutting_image_file,
    od.detail_name,
    od.ref_key_1c AS detail_ref_key_1c,
    od.created_by,
    od.edited_by,
    od.created_at,
    od.updated_at
FROM order_details od
LEFT JOIN orders             ord ON od.order_id = ord.order_id
LEFT JOIN materials           m  ON od.material_id = m.material_id
LEFT JOIN milling_types       mt ON od.milling_type_id = mt.milling_type_id
LEFT JOIN edge_types          et ON od.edge_type_id = et.edge_type_id
LEFT JOIN films               f  ON od.film_id = f.film_id
LEFT JOIN production_statuses ps ON od.production_status_id = ps.production_status_id
WHERE od.delete_flag = false
ORDER BY od.detail_number;

COMMENT ON VIEW details_of_order IS 'Представление деталей заказов и audit-полями';

COMMIT;
