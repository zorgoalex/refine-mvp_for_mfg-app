-- MANUAL rollback of the role «Оператор интеграции 1С» (role_id 32). Not applied by ops/apply-migrations.sh.
-- Run BEFORE switching the backend image to a build that does not know the role: that build fails on any user
-- (active or not) whose role is 32.
--
--   psql -X -v ON_ERROR_STOP=1 -v actor_id=<user_id of the admin who performs it> -f 245_onec_operator_role_rollback.sql
--
-- One transaction: switches the role off (from that moment nobody can be created with it — the trigger of
-- migration 245 waits on this row), deactivates every account that has it and moves it to «viewer», writes one
-- audit row per account plus one for the role, and fails unless no assignment of role 32 is left.
-- The role row, its permissions and the trigger stay. To use the role again: set roles.is_active = true and create
-- NEW accounts.
\if :{?actor_id}
\else
  \echo 'actor_id is required: -v actor_id=<user_id of an active admin/superadmin>'
  \quit
\endif

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SET LOCAL app.onec_operator_role_maintenance = 'on';
SELECT set_config('app.onec_rollback_actor_id', (:actor_id)::bigint::text, true);
SELECT set_config('app.onec_rollback_operation_id', 'maintenance-onec-operator-rollback-' || gen_random_uuid()::text, true);

DO $$
DECLARE
  actor_id bigint := current_setting('app.onec_rollback_actor_id')::bigint;
  operation_id text := current_setting('app.onec_rollback_operation_id');
  actor record;
  target record;
  audit uuid;
  remaining bigint;
  role_was_active boolean;
BEGIN
  SELECT u.user_id, u.username, r.role_code INTO actor
  FROM public.users u JOIN public.roles r ON r.role_id = u.role_id
  WHERE u.user_id = actor_id AND u.is_active AND NOT u.is_service_account AND r.role_code IN ('admin', 'superadmin');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback 245: actor % is not an active admin/superadmin user', actor_id;
  END IF;
  IF to_regprocedure('set_session_user(bigint)') IS NOT NULL THEN
    PERFORM set_session_user(actor_id);
  END IF;

  -- Waits for in-flight creations of operators (they hold FOR SHARE on this row); later ones are rejected.
  SELECT is_active INTO role_was_active FROM public.roles WHERE role_id = 32 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback 245: role 32 does not exist';
  END IF;
  IF role_was_active THEN
    UPDATE public.roles SET is_active = false WHERE role_id = 32;
    INSERT INTO public.audit_log (event, entity_type, entity_id, user_id, username, role_code, role, request_id, source,
                                  before_json, after_json, diff_json, metadata_json)
    VALUES ('roles.onec_operator.disabled', 'role', '32', actor.user_id, actor.username, actor.role_code, actor.role_code,
            operation_id, 'maintenance',
            jsonb_build_object('isActive', true), jsonb_build_object('isActive', false),
            jsonb_build_object('isActive', jsonb_build_object('from', true, 'to', false)),
            jsonb_build_object('correlationId', operation_id, 'operation', 'onec_operator_role_rollback'));
  END IF;
  -- A re-run finds the role already off: nothing changed, nothing is audited.

  FOR target IN
    SELECT user_id, is_active FROM public.users WHERE role_id = 32 ORDER BY user_id FOR UPDATE
  LOOP
    UPDATE public.users SET role_id = 100, is_active = false, edited_by = actor_id WHERE user_id = target.user_id;
    INSERT INTO public.audit_log (event, entity_type, entity_id, user_id, username, role_code, role, request_id, source,
                                  related_user_id, before_json, after_json, diff_json, metadata_json)
    VALUES ('users.onec_operator_role_rollback', 'user', target.user_id::text, actor.user_id, actor.username,
            actor.role_code, actor.role_code, operation_id, 'maintenance', target.user_id,
            jsonb_build_object('role', 'onec_operator', 'isActive', target.is_active),
            jsonb_build_object('role', 'viewer', 'isActive', false),
            jsonb_build_object('role', jsonb_build_object('from', 'onec_operator', 'to', 'viewer'),
                               'isActive', jsonb_build_object('from', target.is_active, 'to', false)),
            jsonb_build_object('correlationId', operation_id, 'operation', 'onec_operator_role_rollback'))
    RETURNING audit_id INTO audit;
    INSERT INTO public.audit_log_related_entity (audit_id, entity_type, entity_id)
    VALUES (audit, 'user', target.user_id);
    -- Same statements as the backend's user deactivation (revokeActiveSessions).
    UPDATE public.auth_sessions SET status = 'revoked', revoked_at = now(), revoke_reason = 'user_management'
    WHERE user_id = target.user_id AND status = 'active';
    UPDATE public.refresh_tokens SET revoked_at = now(), revoked_reason = 'user_management'
    WHERE user_id = target.user_id AND revoked_at IS NULL;
  END LOOP;

  SELECT count(*) INTO remaining FROM public.users WHERE role_id = 32;
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'rollback 245: % assignments of role 32 remain', remaining;
  END IF;
  RAISE NOTICE 'role 32 assignments: 0 (operation %)', operation_id;
END $$;

COMMIT;
