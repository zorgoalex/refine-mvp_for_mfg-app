-- Align frozen Basis-cut document fields with the Basis project panel list.

BEGIN;

WITH root_stats AS (
  SELECT revision.bazis_revision_id,
         revision.bazis_project_id,
         revision.revision_no,
         revision.imported_at,
         NULLIF(btrim(revision.bazis_order_no), '') AS revision_bazis_order_no,
         (
           SELECT COUNT(*)
           FROM bazis_nodes root
           WHERE root.revision_id = revision.bazis_revision_id
             AND root.parent_node_id IS NULL
             AND root.node_kind = 'product'
         ) AS root_product_count,
         (
           SELECT NULLIF(btrim(root.raw_json->>'Заказ'), '')
           FROM bazis_nodes root
           WHERE root.revision_id = revision.bazis_revision_id
             AND root.parent_node_id IS NULL
             AND root.node_kind = 'product'
             AND NULLIF(btrim(root.raw_json->>'Заказ'), '') IS NOT NULL
           ORDER BY root.seq
           LIMIT 1
         ) AS product_order_no
  FROM bazis_project_revisions revision
),
revision_match AS (
  SELECT DISTINCT ON (snapshot.bazis_cut_set_detail_id)
         snapshot.bazis_cut_set_detail_id,
         stats.bazis_revision_id,
         stats.bazis_project_id,
         stats.root_product_count,
         stats.product_order_no,
         stats.revision_bazis_order_no
  FROM bazis_cut_set_details snapshot
  JOIN order_details source ON source.detail_id = snapshot.source_order_detail_id
  LEFT JOIN bazis_nodes source_node ON source_node.bazis_node_id = snapshot.source_bazis_node_id
  JOIN root_stats stats ON CASE
    WHEN COALESCE(snapshot.source_bazis_revision_id, source_node.revision_id) IS NOT NULL
      THEN stats.bazis_revision_id = COALESCE(snapshot.source_bazis_revision_id, source_node.revision_id)
    ELSE NULLIF(btrim(source.basis_project), '') IS NOT NULL
      AND (
        stats.revision_bazis_order_no = NULLIF(btrim(source.basis_project), '')
        OR stats.product_order_no = NULLIF(btrim(source.basis_project), '')
      )
  END
  ORDER BY snapshot.bazis_cut_set_detail_id,
           stats.revision_no DESC,
           stats.imported_at DESC,
           stats.bazis_revision_id DESC
),
desired AS (
  SELECT snapshot.bazis_cut_set_detail_id,
         matched.bazis_revision_id,
         matched.bazis_project_id,
         COALESCE(NULLIF(btrim(source.basis_product), ''), '') AS product_name,
         COALESCE(NULLIF(btrim(source.basis_designation), ''), '') AS designation,
         CASE WHEN COALESCE(matched.root_product_count, 1) > 1
           THEN COALESCE(
             matched.revision_bazis_order_no,
             matched.product_order_no,
             ''
           )
           ELSE ''
         END AS project_name,
         CASE WHEN COALESCE(matched.root_product_count, 1) > 1
           THEN ''
           ELSE COALESCE(
             matched.product_order_no,
             matched.revision_bazis_order_no,
             CASE WHEN matched.bazis_revision_id IS NULL
               THEN NULLIF(btrim(source.basis_project), '')
             END,
             ''
           )
         END AS order_no
  FROM bazis_cut_set_details snapshot
  JOIN order_details source ON source.detail_id = snapshot.source_order_detail_id
  LEFT JOIN revision_match matched
    ON matched.bazis_cut_set_detail_id = snapshot.bazis_cut_set_detail_id
)
UPDATE bazis_cut_set_details snapshot
SET source_bazis_project_id = COALESCE(desired.bazis_project_id, snapshot.source_bazis_project_id),
    source_bazis_revision_id = COALESCE(desired.bazis_revision_id, snapshot.source_bazis_revision_id),
    source_bazis_project_name = desired.project_name,
    source_bazis_order_no = desired.order_no,
    source_bazis_product_name = desired.product_name,
    position = CASE WHEN desired.project_name <> '' THEN desired.product_name ELSE '' END
      || '.' || desired.designation
FROM desired
WHERE desired.bazis_cut_set_detail_id = snapshot.bazis_cut_set_detail_id;

COMMENT ON COLUMN bazis_cut_set_details.source_bazis_project_name IS
  'bazis-cut-document-fields-v2: Basis project number from the matching Basis revision';
COMMENT ON COLUMN bazis_cut_set_details.position IS
  'bazis-cut-document-fields-v2: [product when Basis project exists].[designation]';

COMMIT;
