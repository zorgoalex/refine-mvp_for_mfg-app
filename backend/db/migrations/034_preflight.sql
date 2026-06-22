-- 034 PREFLIGHT (read-only): run AFTER 033 (manifest) but BEFORE 034. BOTH result
-- sets must be EMPTY; otherwise extend the COMMITTED manifest (033) and resolve any
-- leaked shadow refs, then re-run — no in-window SQL edits. `mappable` derives from
-- the SAME sources as 034's _matmap (Critic R8 B1 / R9 B1): SP2 auto-derive + the
-- manifest by id + the manifest by name. (Targets are created BY 034, so this checks
-- MAPPABILITY, not current type existence.)
WITH mappable AS (
  SELECT material_id AS mid FROM materials WHERE is_sheet_shadow = false AND sheet_material_type_id IS NOT NULL  -- (a)
  UNION SELECT legacy_material_id FROM sheet_material_conversion_map WHERE legacy_material_id IS NOT NULL          -- (b)
  UNION SELECT m.material_id FROM sheet_material_conversion_map cm                                                -- (c)
          JOIN materials m ON m.material_name = cm.legacy_material_name AND NOT m.is_sheet_shadow
         WHERE cm.legacy_material_name IS NOT NULL
)
SELECT 'unmapped-detail' AS kind, od.material_id AS material_id, count(*) AS n
  FROM order_details od
 WHERE od.material_id IS NOT NULL AND od.sheet_material_type_id IS NULL
   AND od.material_id NOT IN (SELECT mid FROM mappable)
 GROUP BY od.material_id
UNION ALL
SELECT 'unmapped-header', o.material_id, count(*)
  FROM orders o
 WHERE o.material_id IS NOT NULL AND o.sheet_material_type_id IS NULL
   AND o.material_id NOT IN (SELECT mid FROM mappable)
 GROUP BY o.material_id
ORDER BY 1, 2;

-- shadow rows referenced by ANY non-order materials FK table (Critic R27 B1: derive the
-- referrers from pg_constraint — do NOT hard-code; the hard-coded list missed
-- `sheet_material_links` which is ON DELETE CASCADE). Every count must be 0.
DO $$
DECLARE r RECORD; v_n BIGINT;
BEGIN
  FOR r IN
    SELECT con.conrelid::regclass::text tbl, att.attname col
    FROM pg_constraint con JOIN pg_attribute att ON att.attrelid=con.conrelid AND att.attnum=con.conkey[1]
    WHERE con.contype='f' AND con.confrelid='materials'::regclass
      AND con.conrelid NOT IN ('orders'::regclass,'order_details'::regclass)
  LOOP
    EXECUTE format('SELECT count(*) FROM %s x JOIN materials m ON m.material_id=x.%I WHERE m.is_sheet_shadow', r.tbl, r.col) INTO v_n;
    RAISE NOTICE 'shadow-FK-leak %.%: %', r.tbl, r.col, v_n;   -- all must be 0
  END LOOP;
END $$;

-- Resolve each legacy material to its EXPECTED target sheet id BY KEY (Critic R27 B2):
-- 033 already created+keyed the target types, so we resolve to a concrete sid via
-- conversion_key — NEVER by mutable display name. (a) SP2 link; (b)/(c) manifest by key.
WITH expected(mid, sid) AS (
  SELECT m.material_id, m.sheet_material_type_id FROM materials m
    WHERE NOT m.is_sheet_shadow AND m.sheet_material_type_id IS NOT NULL                                    -- (a) SP2
  UNION SELECT cm.legacy_material_id, s.sheet_material_type_id FROM sheet_material_conversion_map cm
          JOIN sheet_material_types s ON s.conversion_key = cm.target_key WHERE cm.legacy_material_id IS NOT NULL  -- (b)
  UNION SELECT m.material_id, s.sheet_material_type_id FROM sheet_material_conversion_map cm
          JOIN materials m ON m.material_name = cm.legacy_material_name AND NOT m.is_sheet_shadow
          JOIN sheet_material_types s ON s.conversion_key = cm.target_key WHERE cm.legacy_material_name IS NOT NULL  -- (c)
),
-- DUAL-POPULATED MISMATCH (Critic R10 B1 / R27 B2): a row with BOTH material_id and a sheet
-- id where the material's expected sid != the stored sid. Compared BY ID (not name). 0 rows.
dual AS (
  SELECT 'dual-mismatch-detail' kind, od.detail_id id FROM order_details od JOIN expected e ON e.mid=od.material_id
   WHERE od.material_id IS NOT NULL AND od.sheet_material_type_id IS NOT NULL AND od.sheet_material_type_id <> e.sid
  UNION ALL
  SELECT 'dual-mismatch-header', o.order_id FROM orders o JOIN expected e ON e.mid=o.material_id
   WHERE o.material_id IS NOT NULL AND o.sheet_material_type_id IS NOT NULL AND o.sheet_material_type_id <> e.sid
),
-- AMBIGUOUS MAP (Critic R11 B1): a legacy material that resolves to >1 distinct sid. 0 rows.
ambig AS (SELECT 'ambiguous-map' kind, mid id FROM expected GROUP BY mid HAVING count(DISTINCT sid) > 1)
SELECT * FROM dual UNION ALL SELECT * FROM ambig;

-- NON-CUTTABLE-ON-DETAIL preflight (Critic R25 B4 / R27 B3): full would-be END STATE.
-- is_cuttable now exists on the type (set by 033), so check BOTH (i) details that already
-- carry a non-cuttable sheet_material_type_id, AND (ii) sheet-null details whose material
-- maps (via the manifest) to a non-cuttable target. Must be 0 rows.
SELECT 'non-cuttable-on-detail' AS kind, od.detail_id AS id, 1 AS n
  FROM order_details od JOIN sheet_material_types s ON s.sheet_material_type_id = od.sheet_material_type_id
 WHERE od.sheet_material_type_id IS NOT NULL AND s.is_cuttable = false                                       -- (i) already non-null
UNION ALL
SELECT 'non-cuttable-on-detail', od.detail_id, 1
  FROM order_details od
  JOIN (SELECT cm.legacy_material_id mid FROM sheet_material_conversion_map cm WHERE cm.is_cuttable=false AND cm.legacy_material_id IS NOT NULL
        UNION SELECT m.material_id FROM sheet_material_conversion_map cm JOIN materials m ON m.material_name=cm.legacy_material_name AND NOT m.is_sheet_shadow
              WHERE cm.is_cuttable=false AND cm.legacy_material_name IS NOT NULL) nc ON nc.mid = od.material_id
 WHERE od.material_id IS NOT NULL AND od.sheet_material_type_id IS NULL;                                      -- (ii) sheet-null via material
-- Expected: unmapped 0 rows; shadow-FK NOTICE counts all 0; dual-mismatch 0 rows;
-- ambiguous-map 0 rows; non-cuttable-on-detail 0 rows. (034_verify re-checks post-migration.)
