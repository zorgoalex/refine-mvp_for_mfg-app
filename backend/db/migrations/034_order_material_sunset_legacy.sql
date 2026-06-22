BEGIN;
-- Migration 034: sunset the legacy order material link (Variant B).
-- Orders reference their material ONLY via sheet_material_type_id. material_id
-- becomes nullable and is set NULL on every order row; synthetic shadow rows are
-- deleted; the 030 pairing trigger and the orders XOR check are dropped and
-- replaced by sheet-only invariants. Idempotent + re-runnable (go-live restore).
-- Decisions: spec_erp/plans/2026-06-21-sheet-materials-variant-b-plan.md (locked).

-- 0) In-chain conversion (Critic R12 B1). The committed manifest migration
--    `033_order_material_conversion_map.sql` runs FIRST in the numeric chain and
--    creates+seeds `sheet_material_conversion_map`. 034 FAILS CLOSED if it is absent
--    (proves chain order; no out-of-band step), then creates target types from the
--    manifest, maps legacy material_id -> sheet type, converts details/headers, and
--    aborts on anything unmapped.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sheet_material_conversion_map') THEN
    RAISE EXCEPTION 'Variant B abort: migration 033 (conversion manifest) not applied; run the chain in order.';
  END IF;
END $$;

-- 0.0a) Cuttability marker. is_cuttable defaults true = cuttable panel; set false for
--       non-panel target types BELOW (before _matmap/convert/guards read it).
ALTER TABLE sheet_material_types
  ADD COLUMN IF NOT EXISTS is_cuttable BOOLEAN NOT NULL DEFAULT true;

-- 0.0b) The conversion mapping comes from a COMMITTED manifest table
--       `sheet_material_conversion_map` seeded by `033_order_material_conversion_map.sql`
--       (Critic R9 B1: NO operator-side SQL edits during the cutover window — the
--       manifest is reviewed + committed, and proven zero-unmapped on the
--       restore-rehearsal before go-live). Each row is (legacy_material_id OR
--       legacy_material_name) -> target_sheet_name + is_cuttable. SP2-linked real
--       materials are auto-derived (a) and need no manifest row.
--       Create target sheet types declared by the manifest (placeholder dims; the
--       operator refines panel dims later via the SP1 UI). Non-cuttable targets get
--       is_cuttable=false here, before any guard.
-- 0.0a2) Adopt conversion_key on any pre-existing target type by NAME ONCE, so a type
--        created by a prior pre-key run is keyed before we match by key below. Abort if
--        a name maps to a target_key already held by a DIFFERENT row (drift — Critic R22 B1).
UPDATE sheet_material_types s
   SET conversion_key = mk.target_key
  FROM (SELECT DISTINCT target_key, target_sheet_name FROM sheet_material_conversion_map) mk
 WHERE s.conversion_key IS NULL AND s.name = mk.target_sheet_name;

-- create target types BY conversion_key (immutable identity), not by mutable name:
INSERT INTO sheet_material_types (name, unit_id, material_type_id, width_mm, height_mm, thickness_mm, is_active, is_cuttable, conversion_key)
SELECT DISTINCT ON (t.target_key) t.target_sheet_name, t.target_unit_id, t.target_material_type_id,
       t.target_width_mm, t.target_height_mm, t.target_thickness_mm, true, t.is_cuttable, t.target_key
FROM sheet_material_conversion_map t
WHERE NOT EXISTS (SELECT 1 FROM sheet_material_types s WHERE s.conversion_key = t.target_key)
ORDER BY t.target_key;
UPDATE sheet_material_types s SET is_cuttable = false
 WHERE s.conversion_key IN (SELECT target_key FROM sheet_material_conversion_map WHERE is_cuttable = false)
   AND s.is_cuttable = true;

-- 0.0b2) STRUCTURAL attr fail-closed (Critic R15 B2 / R22 B1 / R25 B3), matched BY
--        conversion_key. Manifest owns STRUCTURAL attrs (material_type_id, unit_id,
--        is_cuttable) — abort on mismatch. NAME is an operator-editable DISPLAY value
--        (SP1 UI): do NOT abort on a rename (`s.name` is intentionally NOT checked — the
--        immutable identity is conversion_key, so a rename between rehearsal and go-live
--        must NOT brick the rerun). DIMS are NOT asserted (operator-refined via SP1).
DO $$
DECLARE v_bad BIGINT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM (SELECT target_key, bool_and(is_cuttable) ic,
               min(target_material_type_id) mt, min(target_unit_id) u
          FROM sheet_material_conversion_map GROUP BY target_key) t
  JOIN sheet_material_types s ON s.conversion_key = t.target_key
  WHERE s.material_type_id <> t.mt OR s.unit_id <> t.u OR s.is_cuttable <> t.ic;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Variant B abort: % target type(s) have structural attrs differing from the manifest; reconcile 033_order_material_conversion_map.sql or the type.', v_bad;
  END IF;
END $$;

-- 0.0c) Build the runtime map from (a) SP2 auto-derive + (b) manifest-by-id +
--       (c) manifest-by-name — targets resolved BY conversion_key (immutable), never name.
CREATE TEMP TABLE _matmap ON COMMIT DROP AS
SELECT m.material_id AS mid, m.sheet_material_type_id AS sid                       -- (a) SP2
  FROM materials m
 WHERE m.is_sheet_shadow = false AND m.sheet_material_type_id IS NOT NULL
UNION
SELECT cm.legacy_material_id, s.sheet_material_type_id                            -- (b) manifest by id
  FROM sheet_material_conversion_map cm
  JOIN sheet_material_types s ON s.conversion_key = cm.target_key
 WHERE cm.legacy_material_id IS NOT NULL
UNION
SELECT m.material_id, s.sheet_material_type_id                                    -- (c) manifest by name
  FROM sheet_material_conversion_map cm
  JOIN materials m ON m.material_name = cm.legacy_material_name AND NOT m.is_sheet_shadow
  JOIN sheet_material_types s ON s.conversion_key = cm.target_key
 WHERE cm.legacy_material_name IS NOT NULL;

-- 0c0) Map uniqueness guard (Critic R11 B1): the same legacy material_id could enter
--      _matmap from (a) SP2, (b) manifest-by-id, and (c) manifest-by-name with
--      DIFFERENT target sids; `UPDATE ... FROM _matmap` would then non-deterministically
--      canonize whichever the planner picks. Abort if any mid maps to >1 distinct sid.
DO $$
DECLARE v_ambig BIGINT;
BEGIN
  SELECT count(*) INTO v_ambig FROM (
    SELECT mid FROM _matmap GROUP BY mid HAVING count(DISTINCT sid) > 1
  ) q;
  IF v_ambig > 0 THEN
    RAISE EXCEPTION 'Variant B abort: % legacy material_id(s) map to multiple sheet types; fix 033_order_material_conversion_map.sql.', v_ambig;
  END IF;
END $$;

-- 0a) Convert ALL still-legacy details/headers using the map — INCLUDING soft-deleted
--     rows (Critic R2 B1): step 5 sets sheet_material_type_id NOT NULL for the whole
--     table and step 2 nulls material_id, so deleted history must also resolve.
UPDATE order_details od
   SET sheet_material_type_id = mm.sid
  FROM _matmap mm
 WHERE od.sheet_material_type_id IS NULL
   AND od.material_id = mm.mid;

UPDATE orders o
   SET sheet_material_type_id = COALESCE(o.sheet_material_type_id, mm.sid)
  FROM _matmap mm
 WHERE o.sheet_material_type_id IS NULL
   AND o.material_id = mm.mid;

-- 0b) Abort if ANY order detail (live OR soft-deleted) is still unmapped — every
--     detail must carry a sheet type before step 5 sets NOT NULL.
DO $$
DECLARE v_unmapped BIGINT;
BEGIN
  SELECT count(*) INTO v_unmapped FROM order_details od WHERE od.sheet_material_type_id IS NULL;
  IF v_unmapped > 0 THEN
    RAISE EXCEPTION
      'Variant B abort: % order_details (incl. soft-deleted) have no sheet_material_type_id; add the material to 033_order_material_conversion_map.sql (committed) and re-run.', v_unmapped;
  END IF;
END $$;

-- 0c) Header guard: a header still carrying material_id with NO sheet is an UNMAPPED
--     legacy material that step 2 would silently drop. Abort so the operator maps it
--     (add a manifest row in 033_order_material_conversion_map.sql) — never discarded.
DO $$
DECLARE v_unmapped_hdr BIGINT;
BEGIN
  SELECT count(*) INTO v_unmapped_hdr
  FROM orders o
  WHERE o.material_id IS NOT NULL AND o.sheet_material_type_id IS NULL;
  IF v_unmapped_hdr > 0 THEN
    RAISE EXCEPTION
      'Variant B abort: % orders have an unmapped header material_id; add it to 033_order_material_conversion_map.sql (committed) and re-run.', v_unmapped_hdr;
  END IF;
END $$;

-- 0c2) Dual-populated guard (Critic R10 B1): a row carrying BOTH material_id AND
--      sheet_material_type_id (e.g. a malformed/Hasura-written row) is NOT touched by
--      0a (which only fills NULL sheet ids) but step 2 will null its material_id. If
--      that material_id maps (via _matmap) to a DIFFERENT sheet than the row already
--      has, nulling it would silently canonize a wrong sheet id. Abort on any mismatch
--      (details AND headers, incl. soft-deleted).
DO $$
DECLARE v_dd BIGINT; v_dh BIGINT;
BEGIN
  SELECT count(*) INTO v_dd
  FROM order_details od JOIN _matmap mm ON mm.mid = od.material_id
  WHERE od.material_id IS NOT NULL AND od.sheet_material_type_id IS NOT NULL
    AND od.sheet_material_type_id <> mm.sid;
  SELECT count(*) INTO v_dh
  FROM orders o JOIN _matmap mm ON mm.mid = o.material_id
  WHERE o.material_id IS NOT NULL AND o.sheet_material_type_id IS NOT NULL
    AND o.sheet_material_type_id <> mm.sid;
  IF (v_dd + v_dh) > 0 THEN
    RAISE EXCEPTION
      'Variant B abort: % details + % headers have material_id mapping to a DIFFERENT sheet than their existing sheet_material_type_id (dual-populated mismatch).', v_dd, v_dh;
  END IF;
END $$;

-- 0d) Mark EVERY order SP3-era (Critic R4 B1 / R9 B2). Under sunset every order is
--     sheet-capable, and the FE drops the sheet_eligible gate. A blank/headerless
--     order left at sheet_eligible=false would show the picker yet 422 on save
--     (backend assertSheetEligibilityAndNoClear). So flip ALL non-deleted orders to
--     true; verify zero remain false (Task 2 / verify.sql).
UPDATE orders o SET sheet_eligible = true
 WHERE o.delete_flag = false AND o.sheet_eligible = false;

-- 0e) Abort if any order DETAIL resolves to a NON-cuttable sheet type (Critic R6 B2)
--     — such a detail would become falsely /cut-eligible. Non-cuttable types are
--     header-only legacy materials (e.g. paint); a detail must never carry one.
DO $$
DECLARE v_nc BIGINT;
BEGIN
  SELECT count(*) INTO v_nc
  FROM order_details od
  JOIN sheet_material_types s ON s.sheet_material_type_id = od.sheet_material_type_id
  WHERE s.is_cuttable = false;
  IF v_nc > 0 THEN
    RAISE EXCEPTION
      'Variant B abort: % order_details map to a NON-cuttable sheet type; non-cuttable materials may only sit on headers.', v_nc;
  END IF;
END $$;

-- 1) make material_id nullable (FK stays; orphaned ref allowed since we null it).
ALTER TABLE order_details ALTER COLUMN material_id DROP NOT NULL;

-- 2) null out material_id on EVERY order row (orders + order_details), severing
--    the legacy/shadow link. Includes soft-deleted rows so nothing references a
--    shadow we are about to delete.
UPDATE order_details SET material_id = NULL WHERE material_id IS NOT NULL;
UPDATE orders        SET material_id = NULL WHERE material_id IS NOT NULL;

-- 3) drop the 030 DB-boundary pairing trigger + function (its premise is gone).
DROP TRIGGER IF EXISTS trg_order_detail_shadow_pairing ON order_details;
DROP FUNCTION IF EXISTS assert_order_detail_shadow_pairing();

-- 4) delete the now-orphaned synthetic shadow rows (hard delete).
--    4a) GUARD (Critic R5 B2 / R27 B1): `materials` has FK referrers BEYOND orders/
--        order_details. A leaked shadow ref in ANY of them would either abort the DELETE
--        (ON DELETE RESTRICT) or — worse — be SILENTLY cascade-deleted (e.g.
--        `sheet_material_links` is ON DELETE CASCADE). Do NOT hard-code the referrer list
--        (it missed `sheet_material_links`): DERIVE every table that FKs into materials
--        from pg_constraint, count shadow-referencing rows per table, and abort if any > 0.
DO $$
DECLARE
  r RECORD; v_n BIGINT; v_total BIGINT := 0; v_msg TEXT := '';
BEGIN
  FOR r IN
    SELECT con.conrelid::regclass::text AS tbl, att.attname AS col
    FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.confrelid = 'materials'::regclass
      AND con.conrelid <> 'order_details'::regclass
      AND con.conrelid <> 'orders'::regclass
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %s x JOIN materials m ON m.material_id = x.%I WHERE m.is_sheet_shadow',
      r.tbl, r.col) INTO v_n;
    IF v_n > 0 THEN
      v_total := v_total + v_n;
      v_msg := v_msg || format('%s.%s=%s ', r.tbl, r.col, v_n);
    END IF;
  END LOOP;
  IF v_total > 0 THEN
    RAISE EXCEPTION 'Variant B abort: shadow materials still referenced by FK tables: %. Resolve before delete.', v_msg;
  END IF;
END $$;

DELETE FROM materials WHERE is_sheet_shadow = true;

-- 5) swap invariants.
--    orders: replace XOR (material_id-or-sheet) with material_id-must-be-null.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_sheet_xor_material;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_material_id_null') THEN
    ALTER TABLE orders
      ADD CONSTRAINT chk_orders_material_id_null CHECK (material_id IS NULL);
  END IF;
END $$;

--    order_details: every live detail now carries a sheet type and no material_id.
ALTER TABLE order_details ALTER COLUMN sheet_material_type_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_order_details_sheet_only') THEN
    ALTER TABLE order_details
      ADD CONSTRAINT chk_order_details_sheet_only CHECK (material_id IS NULL);
  END IF;
END $$;

-- 6) rebuild views: material name = sheet name only (no materials fallback).
--    order_details_view: drop the LEFT JOIN materials + COALESCE.
CREATE OR REPLACE VIEW order_details_view AS
SELECT
    od.detail_id, od.order_id, od.detail_number, od.detail_name,
    od.height, od.width, od.quantity, od.area,
    od.material_id, od.sheet_material_type_id,
    smt.name AS material_name,
    od.milling_type_id, od.edge_type_id, od.film_id,
    od.milling_cost_per_sqm, od.detail_cost, od.priority,
    od.production_status_id, od.joint_order_id, od.note,
    od.link_cutting_file, od.link_cutting_image_file, od.link_cad_file,
    od.link_pdf_file, od.ref_key_1c
FROM order_details od
JOIN orders ord ON ord.order_id = od.order_id AND ord.delete_flag = false
LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
WHERE od.delete_flag = false;
COMMENT ON VIEW order_details_view IS 'Order details with material_name = sheet_material_types.name (Variant B, sheet-only)';

--    orders_view: header material name = sheet name only. Column list copied
--    VERBATIM from migration 029 minus the materials join/COALESCE fallback.
CREATE OR REPLACE VIEW orders_view AS
SELECT
    ord.order_id, ord.order_name,
    CASE
        WHEN order_name_digits.value = '' THEN NULL
        WHEN length(order_name_digits.value) > 10 THEN NULL
        WHEN order_name_digits.value::BIGINT > 2147483647 THEN NULL
        ELSE order_name_digits.value::INTEGER
    END AS order_name_numeric,
    ord.client_id, c.client_name, ord.order_date, ord.priority,
    d.doweling_order_id, d.doweling_order_name, emd.full_name AS design_engineer,
    ord.completion_date, ord.planned_completion_date,
    os.order_status_name, ps.payment_status_name, pr.production_status_name,
    ord.issue_date, ord.total_amount, ord.final_amount, ord.discount, ord.surcharge,
    ord.paid_amount, ord.payment_date, ord.parts_count, ord.total_area,
    mt.milling_type_name, et.edge_type_name, f.film_name,
    smt.name AS material_name,
    ord.notes, ord.link_cutting_file, ord.link_cutting_image_file,
    ord.ref_key_1c AS order_ref_key_1c, c.ref_key_1c AS client_ref_key_1c,
    ord.manager_id, ord.created_by, ord.edited_by, ord.created_at, ord.updated_at,
    ord.version, ord.sheet_material_type_id
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
LEFT JOIN sheet_material_types smt ON ord.sheet_material_type_id = smt.sheet_material_type_id
WHERE ord.delete_flag = false
ORDER BY ord.order_id DESC;
COMMENT ON VIEW orders_view IS 'Orders read view; material_name = sheet_material_types.name (Variant B, sheet-only)';

-- 6b) Rebuild EVERY other tracked read view that derives an order's material name
--     via materials.material_id (Critic R6 B1) — after step 2 nulls material_id,
--     these would otherwise return NULL material names. For each, copy the column
--     list VERBATIM from spec_erp/docs/reference/postgresql_schema_v_14.sql (cited
--     line ranges) and swap the materials name source for the sheet name:
--       LEFT JOIN materials m ON <x>.material_id = m.material_id   →
--       LEFT JOIN sheet_material_types smt ON <x>.sheet_material_type_id = smt.sheet_material_type_id
--       m.material_name                                            →  smt.name
--   • doweling_orders_view  (schema §3658-…; header via ord.material_id → ord.sheet_material_type_id)
--   • orders_alias_view     (schema §3564-…; header via o.material_id   → o.sheet_material_type_id)
--   • details_of_order      (schema §3614-…; detail via od.material_id  → od.sheet_material_type_id)
--   Keep each view's exact column list/order; only the material_name expression + join change.
CREATE OR REPLACE VIEW doweling_orders_view AS
SELECT
	d.doweling_order_id, d.doweling_order_name, odl.order_id, ord.order_name,
	ord.client_id, c.client_name, d.doweling_order_date, ps.payment_status_name,
	pr.production_status_name, d.issue_date, d.total_amount, d.final_amount,
	d.discount, d.surcharge, d.paid_amount, d.payment_date, d.parts_count,
	mt.milling_type_name, et.edge_type_name,
	smt.name AS material_name,
	d.design_engineer_id, emd.full_name AS design_engineer, d.operator_id,
	emo.full_name AS operator, d.link_cad_file, d.link_pdf_file, d.version,
	d.ref_key_1c AS order_ref_key_1c, c.ref_key_1c AS client_ref_key_1c,
	d.created_by, d.edited_by, d.created_at, d.updated_at
FROM doweling_orders d
LEFT JOIN order_doweling_links odl ON d.doweling_order_id = odl.doweling_order_id
LEFT JOIN orders          ord ON odl.order_id = ord.order_id
LEFT JOIN clients          c  ON  ord.client_id = c.client_id
LEFT JOIN payment_statuses ps ON d.payment_status_id = ps.payment_status_id
LEFT JOIN production_statuses pr ON d.production_status_id = pr.production_status_id
LEFT JOIN milling_types    mt ON ord.milling_type_id = mt.milling_type_id
LEFT JOIN edge_types       et ON ord.edge_type_id = et.edge_type_id
LEFT JOIN sheet_material_types smt ON ord.sheet_material_type_id = smt.sheet_material_type_id
LEFT JOIN employees        emd  ON d.design_engineer_id = emd.employee_id
LEFT JOIN employees        emo  ON d.operator_id = emo.employee_id
WHERE d.delete_flag = false
ORDER BY d.doweling_order_id DESC;

CREATE OR REPLACE VIEW orders_alias_view AS
SELECT
    o.order_id AS "Id заказа", o.order_name AS "Имя заказа", c.client_name AS "Имя клиента",
    to_char(o.order_date, 'DD-MM-YYYY') AS "Дата заказа", o.priority AS "Приоритет заказа",
    to_char(o.completion_date, 'DD-MM-YYYY') AS "Дата готовности",
    to_char(o.planned_completion_date,'DD-MM-YYYY') AS "Планируемая дата готовности",
    os.order_status_name AS "Статус заказа", ps.payment_status_name AS "Статус оплаты заказа",
    to_char(o.issue_date, 'DD-MM-YYYY') AS "Дата выдачи заказа",
    o.total_amount AS "Сумма стоимости заказа", o.final_amount AS "Сумма с учетом скидки",
    o.discount AS "Сумма скидки", o.surcharge AS "Сумма наценки",
    o.paid_amount AS "Сумма оплаты заказа", to_char(o.payment_date, 'DD-MM-YYYY') AS "Дата оплаты заказа",
    o.parts_count AS "Количество деталей", o.total_area AS "Сумма площади заказа",
    mt.milling_type_name AS "Тип фрезеровки", et.edge_type_name AS "Тип обката",
    f.film_name AS "Имя пленки",
    smt.name AS "Имя материала",
    o.link_cutting_file AS "Ссылка на файл раскроя", o.link_cutting_image_file AS "Ссылка на файл картинки раскроя",
    o.ref_key_1c AS "Ref_Key_1C заказа", c.ref_key_1c AS "Ref_Key_1C клиента",
    o.manager_id AS "ID менеджера", o.created_by AS "ID создавшего", o.edited_by AS "ID редактировавшего",
    to_char(o.created_at, 'DD-MM-YYYY HH24:MI:SS') AS "Дата создания",
    to_char(o.updated_at, 'DD-MM-YYYY HH24:MI:SS') AS "Дата изменения"
FROM orders o
LEFT JOIN clients          c  ON o.client_id = c.client_id
LEFT JOIN order_statuses   os ON o.order_status_id = os.order_status_id
LEFT JOIN payment_statuses ps ON o.payment_status_id = ps.payment_status_id
LEFT JOIN milling_types    mt ON o.milling_type_id = mt.milling_type_id
LEFT JOIN edge_types       et ON o.edge_type_id = et.edge_type_id
LEFT JOIN films            f  ON o.film_id = f.film_id
LEFT JOIN sheet_material_types smt ON o.sheet_material_type_id = smt.sheet_material_type_id
WHERE o.delete_flag = false
ORDER BY o.order_id DESC;

CREATE OR REPLACE VIEW details_of_order AS
SELECT
    od.detail_number, od.height, od.width, od.quantity, mt.milling_type_name, od.note,
    ord.order_name, od.order_id, od.detail_id, od.area,
    smt.name AS material_name,
    et.edge_type_name, f.film_name, od.milling_cost_per_sqm, od.detail_cost, od.priority,
    ps.production_status_name, od.joint_order_id, od.link_cutting_file, od.link_cutting_image_file,
    od.detail_name, od.ref_key_1c AS detail_ref_key_1c,
    od.created_by, od.edited_by, od.created_at, od.updated_at
FROM order_details od
LEFT JOIN orders             ord ON od.order_id = ord.order_id
LEFT JOIN sheet_material_types smt ON od.sheet_material_type_id = smt.sheet_material_type_id
LEFT JOIN milling_types       mt ON od.milling_type_id = mt.milling_type_id
LEFT JOIN edge_types          et ON od.edge_type_id = et.edge_type_id
LEFT JOIN films               f  ON od.film_id = f.film_id
LEFT JOIN production_statuses ps ON od.production_status_id = ps.production_status_id
WHERE od.delete_flag = false
ORDER BY od.detail_number;

-- Rollback: see backend/db/migrations/034_rollback.sql (Task 14). It does NOT "re-run
-- the SP3 backfill" (that script needs legacy material_id + NULL sheet ids, which no
-- longer exist post-034). It performs a REVERSE backfill keyed on sheet_material_type_id:
-- recreate one synthetic shadow per sheet type, set order_details.material_id to the
-- shadow, restore material_id NOT NULL + the 030 trigger + 029 CHECKs/views.
COMMIT;
