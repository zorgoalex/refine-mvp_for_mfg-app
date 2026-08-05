-- Backfill positions for snapshots created from ordinary ERP orders.

BEGIN;

UPDATE bazis_cut_set_details snapshot
SET position = btrim(snapshot.source_order_name) || '.' || source.detail_number::text
FROM order_details source
WHERE source.detail_id = snapshot.source_order_detail_id
  AND NULLIF(btrim(snapshot.source_order_name), '') IS NOT NULL
  AND COALESCE(NULLIF(btrim(snapshot.source_bazis_project_name), ''), '') = ''
  AND COALESCE(NULLIF(btrim(snapshot.source_bazis_order_no), ''), '') = ''
  AND COALESCE(NULLIF(btrim(snapshot.source_bazis_product_name), ''), '') = ''
  AND COALESCE(NULLIF(btrim(source.basis_project), ''), '') = ''
  AND COALESCE(NULLIF(btrim(source.basis_product), ''), '') = ''
  AND COALESCE(NULLIF(btrim(source.basis_designation), ''), '') = ''
  AND COALESCE(NULLIF(btrim(source.basis_data), ''), '') = ''
  AND btrim(snapshot.position) IN ('', '.');

COMMENT ON COLUMN bazis_cut_set_details.position IS
  'bazis-cut-position-v3: Basis position or <ERP order number>.<ERP detail number>';

COMMIT;
