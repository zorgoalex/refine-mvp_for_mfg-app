-- Access groups: superadmin gets batch linking of entities to a group (user decision 2026-10-12).
-- Migration 249 kept the former role list (admin, top_manager) and left superadmin without `groups.batch_link`; the
-- backend seed has since stored that as a disabled grant row, which a newer static matrix alone does not flip.
-- Only the superadmin cell changes (also over a manual «off» in the roles matrix — the user's decision); other roles
-- keep their runtime settings. A real change is audited and bumps the permissions version; a re-run changes nothing.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- permissions_state first (same lock order as the roles matrix and migration 249).
SELECT version FROM public.permissions_state WHERE id = true FOR UPDATE;

DO $$
DECLARE
  superadmin_id integer;
  enabled_before boolean;
  version_before integer;
BEGIN
  SELECT role_id INTO superadmin_id FROM public.roles WHERE role_code = 'superadmin';
  IF superadmin_id IS NULL THEN
    RAISE EXCEPTION 'migration 252: role superadmin is missing';
  END IF;
  SELECT is_enabled INTO enabled_before FROM public.role_permissions
   WHERE role_id = superadmin_id AND permission_name = 'groups.batch_link' FOR UPDATE;
  IF enabled_before IS TRUE THEN
    RETURN; -- already granted: nothing changes, nothing is audited
  END IF;
  enabled_before := coalesce(enabled_before, false); -- no row = not granted

  INSERT INTO public.role_permissions (role_id, permission_name, is_enabled)
  VALUES (superadmin_id, 'groups.batch_link', true)
  ON CONFLICT (role_id, permission_name) DO UPDATE SET is_enabled = true, updated_at = now();

  SELECT version INTO version_before FROM public.permissions_state WHERE id = true;
  -- Tokens issued before the grant refresh their permissions.
  UPDATE public.permissions_state SET version = version + 1, updated_at = now() WHERE id = true;

  -- Same event and entity as a roles matrix save (writePermissionsAudit), actor = this migration.
  INSERT INTO public.audit_log (event, entity_type, entity_id, request_id, source, before_json, after_json, diff_json,
                                metadata_json)
  VALUES ('permissions.roles_matrix.update', 'role_permissions_matrix', superadmin_id::text,
          'migration-252', 'migration',
          jsonb_build_object('rolePermissions', jsonb_build_object('superadmin',
            jsonb_build_object('groups.batch_link', enabled_before))),
          jsonb_build_object('rolePermissions', jsonb_build_object('superadmin',
            jsonb_build_object('groups.batch_link', true))),
          jsonb_build_object('rolePermissions.superadmin.groups.batch_link',
            jsonb_build_object('from', enabled_before, 'to', true)),
          jsonb_build_object('correlationId', 'migration-252', 'operation', 'superadmin_group_batch_link',
            'roleId', superadmin_id, 'permissionsVersionBefore', version_before,
            'permissionsVersionAfter', version_before + 1));
END $$;

COMMIT;
