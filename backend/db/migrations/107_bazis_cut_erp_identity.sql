-- Align ERP-order Basis-cut snapshots with the explicit ERP detail fields.

BEGIN;

WITH source_values AS (
  SELECT snapshot.bazis_cut_set_detail_id,
         btrim(snapshot.position) AS current_position,
         btrim(COALESCE(snapshot.source_bazis_project_name, '')) AS old_project,
         btrim(COALESCE(snapshot.source_bazis_order_no, '')) AS old_order,
         btrim(COALESCE(snapshot.source_bazis_product_name, '')) AS old_product,
         btrim(COALESCE(node.designation, '')) AS node_designation,
         btrim(COALESCE(source.basis_project, '')) AS source_project,
         btrim(COALESCE(source.basis_product, '')) AS source_product,
         btrim(COALESCE(source.basis_designation, '')) AS source_designation,
         btrim(COALESCE(snapshot.source_order_name, '')) AS source_order_name,
         source.detail_number
  FROM bazis_cut_set_details snapshot
  JOIN order_details source ON source.detail_id = snapshot.source_order_detail_id
  LEFT JOIN bazis_nodes node ON node.bazis_node_id = snapshot.source_bazis_node_id
), desired AS (
  SELECT source_values.*,
         CASE
           WHEN source_project <> '' AND source_designation <> '' THEN source_designation
           ELSE detail_number::text
         END AS desired_position,
         CASE WHEN source_project <> '' THEN source_product ELSE '' END AS desired_product,
         ARRAY[
           node_designation,
           source_designation,
           detail_number::text,
           source_order_name || '.' || detail_number::text,
           old_project || old_product || '.' || source_designation,
           old_order || old_product || '.' || source_designation,
           old_product || '.' || source_designation,
           '.' || source_designation
         ]::text[] AS generated_positions
  FROM source_values
)
UPDATE bazis_cut_set_details snapshot
SET source_bazis_project_name = desired.source_project,
    source_bazis_order_no = '',
    source_bazis_product_name = desired.desired_product,
    position = CASE
      WHEN desired.current_position = ANY(desired.generated_positions)
        THEN desired.desired_position
      ELSE snapshot.position
    END
FROM desired
WHERE desired.bazis_cut_set_detail_id = snapshot.bazis_cut_set_detail_id
  AND (
    snapshot.source_bazis_project_name IS DISTINCT FROM desired.source_project
    OR snapshot.source_bazis_order_no IS DISTINCT FROM ''
    OR snapshot.source_bazis_product_name IS DISTINCT FROM desired.desired_product
    OR (
      desired.current_position = ANY(desired.generated_positions)
      AND snapshot.position IS DISTINCT FROM desired.desired_position
    )
  );

COMMENT ON COLUMN bazis_cut_set_details.position IS
  'ERP Basis designation when basis_project is filled; otherwise ERP detail_number; manual snapshot edits are preserved by migration 107';

COMMIT;
