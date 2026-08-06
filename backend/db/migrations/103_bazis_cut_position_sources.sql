-- Align frozen Basis-cut positions with their actual import source.

BEGIN;

WITH source_values AS (
  SELECT snapshot.bazis_cut_set_detail_id,
         snapshot.source_bazis_node_id,
         btrim(COALESCE(node.designation, '')) AS node_designation,
         btrim(COALESCE(snapshot.source_order_name, '')) AS source_order_name,
         btrim(COALESCE(snapshot.source_bazis_project_name, '')) AS source_bazis_project_name,
         btrim(COALESCE(snapshot.source_bazis_order_no, '')) AS source_bazis_order_no,
         btrim(COALESCE(snapshot.source_bazis_product_name, '')) AS source_bazis_product_name,
         btrim(COALESCE(source.basis_project, '')) AS detail_bazis_document,
         btrim(COALESCE(source.basis_product, '')) AS source_basis_product,
         btrim(COALESCE(source.basis_designation, '')) AS source_basis_designation,
         source.detail_number
  FROM bazis_cut_set_details snapshot
  JOIN order_details source ON source.detail_id = snapshot.source_order_detail_id
  LEFT JOIN bazis_nodes node ON node.bazis_node_id = snapshot.source_bazis_node_id
), desired AS (
  SELECT source_values.*,
         CASE
           WHEN source_bazis_node_id IS NOT NULL THEN node_designation
           WHEN source_basis_designation <> ''
             AND (
               source_bazis_project_name <> ''
               OR source_bazis_order_no <> ''
               OR detail_bazis_document <> ''
             )
             THEN source_basis_designation
           ELSE detail_number::text
         END AS desired_position,
         ARRAY[
           source_order_name || '.' || detail_number::text,
           (CASE WHEN source_bazis_project_name <> '' THEN source_bazis_product_name ELSE '' END)
             || '.' || source_basis_designation,
           source_bazis_product_name || '.' || source_basis_designation,
           source_basis_product || '.' || source_basis_designation,
           '.' || source_basis_designation,
           '.',
           ''
         ]::text[] AS generated_positions
  FROM source_values
)
UPDATE bazis_cut_set_details snapshot
SET position = desired.desired_position
FROM desired
WHERE desired.bazis_cut_set_detail_id = snapshot.bazis_cut_set_detail_id
  AND btrim(snapshot.position) = ANY(desired.generated_positions)
  AND snapshot.position IS DISTINCT FROM desired.desired_position;

COMMENT ON COLUMN bazis_cut_set_details.position IS
  'bazis-cut-position-v4: Basis node designation; otherwise ERP Basis designation with document, else ERP detail number';

COMMIT;
