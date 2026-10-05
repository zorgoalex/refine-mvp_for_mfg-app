-- Role «Оператор интеграции 1С» (onec_operator, role_id 32): a login role that sees only the «Интеграция 1С»
-- section. Plan: spec 2026-10-05-onec-operator-role.
--
-- The role is assigned only when a user is created. A trigger rejects changing an existing user's role to or from
-- it on every write path (backend, Hasura, SQL): such a change would leave tokens of the previous role alive.
-- Rollback of the role: 245_onec_operator_role_rollback.sql (manual, before switching the backend image back).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.roles WHERE role_id = 32 AND role_code <> 'onec_operator') THEN
    RAISE EXCEPTION 'migration 245: role_id 32 is taken by another role';
  END IF;
  IF EXISTS (SELECT 1 FROM public.roles WHERE role_code = 'onec_operator' AND role_id <> 32) THEN
    RAISE EXCEPTION 'migration 245: role_code onec_operator exists with another role_id';
  END IF;
END $$;

INSERT INTO public.roles (role_id, role_code, role_name, role_description, is_active)
VALUES (32, 'onec_operator', 'Оператор интеграции 1С',
        'Login role limited to the 1C integration section (agents, configuration, commands, data copy)', true)
ON CONFLICT (role_id) DO NOTHING;

-- Never moves the identity sequence backwards.
SELECT setval('public.roles_role_id_seq',
              GREATEST((SELECT last_value FROM public.roles_role_id_seq), (SELECT max(role_id) FROM public.roles)));

-- The six permissions of the role; the backend seeds every other catalog permission as disabled.
INSERT INTO public.role_permissions (role_id, permission_name, is_enabled)
SELECT 32, pc.permission_name, true
FROM public.permissions_catalog pc
WHERE pc.permission_name IN ('profile.view', 'profile.update_own', 'sessions.logout_own',
                             'onec.view', 'onec.manage', 'onec.commands.send')
ON CONFLICT (role_id, permission_name) DO NOTHING;

INSERT INTO public.role_policy_scopes (role_id, scope_key, scope_value)
SELECT 32, key, 'none'
FROM unnest(ARRAY['orders.view', 'orders.update', 'orders.export', 'orders.delete',
                  'payments.view', 'payments.create', 'payments.update', 'payments.delete',
                  'productionTasks.view', 'productionTasks.update']) AS key
ON CONFLICT (role_id, scope_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.users_onec_operator_role_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  role_active boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.role_id IS NOT DISTINCT FROM OLD.role_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.role_id = 32 OR NEW.role_id = 32)
     AND coalesce(current_setting('app.onec_operator_role_maintenance', true), '') <> 'on' THEN
    RAISE EXCEPTION 'ONEC_OPERATOR_ROLE_TRANSITION: role onec_operator is assigned only at user creation (user_id %)', OLD.user_id
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.role_id = 32 THEN
    -- FOR SHARE serialises new operators with the rollback script, which switches the role off first.
    SELECT is_active INTO role_active FROM public.roles WHERE role_id = 32 FOR SHARE;
    IF role_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'ONEC_OPERATOR_ROLE_DISABLED: role onec_operator is switched off'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_users_onec_operator_role_guard ON public.users;
CREATE TRIGGER trg_users_onec_operator_role_guard
  BEFORE INSERT OR UPDATE OF role_id ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_onec_operator_role_guard();

COMMENT ON FUNCTION public.users_onec_operator_role_guard() IS
  'Role 32 (onec_operator): assigned only at user creation; no transitions to or from it; no new assignments while the role is inactive';

COMMIT;
