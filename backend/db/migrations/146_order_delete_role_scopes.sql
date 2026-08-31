BEGIN;

WITH desired(role_code, scope_value) AS (
  VALUES
    ('top_manager', 'all'),
    ('manager', 'own')
)
INSERT INTO role_permissions (role_id, permission_name, is_enabled, updated_at)
SELECT roles.role_id, 'orders.delete', true, now()
FROM roles
JOIN desired ON desired.role_code = roles.role_code
ON CONFLICT (role_id, permission_name) DO UPDATE
SET is_enabled = EXCLUDED.is_enabled,
    updated_at = EXCLUDED.updated_at;

WITH desired(role_code, scope_value) AS (
  VALUES
    ('top_manager', 'all'),
    ('manager', 'own')
)
INSERT INTO role_policy_scopes (role_id, scope_key, scope_value, updated_at)
SELECT roles.role_id, 'orders.delete', desired.scope_value, now()
FROM roles
JOIN desired ON desired.role_code = roles.role_code
ON CONFLICT (role_id, scope_key) DO UPDATE
SET scope_value = EXCLUDED.scope_value,
    updated_at = EXCLUDED.updated_at;

UPDATE permissions_state
SET version = version + 1,
    updated_at = now()
WHERE id = true;

COMMIT;
