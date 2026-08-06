-- 104_bazis_panel_order_links.sql
-- Exact, provenance-preserving links from PDF-imported ERP details to panels
-- in current Bazis revisions. Ambiguous duplicate groups record order-only
-- membership; no arbitrary detail-to-panel pairing is invented.

BEGIN;

ALTER TABLE bazis_node_order_detail_map
  ADD COLUMN IF NOT EXISTS import_source text,
  ADD COLUMN IF NOT EXISTS imported_by bigint REFERENCES users(user_id),
  ADD COLUMN IF NOT EXISTS request_id text;

ALTER TABLE bazis_node_order_detail_map
  DROP CONSTRAINT IF EXISTS bazis_node_order_detail_map_mapping_kind_check;

ALTER TABLE bazis_node_order_detail_map
  ADD CONSTRAINT bazis_node_order_detail_map_mapping_kind_check
  CHECK (mapping_kind IN ('created', 'ignored', 'manual', 'imported'));

ALTER TABLE bazis_node_order_detail_map
  DROP CONSTRAINT IF EXISTS bazis_node_order_detail_map_imported_provenance_check;

ALTER TABLE bazis_node_order_detail_map
  ADD CONSTRAINT bazis_node_order_detail_map_imported_provenance_check
  CHECK (
    mapping_kind <> 'imported'
    OR (
      NULLIF(btrim(import_source), '') IS NOT NULL
      AND NULLIF(btrim(request_id), '') IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS bazis_node_map_import_source_idx
  ON bazis_node_order_detail_map (import_source)
  WHERE mapping_kind = 'imported';

CREATE OR REPLACE FUNCTION reconcile_bazis_panel_order_links(
  p_order_id bigint,
  p_candidate_detail_ids bigint[],
  p_source text,
  p_actor_id bigint,
  p_request_id text
)
RETURNS TABLE (
  node_id bigint,
  order_detail_id bigint,
  bazis_project_id bigint,
  revision_id bigint,
  project_link_created boolean
)
LANGUAGE sql
VOLATILE
AS $function$
WITH RECURSIVE
candidate_details AS MATERIALIZED (
  SELECT
    detail.detail_id,
    detail.order_id,
    substring(btrim(detail.basis_project) from '(?i)(?:№[[:space:]]*)?([0-9]+)') AS project_no,
    lower(btrim(COALESCE(
      NULLIF(detail.basis_product, ''),
      CASE
        WHEN position('/' in detail.basis_project) > 0
          THEN regexp_replace(detail.basis_project, '^[^/]*/[[:space:]]*', '')
        ELSE NULL
      END
    ))) AS product_name,
    lower(btrim(detail.basis_designation)) AS basis_designation,
    lower(btrim(split_part(detail.basis_data, '/', 1))) AS data_position,
    lower(btrim(split_part(detail.basis_data, '/', 2))) AS data_designation,
    lower(btrim(regexp_replace(detail.basis_data, '^[^/]*/[^/]*/', ''))) AS data_name,
    lower(btrim(detail.detail_name)) AS detail_name
  FROM order_details detail
  JOIN orders erp_order ON erp_order.order_id = detail.order_id
  WHERE detail.order_id = p_order_id
    AND detail.detail_id = ANY(COALESCE(p_candidate_detail_ids, ARRAY[]::bigint[]))
    AND detail.delete_flag = false
    AND erp_order.delete_flag = false
    AND NULLIF(btrim(detail.basis_project), '') IS NOT NULL
    AND NULLIF(btrim(COALESCE(
      NULLIF(detail.basis_product, ''),
      CASE
        WHEN position('/' in detail.basis_project) > 0
          THEN regexp_replace(detail.basis_project, '^[^/]*/[[:space:]]*', '')
        ELSE NULL
      END
    )), '') IS NOT NULL
    AND NULLIF(btrim(detail.basis_designation), '') IS NOT NULL
    AND NULLIF(btrim(detail.basis_data), '') IS NOT NULL
    AND detail.basis_data ~ '^[^/]+/[^/]+/.+'
    AND NULLIF(btrim(detail.detail_name), '') IS NOT NULL
    AND (
      -- Runtime PDF import must never claim a detail that already belongs to a
      -- panel. Reprojection is different: it intentionally carries the same
      -- detail from an older revision to its exact panel in the new current
      -- revision. The node/order guard in current_panels keeps that idempotent.
      p_source = 'revision_reprojection'
      OR NOT EXISTS (
        SELECT 1
        FROM bazis_node_order_detail_map existing_detail_map
        WHERE existing_detail_map.order_detail_id = detail.detail_id
      )
    )
),
locked_revisions AS MATERIALIZED (
  SELECT revision.bazis_revision_id, revision.bazis_project_id, revision.bazis_order_no
  FROM bazis_project_revisions revision
  JOIN bazis_projects project
    ON project.bazis_project_id = revision.bazis_project_id
   AND project.current_revision_id = revision.bazis_revision_id
  WHERE EXISTS (
    SELECT 1
    FROM candidate_details candidate
    WHERE candidate.project_no = substring(
      btrim(COALESCE(
        NULLIF(revision.bazis_order_no, ''),
        (
          SELECT NULLIF(btrim(root.raw_json->>'Заказ'), '')
          FROM bazis_nodes root
          WHERE root.revision_id = revision.bazis_revision_id
            AND root.parent_node_id IS NULL
          ORDER BY root.seq, root.bazis_node_id
          LIMIT 1
        )
      ))
      from '(?i)(?:№[[:space:]]*)?([0-9]+)'
    )
  )
  ORDER BY revision.bazis_revision_id
  FOR KEY SHARE OF revision
),
node_tree AS (
  SELECT
    node.bazis_node_id,
    node.parent_node_id,
    node.revision_id,
    locked.bazis_project_id,
    node.name AS root_product_name,
    COALESCE(NULLIF(node.raw_json->>'Заказ', ''), locked.bazis_order_no) AS root_order_no,
    node.object_type,
    node.position,
    node.designation,
    node.name
  FROM locked_revisions locked
  JOIN bazis_nodes node
    ON node.revision_id = locked.bazis_revision_id
   AND node.parent_node_id IS NULL

  UNION ALL

  SELECT
    child.bazis_node_id,
    child.parent_node_id,
    child.revision_id,
    parent.bazis_project_id,
    parent.root_product_name,
    parent.root_order_no,
    child.object_type,
    child.position,
    child.designation,
    child.name
  FROM bazis_nodes child
  JOIN node_tree parent ON parent.bazis_node_id = child.parent_node_id
),
current_panels AS MATERIALIZED (
  SELECT
    tree.bazis_node_id AS node_id,
    tree.revision_id,
    tree.bazis_project_id,
    substring(btrim(tree.root_order_no) from '(?i)(?:№[[:space:]]*)?([0-9]+)') AS project_no,
    lower(btrim(tree.root_product_name)) AS product_name,
    lower(btrim(tree.designation)) AS designation,
    lower(btrim(tree.position)) AS position,
    lower(btrim(tree.name)) AS panel_name
  FROM node_tree tree
  WHERE tree.object_type = 'Панель'
    AND NULLIF(btrim(tree.root_order_no), '') IS NOT NULL
    AND NULLIF(btrim(tree.root_product_name), '') IS NOT NULL
    AND NULLIF(btrim(tree.designation), '') IS NOT NULL
    AND NULLIF(btrim(tree.position), '') IS NOT NULL
    AND NULLIF(btrim(tree.name), '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM bazis_node_order_detail_map existing_node_map
      WHERE existing_node_map.node_id = tree.bazis_node_id
        AND existing_node_map.order_id = p_order_id
    )
),
matches AS MATERIALIZED (
  SELECT DISTINCT
    candidate.order_id,
    candidate.detail_id,
    panel.node_id,
    panel.bazis_project_id,
    panel.revision_id,
    candidate.project_no,
    candidate.product_name,
    candidate.basis_designation,
    candidate.data_position,
    candidate.data_designation,
    candidate.data_name,
    candidate.detail_name
  FROM candidate_details candidate
  JOIN current_panels panel
    ON panel.project_no = candidate.project_no
   AND panel.product_name = candidate.product_name
   AND panel.designation = candidate.basis_designation
   AND panel.designation = candidate.data_designation
   AND panel.position = candidate.data_position
   AND panel.panel_name = candidate.data_name
   AND panel.panel_name = candidate.detail_name
),
identity_counts AS MATERIALIZED (
  SELECT
    matches.order_id,
    matches.project_no,
    matches.product_name,
    matches.basis_designation,
    matches.data_position,
    matches.data_designation,
    matches.data_name,
    matches.detail_name,
    count(DISTINCT matches.bazis_project_id) AS project_count,
    count(DISTINCT matches.detail_id) AS detail_count,
    count(DISTINCT matches.node_id) AS panel_count
  FROM matches
  GROUP BY
    matches.order_id,
    matches.project_no,
    matches.product_name,
    matches.basis_designation,
    matches.data_position,
    matches.data_designation,
    matches.data_name,
    matches.detail_name
),
safe_groups AS MATERIALIZED (
  SELECT *
  FROM identity_counts
  WHERE project_count = 1
    AND detail_count = panel_count
),
safe_nodes AS MATERIALIZED (
  SELECT
    matches.node_id,
    matches.order_id,
    matches.bazis_project_id,
    matches.revision_id,
    CASE WHEN safe.detail_count = 1 THEN min(matches.detail_id) ELSE NULL END AS order_detail_id
  FROM matches
  JOIN safe_groups safe
    ON safe.order_id = matches.order_id
   AND safe.project_no = matches.project_no
   AND safe.product_name = matches.product_name
   AND safe.basis_designation = matches.basis_designation
   AND safe.data_position = matches.data_position
   AND safe.data_designation = matches.data_designation
   AND safe.data_name = matches.data_name
   AND safe.detail_name = matches.detail_name
  GROUP BY
    matches.node_id,
    matches.order_id,
    matches.bazis_project_id,
    matches.revision_id,
    safe.detail_count
),
inserted_maps AS (
  INSERT INTO bazis_node_order_detail_map (
    node_id,
    order_detail_id,
    order_id,
    mapping_kind,
    import_source,
    imported_by,
    request_id
  )
  SELECT
    safe_nodes.node_id,
    safe_nodes.order_detail_id,
    safe_nodes.order_id,
    'imported',
    NULLIF(btrim(p_source), ''),
    p_actor_id,
    NULLIF(btrim(p_request_id), '')
  FROM safe_nodes
  ORDER BY safe_nodes.node_id
  ON CONFLICT (node_id, order_id) DO NOTHING
  RETURNING node_id, order_detail_id, order_id
),
inserted_map_context AS MATERIALIZED (
  SELECT
    inserted.node_id,
    inserted.order_detail_id,
    inserted.order_id,
    node.revision_id,
    revision.bazis_project_id
  FROM inserted_maps inserted
  JOIN bazis_nodes node ON node.bazis_node_id = inserted.node_id
  JOIN bazis_project_revisions revision ON revision.bazis_revision_id = node.revision_id
),
inserted_project_links AS (
  INSERT INTO bazis_order_links (bazis_project_id, order_id, revision_id)
  SELECT DISTINCT
    context.bazis_project_id,
    context.order_id,
    context.revision_id
  FROM inserted_map_context context
  ON CONFLICT (bazis_project_id, order_id) DO NOTHING
  RETURNING bazis_project_id, order_id
)
SELECT
  context.node_id,
  context.order_detail_id,
  context.bazis_project_id,
  context.revision_id,
  EXISTS (
    SELECT 1
    FROM inserted_project_links link
    WHERE link.bazis_project_id = context.bazis_project_id
      AND link.order_id = context.order_id
  ) AS project_link_created
FROM inserted_map_context context
ORDER BY context.node_id;
$function$;

COMMENT ON FUNCTION reconcile_bazis_panel_order_links(bigint, bigint[], text, bigint, text)
  IS 'v104 exact current-revision Basis PDF detail to Bazis panel reconciliation';

-- Historical backfill. Function guards reduce this broad candidate feed to
-- complete, exact, equal-cardinality identities in one current Bazis project.
WITH historical_candidates AS (
  SELECT detail.order_id, array_agg(detail.detail_id ORDER BY detail.detail_id) AS detail_ids
  FROM order_details detail
  JOIN orders erp_order ON erp_order.order_id = detail.order_id
  WHERE detail.delete_flag = false
    AND erp_order.delete_flag = false
    AND NULLIF(btrim(detail.basis_project), '') IS NOT NULL
    AND NULLIF(btrim(COALESCE(
      NULLIF(detail.basis_product, ''),
      CASE
        WHEN position('/' in detail.basis_project) > 0
          THEN regexp_replace(detail.basis_project, '^[^/]*/[[:space:]]*', '')
        ELSE NULL
      END
    )), '') IS NOT NULL
    AND NULLIF(btrim(detail.basis_designation), '') IS NOT NULL
    AND NULLIF(btrim(detail.basis_data), '') IS NOT NULL
    AND NULLIF(btrim(detail.detail_name), '') IS NOT NULL
  GROUP BY detail.order_id
),
historical_backfill AS (
  SELECT reconciled.*
  FROM historical_candidates candidate
  CROSS JOIN LATERAL reconcile_bazis_panel_order_links(
    candidate.order_id,
    candidate.detail_ids,
    'historical_backfill',
    NULL,
    'migration-104-historical-backfill'
  ) reconciled
)
SELECT count(*) AS imported_panel_links FROM historical_backfill;

COMMIT;
