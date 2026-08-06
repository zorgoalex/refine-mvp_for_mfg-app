BEGIN;

WITH revision_products AS (
  SELECT revision.bazis_revision_id AS revision_id,
         COUNT(root_product.bazis_node_id)::int AS root_product_count,
         MIN(NULLIF(btrim(root_product.raw_json->>'Заказ'), '')) AS root_order_no
  FROM bazis_project_revisions revision
  LEFT JOIN bazis_nodes root_product
    ON root_product.revision_id = revision.bazis_revision_id
   AND root_product.parent_node_id IS NULL
   AND root_product.node_kind = 'product'
  GROUP BY revision.bazis_revision_id
),
mapped_single_product_details AS (
  SELECT DISTINCT detail.detail_id
  FROM bazis_order_links link
  JOIN bazis_project_revisions revision
    ON revision.bazis_revision_id = link.revision_id
  JOIN bazis_projects project
    ON project.bazis_project_id = link.bazis_project_id
  JOIN revision_products products
    ON products.revision_id = link.revision_id
  JOIN bazis_node_order_detail_map map
    ON map.order_id = link.order_id
   AND map.mapping_kind IN ('created', 'imported')
  JOIN bazis_nodes panel
    ON panel.bazis_node_id = map.node_id
   AND panel.revision_id = link.revision_id
   AND panel.object_type = 'Панель'
  JOIN order_details detail
    ON detail.order_id = link.order_id
   AND (
     map.order_detail_id = detail.detail_id
     OR (
       map.order_detail_id IS NULL
       AND btrim(COALESCE(detail.basis_data, '')) = CONCAT(
         COALESCE(panel.position, ''),
         '/',
         COALESCE(panel.designation, ''),
         '/',
         COALESCE(panel.name, '')
       )
       AND btrim(COALESCE(panel.designation, '')) =
           btrim(COALESCE(detail.basis_designation, ''))
     )
   )
  WHERE products.root_product_count <= 1
    AND NULLIF(btrim(detail.basis_product), '') IS NOT NULL
    AND btrim(COALESCE(detail.basis_project, '')) = COALESCE(
      products.root_order_no,
      NULLIF(btrim(revision.bazis_order_no), ''),
      btrim(project.name)
    )
)
UPDATE order_details detail
SET basis_product = NULL
FROM mapped_single_product_details target
WHERE detail.detail_id = target.detail_id;

COMMIT;
