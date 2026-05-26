-- Project foundation P1 read-only precheck for DBeaver.
-- This file must stay SELECT/WITH-only. It checks prerequisites and actual
-- key types before backend/db/migrations/009_project_projects.sql is applied.

WITH required_tables(table_name) AS (
  VALUES
    ('users'),
    ('orders'),
    ('clients'),
    ('workshops'),
    ('order_workshops')
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
  data_type,
  udt_name,
  (data_type = 'integer') AS users_user_id_is_integer
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'users'
  AND column_name = 'user_id';

SELECT
  'project_orders_order_id_type' AS check_name,
  data_type,
  udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'orders'
  AND column_name = 'order_id';

SELECT
  'project_clients_client_id_type' AS check_name,
  data_type,
  udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'clients'
  AND column_name = 'client_id';

SELECT
  'project_workshops_workshop_id_type' AS check_name,
  data_type,
  udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'workshops'
  AND column_name = 'workshop_id';

SELECT
  'project_order_workshops_fk_types' AS check_name,
  column_name,
  data_type,
  udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'order_workshops'
  AND column_name IN ('order_workshop_id', 'order_id', 'workshop_id')
ORDER BY column_name;

SELECT
  'project_core_existing_objects' AS check_name,
  to_regclass('public.project_projects') IS NOT NULL AS project_projects_exists,
  to_regclass('project.project_projects') IS NOT NULL AS project_schema_projects_exists,
  to_regclass('public.project_members') IS NOT NULL AS project_members_exists,
  to_regclass('public.project_clients') IS NOT NULL AS project_clients_exists,
  to_regclass('public.project_workshops') IS NOT NULL AS project_workshops_exists;
