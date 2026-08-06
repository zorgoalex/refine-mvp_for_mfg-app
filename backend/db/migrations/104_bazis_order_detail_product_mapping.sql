BEGIN;

WITH RECURSIVE
root_product_counts AS (
  SELECT revision_id,
         COUNT(*) FILTER (
           WHERE parent_node_id IS NULL
             AND node_kind = 'product'
         )::int AS root_product_count
  FROM bazis_nodes
  GROUP BY revision_id
),
mapped_panels AS (
  SELECT map.bazis_node_order_detail_map_id,
         map.order_detail_id,
         node.bazis_node_id AS panel_id,
         node.revision_id
  FROM bazis_node_order_detail_map map
  JOIN bazis_nodes node ON node.bazis_node_id = map.node_id
  WHERE map.order_detail_id IS NOT NULL
    AND node.object_type = 'Панель'
),
ancestry AS (
  SELECT mapped.bazis_node_order_detail_map_id,
         mapped.order_detail_id,
         mapped.panel_id,
         node.bazis_node_id,
         node.parent_node_id,
         node.revision_id,
         node.node_kind,
         node.name,
         0 AS depth,
         ARRAY[node.bazis_node_id]::bigint[] AS visited
  FROM mapped_panels mapped
  JOIN bazis_nodes node ON node.bazis_node_id = mapped.panel_id

  UNION ALL

  SELECT ancestry.bazis_node_order_detail_map_id,
         ancestry.order_detail_id,
         ancestry.panel_id,
         parent.bazis_node_id,
         parent.parent_node_id,
         parent.revision_id,
         parent.node_kind,
         parent.name,
         ancestry.depth + 1,
         ancestry.visited || parent.bazis_node_id
  FROM ancestry
  JOIN bazis_nodes parent ON parent.bazis_node_id = ancestry.parent_node_id
  WHERE parent.revision_id = ancestry.revision_id
    AND NOT parent.bazis_node_id = ANY(ancestry.visited)
    AND ancestry.depth < 100
),
resolved_mappings AS (
  SELECT mapped.order_detail_id,
         counts.root_product_count,
         NULLIF(btrim(root_product.name), '') AS root_product_name
  FROM mapped_panels mapped
  JOIN root_product_counts counts ON counts.revision_id = mapped.revision_id
  LEFT JOIN ancestry root_product
    ON root_product.bazis_node_order_detail_map_id = mapped.bazis_node_order_detail_map_id
   AND root_product.parent_node_id IS NULL
   AND root_product.node_kind = 'product'
),
targets AS (
  SELECT order_detail_id,
         CASE
           WHEN MIN(root_product_count) > 1
             AND COUNT(DISTINCT root_product_name) = 1
             THEN MIN(root_product_name)
           ELSE NULL
         END AS desired_basis_product
  FROM resolved_mappings
  GROUP BY order_detail_id
)
UPDATE order_details detail
SET basis_product = targets.desired_basis_product
FROM targets
WHERE detail.detail_id = targets.order_detail_id
  AND detail.basis_product IS DISTINCT FROM targets.desired_basis_product;

COMMENT ON COLUMN order_details.basis_product IS
  'Basis product name from the panel-level Product column; NULL when Product exists only in the project summary';

COMMIT;
