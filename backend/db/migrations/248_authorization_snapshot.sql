-- Access groups, stage 0A (migration M1): one source of a user's effective authorization.
-- Plan: spec_erp/plans/access-groups/2026-10-06-access-groups-plan.md (§3.1, §4 stage 0A).
--
-- Additive only. Until the access-group migration (M2) and the access_groups_enabled switch, the effective
-- authorization of a user equals the authorization of the user's base role (role_permissions +
-- role_policy_scopes), exactly as PermissionsService.loadRoleAuthorization reads it today.
--
-- * user_authorization_snapshot(user_id) — ONE statement (one MVCC snapshot): user, base role, switch,
--   permissions, scopes (as sets) and the authorization version together, so a token can never carry
--   permissions older than its version.
-- * user_effective_permissions / user_effective_scopes — the same logic as rows: for backend SQL that selects
--   users by permission ("who holds procurement.view") and for Hasura `_exists` predicates (stage 0B).
--   Not exposed to client roles.
-- * policy_scope_allowed_values — the allowed (scope_key, scope_value) pairs (ALLOWED_SCOPE_VALUES without
--   'none'); access-group scopes reference it in M2.
-- * permissions_state.access_groups_enabled — the single switch for TypeScript and SQL (false).
-- * users.row_version — stale-write protection of user commands (plan §5.3).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.policy_scope_allowed_values (
  scope_key text NOT NULL,
  scope_value text NOT NULL,
  PRIMARY KEY (scope_key, scope_value),
  CONSTRAINT policy_scope_allowed_values_value_check CHECK (scope_value IN ('all', 'own', 'assigned'))
);

INSERT INTO public.policy_scope_allowed_values (scope_key, scope_value)
VALUES
  ('orders.view', 'all'), ('orders.view', 'own'), ('orders.view', 'assigned'),
  ('orders.update', 'all'), ('orders.update', 'own'), ('orders.update', 'assigned'),
  ('orders.export', 'all'), ('orders.export', 'own'), ('orders.export', 'assigned'),
  ('orders.delete', 'all'), ('orders.delete', 'own'), ('orders.delete', 'assigned'),
  ('payments.view', 'all'), ('payments.view', 'own'),
  ('payments.create', 'all'), ('payments.create', 'own'),
  ('payments.update', 'all'), ('payments.update', 'own'),
  ('payments.delete', 'all'), ('payments.delete', 'own'),
  ('productionTasks.view', 'all'), ('productionTasks.view', 'assigned'),
  ('productionTasks.update', 'all'), ('productionTasks.update', 'assigned')
ON CONFLICT DO NOTHING;

ALTER TABLE public.permissions_state
  ADD COLUMN IF NOT EXISTS access_groups_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 1;

-- Effective permissions per user (M1: base role only). Mirrors loadRoleAuthorization: enabled role grant of an
-- active catalog permission. Inactive users are excluded (they cannot hold a session).
CREATE OR REPLACE VIEW public.user_effective_permissions AS
SELECT u.user_id, rp.permission_name
FROM public.users u
JOIN public.role_permissions rp ON rp.role_id = u.role_id AND rp.is_enabled
JOIN public.permissions_catalog pc ON pc.permission_name = rp.permission_name AND pc.is_active
WHERE u.is_active;

-- Effective scopes per user as rows (M1: base role only); 'none' is not a grant and is omitted.
CREATE OR REPLACE VIEW public.user_effective_scopes AS
SELECT u.user_id, rps.scope_key, rps.scope_value
FROM public.users u
JOIN public.role_policy_scopes rps ON rps.role_id = u.role_id
WHERE u.is_active
  AND rps.scope_value <> 'none';

-- One-statement snapshot. permissions: sorted by catalog order (as loadRoleAuthorization); scopes: every
-- known key → array of granted values (empty array = 'none'). Returns NULL for an unknown user.
CREATE OR REPLACE FUNCTION public.user_authorization_snapshot(p_user_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $function$
  SELECT jsonb_build_object(
    'userId', u.user_id,
    'username', u.username,
    'isActive', u.is_active,
    'isServiceAccount', u.is_service_account,
    'roleId', u.role_id,
    'roleCode', r.role_code,
    'roleIsActive', r.is_active,
    'rowVersion', u.row_version,
    'accessGroupsEnabled', ps.access_groups_enabled,
    'version', ps.version,
    'permissions', COALESCE((
      SELECT jsonb_agg(rp.permission_name ORDER BY pc.sort_order, rp.permission_name)
      FROM public.role_permissions rp
      JOIN public.permissions_catalog pc ON pc.permission_name = rp.permission_name AND pc.is_active
      WHERE rp.role_id = u.role_id AND rp.is_enabled
    ), '[]'::jsonb),
    'scopes', COALESCE((
      SELECT jsonb_object_agg(keys.scope_key, COALESCE((
        SELECT jsonb_agg(rps.scope_value ORDER BY rps.scope_value)
        FROM public.role_policy_scopes rps
        WHERE rps.role_id = u.role_id AND rps.scope_key = keys.scope_key AND rps.scope_value <> 'none'
      ), '[]'::jsonb))
      FROM (SELECT DISTINCT scope_key FROM public.policy_scope_allowed_values) keys
    ), '{}'::jsonb)
  )
  FROM public.users u
  JOIN public.roles r ON r.role_id = u.role_id
  CROSS JOIN public.permissions_state ps
  WHERE u.user_id = p_user_id
    AND ps.id;
$function$;

COMMENT ON FUNCTION public.user_authorization_snapshot(bigint) IS
  'Access groups M1: effective authorization of one user in one statement (base role until M2 + switch).';

COMMIT;
