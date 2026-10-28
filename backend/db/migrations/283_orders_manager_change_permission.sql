-- Change the manager of an order behind its own permission (user decision 2026-10-28: administrators by default,
-- configurable in the roles matrix). The manager of an order (orders.manager_id → users) owns the order's «own»
-- visibility and its Bitrix24 responsible user, so choosing another one is a separate right.
--   orders.manager.change — choose another ERP user as the manager of an order (save-order, snapshot import).
-- Catalog row is added; role grants only where missing (runtime settings are kept). Every grant written is audited and
-- bumps the permissions version once; a re-run changes nothing.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- permissions_state first (same lock order as the roles matrix and migrations 249/251/252/253).
SELECT version FROM public.permissions_state WHERE id = true FOR UPDATE;

INSERT INTO public.permissions_catalog
  (permission_name, domain, label, description, sort_order, is_dangerous, is_active)
SELECT 'orders.manager.change', 'orders', 'Заказы: смена менеджера',
       'Выбрать другого пользователя менеджером заказа (менеджер определяет, кто видит заказ как «свой», и ответственного в Bitrix24); включает правку заказов',
       (SELECT COALESCE(max(sort_order), 0) FROM public.permissions_catalog) + 1, false, true
ON CONFLICT (permission_name) DO UPDATE SET
  domain = EXCLUDED.domain, label = EXCLUDED.label, description = EXCLUDED.description,
  is_dangerous = EXCLUDED.is_dangerous, is_active = true, updated_at = now();

DO $$
DECLARE
  granted jsonb := '{}'::jsonb;
  diff jsonb := '{}'::jsonb;
  role_ids integer[] := '{}';
  r record;
  version_before integer;
BEGIN
  FOR r IN
    WITH inserted AS (
      INSERT INTO public.role_permissions (role_id, permission_name, is_enabled)
      SELECT ro.role_id, 'orders.manager.change', true
        FROM public.roles ro
       WHERE ro.role_code IN ('superadmin', 'admin')
      ON CONFLICT (role_id, permission_name) DO NOTHING
      RETURNING role_id
    )
    SELECT i.role_id, ro.role_code FROM inserted i JOIN public.roles ro USING (role_id) ORDER BY ro.role_code
  LOOP
    granted := granted || jsonb_build_object(r.role_code, jsonb_build_object('orders.manager.change', true));
    diff := diff || jsonb_build_object('rolePermissions.' || r.role_code || '.orders.manager.change',
                                       jsonb_build_object('from', false, 'to', true));
    role_ids := role_ids || r.role_id;
  END LOOP;

  IF cardinality(role_ids) = 0 THEN
    RETURN; -- all grants already present: nothing changes, nothing is audited
  END IF;

  SELECT version INTO version_before FROM public.permissions_state WHERE id = true;
  -- Tokens issued before the grant refresh their permissions.
  UPDATE public.permissions_state SET version = version + 1, updated_at = now() WHERE id = true;

  -- Same event and entity as a roles matrix save (writePermissionsAudit), actor = this migration.
  INSERT INTO public.audit_log (event, entity_type, entity_id, request_id, source, before_json, after_json, diff_json,
                                metadata_json)
  VALUES ('permissions.roles_matrix.update', 'role_permissions_matrix', 'all',
          'migration-283', 'migration',
          jsonb_build_object('rolePermissions', (SELECT jsonb_object_agg(k, jsonb_build_object('orders.manager.change', false))
                                                   FROM jsonb_object_keys(granted) k)),
          jsonb_build_object('rolePermissions', granted),
          diff,
          jsonb_build_object('correlationId', 'migration-283', 'operation', 'orders_manager_change_permission',
            'roleIds', to_jsonb(role_ids), 'permissionsVersionBefore', version_before,
            'permissionsVersionAfter', version_before + 1));
END $$;

COMMIT;
