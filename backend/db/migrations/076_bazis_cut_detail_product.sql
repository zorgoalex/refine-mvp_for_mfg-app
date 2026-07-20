-- 076_bazis_cut_detail_product.sql
-- Separate the ERP detail's Basis project/order and Basis product snapshots.

BEGIN;

ALTER TABLE bazis_cut_set_details
  ADD COLUMN IF NOT EXISTS source_bazis_product_name TEXT;

UPDATE bazis_cut_set_details AS snapshot
SET source_bazis_project_name = COALESCE(NULLIF(btrim(source.basis_project), ''), ''),
    source_bazis_order_no = COALESCE(NULLIF(btrim(source.basis_project), ''), ''),
    source_bazis_product_name = COALESCE(NULLIF(btrim(source.basis_product), ''), '')
FROM order_details AS source
WHERE snapshot.source_order_detail_id = source.detail_id;

COMMIT;
