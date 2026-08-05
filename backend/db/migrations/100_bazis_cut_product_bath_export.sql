-- Add the frozen bath calculation number used by Basis-cut cards and exports.

BEGIN;

ALTER TABLE bazis_cut_set_details
  ADD COLUMN IF NOT EXISTS source_bath_cut_number TEXT NOT NULL DEFAULT '';

WITH RECURSIVE ancestry AS (
  SELECT snapshot.bazis_cut_set_detail_id,
         node.bazis_node_id,
         node.parent_node_id,
         node.node_kind,
         node.name,
         0 AS depth,
         ARRAY[node.bazis_node_id] AS visited
  FROM bazis_cut_set_details snapshot
  JOIN bazis_nodes node
    ON node.bazis_node_id = snapshot.source_bazis_node_id
  WHERE snapshot.source_bazis_project_id IS NOT NULL
  UNION ALL
  SELECT ancestry.bazis_cut_set_detail_id,
         parent.bazis_node_id,
         parent.parent_node_id,
         parent.node_kind,
         parent.name,
         ancestry.depth + 1,
         ancestry.visited || parent.bazis_node_id
  FROM ancestry
  JOIN bazis_nodes parent
    ON parent.bazis_node_id = ancestry.parent_node_id
  WHERE NOT parent.bazis_node_id = ANY(ancestry.visited)
    AND ancestry.depth < 100
), root_products AS (
  SELECT DISTINCT ON (bazis_cut_set_detail_id)
         bazis_cut_set_detail_id,
         NULLIF(btrim(name), '') AS product_name
  FROM ancestry
  WHERE parent_node_id IS NULL
    AND node_kind = 'product'
  ORDER BY bazis_cut_set_detail_id, depth DESC
)
UPDATE bazis_cut_set_details snapshot
SET source_bazis_product_name = product.product_name
FROM root_products product
WHERE product.bazis_cut_set_detail_id = snapshot.bazis_cut_set_detail_id
  AND product.product_name IS NOT NULL;

WITH bath_candidates AS (
  SELECT snapshot.bazis_cut_set_detail_id,
         cj.cut_job_id,
         cr.result_no,
         row_number() OVER (
           PARTITION BY snapshot.bazis_cut_set_detail_id
           ORDER BY cj.cut_job_id DESC
         ) AS rank
  FROM bazis_cut_set_details snapshot
  JOIN cut_job_item item
    ON item.order_detail_id = snapshot.source_order_detail_id
   AND item.is_active = true
  JOIN cut_job cj
    ON cj.cut_job_id = item.cut_job_id
   AND cj.status = 'ready'
   AND cj.last_calc_basis IS NOT NULL
  JOIN cut_result cr
    ON cr.cut_result_id = cj.current_cut_result_id
   AND cr.cut_job_id = cj.cut_job_id
  LEFT JOIN cut_result_archive_state archived
    ON archived.cut_job_id = cr.cut_job_id
   AND archived.result_no = cr.result_no
  LEFT JOIN cut_param_profiles profile
    ON profile.cut_param_profile_id = cj.param_profile_id
  WHERE archived.cut_job_id IS NULL
    AND COALESCE(
      cj.last_calc_params->>'layout_mode',
      profile.params->>'layout_mode',
      cj.params->>'layout_mode'
    ) = 'vacuum_table'
)
UPDATE bazis_cut_set_details snapshot
SET source_bath_cut_number = candidate.cut_job_id::text || '-' || candidate.result_no::text
FROM bath_candidates candidate
WHERE candidate.bazis_cut_set_detail_id = snapshot.bazis_cut_set_detail_id
  AND candidate.rank = 1;

COMMENT ON COLUMN bazis_cut_set_details.source_bath_cut_number IS
  'bazis-cut-bath-number-v1: frozen <cut job id>-<current result number>';

COMMIT;
