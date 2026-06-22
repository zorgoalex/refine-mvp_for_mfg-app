-- 034 VERIFY: POST-migration read-only end-state counts. Run after applying 034.
-- Counts cover ALL rows incl. soft-deleted (Critic R2 B1).
SELECT 'details total (all)'            AS k, count(*)::text AS v FROM order_details
UNION ALL SELECT 'details with sheet (all)',     count(*)::text FROM order_details WHERE sheet_material_type_id IS NOT NULL
UNION ALL SELECT 'details WITHOUT sheet (all)',  count(*)::text FROM order_details WHERE sheet_material_type_id IS NULL
UNION ALL SELECT 'details with material_id (all)', count(*)::text FROM order_details WHERE material_id IS NOT NULL
UNION ALL SELECT 'orders with material_id (all)',  count(*)::text FROM orders        WHERE material_id IS NOT NULL
UNION ALL SELECT 'orders with sheet (all)',        count(*)::text FROM orders        WHERE sheet_material_type_id IS NOT NULL
UNION ALL SELECT 'orders WITHOUT sheet (all)',     count(*)::text FROM orders        WHERE sheet_material_type_id IS NULL
UNION ALL SELECT 'shadow materials remaining',     count(*)::text FROM materials WHERE is_sheet_shadow = true
UNION ALL SELECT 'non-cuttable on a detail',        count(*)::text
  FROM order_details od JOIN sheet_material_types s ON s.sheet_material_type_id = od.sheet_material_type_id
 WHERE s.is_cuttable = false
UNION ALL SELECT 'orders not sheet_eligible (non-deleted)', count(*)::text
  FROM orders WHERE delete_flag = false AND sheet_eligible = false;
-- Expected after 034: details-WITHOUT-sheet=0, details-with-material_id=0,
-- orders-with-material_id=0, shadow-materials-remaining=0, non-cuttable-on-a-detail=0,
-- orders-not-sheet_eligible-(non-deleted)=0, details-with-sheet == details-total.
-- 'orders WITHOUT sheet' is INFORMATIONAL (header material is optional — many orders
-- legitimately have no header material).
