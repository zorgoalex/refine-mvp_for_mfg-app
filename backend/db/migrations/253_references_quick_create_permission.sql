-- Access groups 0Б: adding an edge type, a milling type or a film from an order behind its own permission
-- (user decision 2026-10-14). Until now any role with a Hasura insert on edge_types / milling_types / films could do it
-- (manager, operator, top_manager, superadmin, admin); Hasura now requires references.manage or this permission, so
-- these roles get it and nobody loses the quick add. Editing and deleting reference rows stays behind references.manage.
--   references.quick_create — insert a new edge type / milling type / film from the order form.
-- Catalog row is added; role grants only where missing (runtime settings are kept). Every grant written is audited and
-- bumps the permissions version once; a re-run changes nothing. Also adds permissions_state.hasura_access_predicates.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- permissions_state first (same lock order as the roles matrix and migrations 249/251/252).
SELECT version FROM public.permissions_state WHERE id = true FOR UPDATE;

-- Whether Hasura follows the effective permissions (ops/hasura/access-predicates.sh step B sets it, revert clears it).
-- While it is false the backend refuses every narrowing of the roles matrix: Hasura would keep serving what was taken.
ALTER TABLE public.permissions_state
  ADD COLUMN IF NOT EXISTS hasura_access_predicates boolean NOT NULL DEFAULT false;

INSERT INTO public.permissions_catalog
  (permission_name, domain, label, description, sort_order, is_dangerous, is_active)
SELECT 'references.quick_create', 'references', 'Справочники: быстрое добавление из заказа',
       'Добавить новую кромку, фрезеровку или плёнку прямо из формы заказа (правка и удаление справочников — «Справочники: управление»)',
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
      SELECT ro.role_id, 'references.quick_create', true
        FROM public.roles ro
       WHERE ro.role_code IN ('superadmin', 'admin', 'top_manager', 'manager', 'operator')
      ON CONFLICT (role_id, permission_name) DO NOTHING
      RETURNING role_id
    )
    SELECT i.role_id, ro.role_code FROM inserted i JOIN public.roles ro USING (role_id) ORDER BY ro.role_code
  LOOP
    granted := granted || jsonb_build_object(r.role_code, jsonb_build_object('references.quick_create', true));
    diff := diff || jsonb_build_object('rolePermissions.' || r.role_code || '.references.quick_create',
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
          'migration-253', 'migration',
          jsonb_build_object('rolePermissions', (SELECT jsonb_object_agg(k, jsonb_build_object('references.quick_create', false))
                                                   FROM jsonb_object_keys(granted) k)),
          jsonb_build_object('rolePermissions', granted),
          diff,
          jsonb_build_object('correlationId', 'migration-253', 'operation', 'references_quick_create_permission',
            'roleIds', to_jsonb(role_ids), 'permissionsVersionBefore', version_before,
            'permissionsVersionAfter', version_before + 1));
END $$;

COMMIT;
