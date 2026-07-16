-- 069_bazis_cut_detail_order_backfill.sql
-- Backfill the per-detail Basis order/product frozen on PDF-imported order details.

BEGIN;

UPDATE bazis_cut_set_details AS snapshot
SET source_bazis_order_no = btrim(source.basis_product)
FROM order_details AS source
WHERE snapshot.source_order_detail_id = source.detail_id
  AND NULLIF(btrim(COALESCE(snapshot.source_bazis_order_no, '')), '') IS NULL
  AND NULLIF(btrim(COALESCE(source.basis_product, '')), '') IS NOT NULL;

COMMIT;
