-- 077_bazis_project_order_names.sql
-- Replace legacy auto-generated Bazis project names (joined product names)
-- with the latest effective Bazis order number/name. Preserve manual names.
BEGIN;

WITH latest_order AS (
  SELECT DISTINCT ON (r.bazis_project_id)
         r.bazis_project_id,
         COALESCE(
           NULLIF(btrim(r.bazis_order_no), ''),
           (
             SELECT NULLIF(btrim(n.raw_json->>'Заказ'), '')
             FROM bazis_nodes n
             WHERE n.revision_id = r.bazis_revision_id
               AND n.parent_node_id IS NULL
               AND NULLIF(btrim(n.raw_json->>'Заказ'), '') IS NOT NULL
             ORDER BY n.seq
             LIMIT 1
           )
         ) AS order_name
  FROM bazis_project_revisions r
  ORDER BY r.bazis_project_id,
           r.revision_no DESC,
           r.imported_at DESC,
           r.bazis_revision_id DESC
)
UPDATE bazis_projects project
SET name = latest.order_name
FROM latest_order latest
WHERE latest.bazis_project_id = project.bazis_project_id
  AND latest.order_name IS NOT NULL
  AND project.name IS DISTINCT FROM latest.order_name
  AND EXISTS (
    SELECT 1
    FROM bazis_project_revisions legacy_revision
    WHERE legacy_revision.bazis_project_id = project.bazis_project_id
      AND legacy_revision.product_name = project.name
  );

COMMIT;
