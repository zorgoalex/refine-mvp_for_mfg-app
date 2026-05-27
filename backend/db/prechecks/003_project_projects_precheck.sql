-- Project foundation P1 read-only precheck for DBeaver.
-- This file must stay SELECT/WITH-only. It checks prerequisites and actual
-- users.user_id type before backend/db/migrations/009_project_projects.sql is
-- applied.

WITH required_tables(table_name) AS (
  VALUES
    ('users')
)
SELECT
  'project_required_tables' AS check_name,
  rt.table_name,
  to_regclass('public.' || rt.table_name) IS NOT NULL AS table_exists
FROM required_tables rt
ORDER BY rt.table_name;

SELECT
  'project_pgcrypto_available' AS check_name,
  EXISTS (
    SELECT 1
    FROM pg_available_extensions
    WHERE name = 'pgcrypto'
  ) AS pgcrypto_available,
  EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'pgcrypto'
  ) AS pgcrypto_enabled;

SELECT
  'project_users_user_id_type' AS check_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  (c.data_type = 'integer') AS users_user_id_is_integer,
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
