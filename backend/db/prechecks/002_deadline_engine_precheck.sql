-- Deadline Engine read-only precheck for DBeaver.
-- This file must stay SELECT/WITH-only. It checks prerequisites and likely
-- conflicts before backend/db/migrations/002_deadline_engine.sql is applied.

WITH required_tables(table_name) AS (
  VALUES
    ('orders'),
    ('users'),
    ('audit_log'),
    ('order_workshops')
)
SELECT
  'deadline_required_tables' AS check_name,
  rt.table_name,
  to_regclass('public.' || rt.table_name) IS NOT NULL AS table_exists
FROM required_tables rt
ORDER BY rt.table_name;

SELECT
  'deadline_pgcrypto_extension' AS check_name,
  EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'pgcrypto'
  ) AS pgcrypto_enabled;

WITH deadline_tables(table_name) AS (
  VALUES
    ('deadline_policies'),
    ('deadline_policy_versions'),
    ('deadline_instances'),
    ('deadline_events'),
    ('deadline_action_rules'),
    ('deadline_action_executions'),
    ('deadline_pauses'),
    ('deadline_reminder_rules'),
    ('outbox_events'),
    ('notifications')
)
SELECT
  'deadline_existing_objects' AS check_name,
  dt.table_name,
  to_regclass('public.' || dt.table_name) IS NOT NULL AS object_exists
FROM deadline_tables dt
ORDER BY dt.table_name;

SELECT
  'deadline_order_workshops_columns' AS check_name,
  bool_or(column_name = 'planned_completion_date') AS planned_completion_date_exists,
  bool_or(column_name = 'completed_date') AS completed_date_exists,
  bool_or(column_name = 'responsible_employee_id') AS responsible_employee_id_exists,
  bool_or(column_name = 'production_status_id') AS production_status_id_exists
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'order_workshops';

SELECT
  'deadline_orders_columns' AS check_name,
  bool_or(column_name = 'planned_completion_date') AS planned_completion_date_exists,
  bool_or(column_name = 'completion_date') AS completion_date_exists,
  bool_or(column_name = 'client_id') AS client_id_exists
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'orders';

SELECT
  'deadline_audit_log_columns' AS check_name,
  bool_or(column_name = 'event') AS event_exists,
  bool_or(column_name = 'metadata_json') AS metadata_json_exists,
  bool_or(column_name = 'request_id') AS request_id_exists
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'audit_log';

SELECT
  'deadline_instances_idempotency' AS check_name,
  bool_or(column_name = 'idempotency_key') AS idempotency_key_exists,
  to_regclass('public.deadline_instances_idempotency_key_uidx') IS NOT NULL AS idempotency_key_index_exists
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'deadline_instances';
