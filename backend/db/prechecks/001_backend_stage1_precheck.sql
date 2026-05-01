-- Backend ERP stage 1 DB precheck.
--
-- Purpose:
-- - run in DBeaver before applying any backend stage-1 migration;
-- - inspect current production/stage shared DB data;
-- - detect migration blockers without changing data.
--
-- This file must remain read-only. It should contain SELECT/WITH statements only.

-- 1. Duplicate role codes would break uq_roles_code.
SELECT
  'roles_duplicate_role_code' AS check_name,
  role_code,
  COUNT(*) AS rows_count,
  array_agg(role_id ORDER BY role_id) AS role_ids
FROM roles
GROUP BY role_code
HAVING COUNT(*) > 1
ORDER BY role_code;

-- 2. Canonical superadmin role check.
-- Backend stage 1 treats role_id=2/role_code=superadmin as the highest role.
SELECT
  'users_with_role_id_2' AS check_name,
  u.user_id,
  u.username,
  u.email,
  u.is_active,
  u.role_id,
  r.role_code,
  r.role_name,
  r.is_active AS role_is_active
FROM users u
LEFT JOIN roles r
  ON r.role_id = u.role_id
WHERE u.role_id = 2
ORDER BY u.user_id;

-- 3. Payment status names outside the planned code mapping need manual mapping.
WITH planned_mapping(payment_status_name, payment_status_code) AS (
  VALUES
    ('Не оплачен', 'unpaid'),
    ('Частично оплачен', 'partial'),
    ('Оплачен', 'paid'),
    ('В долг', 'debt'),
    ('За счет фирмы', 'company_expense'),
    ('Взаимозачет', 'offset')
)
SELECT
  'payment_status_unmapped_name' AS check_name,
  ps.payment_status_id,
  ps.payment_status_name,
  ps.sort_order
FROM payment_statuses ps
LEFT JOIN planned_mapping pm
  ON pm.payment_status_name = ps.payment_status_name
WHERE pm.payment_status_name IS NULL
ORDER BY ps.payment_status_id;

-- 4. Planned payment status codes must be unique.
WITH planned_mapping(payment_status_name, payment_status_code) AS (
  VALUES
    ('Не оплачен', 'unpaid'),
    ('Частично оплачен', 'partial'),
    ('Оплачен', 'paid'),
    ('В долг', 'debt'),
    ('За счет фирмы', 'company_expense'),
    ('Взаимозачет', 'offset')
)
SELECT
  'payment_status_code_duplicate_after_mapping' AS check_name,
  pm.payment_status_code,
  COUNT(*) AS rows_count,
  array_agg(ps.payment_status_id ORDER BY ps.payment_status_id) AS payment_status_ids,
  array_agg(ps.payment_status_name ORDER BY ps.payment_status_id) AS payment_status_names
FROM payment_statuses ps
JOIN planned_mapping pm
  ON pm.payment_status_name = ps.payment_status_name
GROUP BY pm.payment_status_code
HAVING COUNT(*) > 1
ORDER BY pm.payment_status_code;

-- 5. Existing orders that would fail chk_orders_final_amount_consistent.
-- The planned migration adds the constraint as NOT VALID, so old rows are not
-- scanned immediately, but future updates to these rows may fail.
SELECT
  'orders_final_amount_inconsistent' AS check_name,
  order_id,
  total_amount,
  discount,
  surcharge,
  final_amount,
  ROUND(
    COALESCE(total_amount, 0)
    - COALESCE(discount, 0)
    + COALESCE(surcharge, 0),
    2
  ) AS expected_final_amount
FROM orders
WHERE final_amount IS NOT NULL
  AND final_amount <> ROUND(
    COALESCE(total_amount, 0)
    - COALESCE(discount, 0)
    + COALESCE(surcharge, 0),
    2
  )
ORDER BY order_id;

-- 6. Existing orders where both discount and surcharge are positive.
SELECT
  'orders_both_discount_and_surcharge_positive' AS check_name,
  order_id,
  discount,
  surcharge
FROM orders
WHERE COALESCE(discount, 0) > 0
  AND COALESCE(surcharge, 0) > 0
ORDER BY order_id;

-- 7. Duplicate active material requirements that would break uq_orr_active_material.
SELECT
  'orr_duplicate_active_material' AS check_name,
  order_id,
  material_id,
  COUNT(*) AS rows_count,
  array_agg(requirement_id ORDER BY requirement_id) AS requirement_ids
FROM order_resource_requirements
WHERE is_active = true
  AND resource_type = 'material'
  AND material_id IS NOT NULL
GROUP BY order_id, material_id
HAVING COUNT(*) > 1
ORDER BY order_id, material_id;

-- 8. Duplicate active film requirements that would break uq_orr_active_film.
SELECT
  'orr_duplicate_active_film' AS check_name,
  order_id,
  film_id,
  COUNT(*) AS rows_count,
  array_agg(requirement_id ORDER BY requirement_id) AS requirement_ids
FROM order_resource_requirements
WHERE is_active = true
  AND resource_type = 'film'
  AND film_id IS NOT NULL
GROUP BY order_id, film_id
HAVING COUNT(*) > 1
ORDER BY order_id, film_id;

-- 9. Duplicate active edge requirements that would break uq_orr_active_edge.
SELECT
  'orr_duplicate_active_edge' AS check_name,
  order_id,
  edge_type_id,
  COUNT(*) AS rows_count,
  array_agg(requirement_id ORDER BY requirement_id) AS requirement_ids
FROM order_resource_requirements
WHERE is_active = true
  AND resource_type = 'edge'
  AND edge_type_id IS NOT NULL
GROUP BY order_id, edge_type_id
HAVING COUNT(*) > 1
ORDER BY order_id, edge_type_id;

-- 10. Production status seed/order model conflict: duplicate sort_order values.
SELECT
  'production_statuses_duplicate_sort_order' AS check_name,
  sort_order,
  COUNT(*) AS rows_count,
  array_agg(production_status_id ORDER BY production_status_id) AS production_status_ids,
  array_agg(production_status_code ORDER BY production_status_id) AS production_status_codes,
  array_agg(production_status_name ORDER BY production_status_id) AS production_status_names
FROM production_statuses
GROUP BY sort_order
HAVING COUNT(*) > 1
ORDER BY sort_order;

-- 11. Existing refresh token rows without enough data to assign an auth session.
-- This is expected for legacy tokens; the migration keeps new columns nullable.
SELECT
  'legacy_refresh_tokens_to_bridge' AS check_name,
  COUNT(*) AS rows_count,
  COUNT(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now()) AS active_rows_count,
  MIN(created_at) AS oldest_created_at,
  MAX(created_at) AS newest_created_at
FROM refresh_tokens;

-- 12. Objects that should not exist before additive migration.
-- Any true value here means the migration may already have been partially applied.
SELECT
  'backend_stage1_existing_objects' AS check_name,
  to_regclass('public.auth_sessions') IS NOT NULL AS auth_sessions_exists,
  to_regclass('public.audit_log') IS NOT NULL AS audit_log_exists,
  to_regclass('public.file_uploads') IS NOT NULL AS file_uploads_exists,
  to_regclass('public.integration_jobs') IS NOT NULL AS integration_jobs_exists;

-- 13. Known stale film_vendors reference check.
-- The schema file contains idx_film_vendors__ref_key_1c, but the current model
-- uses vendors for films/materials. If this table exists in DB, inspect whether
-- it is legacy data that still needs migration.
SELECT
  'film_vendors_table_presence' AS check_name,
  to_regclass('public.film_vendors') IS NOT NULL AS film_vendors_exists;
