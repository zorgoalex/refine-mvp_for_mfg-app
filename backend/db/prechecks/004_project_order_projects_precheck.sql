-- Project foundation P3 precheck for DBeaver.
-- This file must stay SELECT/WITH-only. It checks prerequisites for
-- backend/db/migrations/010_project_order_projects.sql.

WITH required_tables(table_name) AS (
  VALUES
    ('orders'),
    ('project_projects'),
    ('users')
)
SELECT
  'project_order_required_tables' AS check_name,
  rt.table_name,
  to_regclass('public.' || rt.table_name) IS NOT NULL AS table_exists
FROM required_tables rt
ORDER BY rt.table_name;

SELECT
  'project_order_btree_gist_available' AS check_name,
  EXISTS (
    SELECT 1
    FROM pg_available_extensions
    WHERE name = 'btree_gist'
  ) AS btree_gist_available,
  EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'btree_gist'
  ) AS btree_gist_enabled;

SELECT
  'project_order_orders_order_id_type' AS check_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  (c.data_type = 'integer') AS orders_order_id_is_integer,
  EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema = tc.table_schema
     AND kcu.table_name = tc.table_name
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'orders'
      AND tc.constraint_type = 'PRIMARY KEY'
      AND kcu.column_name = 'order_id'
  ) AS orders_order_id_is_primary_key
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name = 'orders'
  AND c.column_name = 'order_id';

SELECT
  'project_order_users_user_id_type' AS check_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  (c.data_type = 'bigint') AS users_user_id_is_bigint,
  EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema = tc.table_schema
     AND kcu.table_name = tc.table_name
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'users'
      AND tc.constraint_type = 'PRIMARY KEY'
      AND kcu.column_name = 'user_id'
  ) AS users_user_id_is_primary_key
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name = 'users'
  AND c.column_name = 'user_id';

SELECT
  'project_order_adjacency_semantics' AS check_name,
  '[valid_from, valid_to)' AS interval_bounds,
  NOT tstzrange(
    TIMESTAMPTZ '2026-01-01T00:00:00Z',
    TIMESTAMPTZ '2026-01-02T00:00:00Z',
    '[)'
  ) && tstzrange(
    TIMESTAMPTZ '2026-01-02T00:00:00Z',
    TIMESTAMPTZ '2026-01-03T00:00:00Z',
    '[)'
  ) AS adjacent_ranges_do_not_overlap;
