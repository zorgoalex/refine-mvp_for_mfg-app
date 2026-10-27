-- Экран «Контакты клиентов»: виды контактов клиента WhatsApp, Viber, Instagram и «Другое» (с подписью) и права экрана.
-- Additive. client_contacts keeps its rows; only its kind / value checks get wider. The previous backend reads the new
-- kinds as unknown and rejects saving them (its rollback is gated by BACKEND_CLIENT_CONTACT_EXTRA_KINDS, see the plan).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- permissions_state first (same lock order as the roles matrix and migrations 249/251/252/253/267).
SELECT version FROM public.permissions_state WHERE id = true FOR UPDATE;

-- Swapping a check takes ACCESS EXCLUSIVE: taken up front, failing at once (run again) instead of queueing readers
-- of the contacts behind a waiting lock.
LOCK TABLE public.client_contacts IN ACCESS EXCLUSIVE MODE NOWAIT;

-- 236 created the checks inline with default names: the kind check is client_contacts_kind_check, the value check
-- (two columns) client_contacts_check. A rerun finds the new names and replaces them the same way.
ALTER TABLE public.client_contacts DROP CONSTRAINT IF EXISTS client_contacts_kind_check;
ALTER TABLE public.client_contacts DROP CONSTRAINT IF EXISTS client_contacts_check;
ALTER TABLE public.client_contacts DROP CONSTRAINT IF EXISTS ck_client_contacts_kind;
ALTER TABLE public.client_contacts DROP CONSTRAINT IF EXISTS ck_client_contacts_value_normalized;
ALTER TABLE public.client_contacts DROP CONSTRAINT IF EXISTS ck_client_contacts_other_note;

-- NOT VALID: no scan under ACCESS EXCLUSIVE; new and changed rows are checked at once, old rows by VALIDATE below.
ALTER TABLE public.client_contacts ADD CONSTRAINT ck_client_contacts_kind
  CHECK (kind IN ('email', 'telegram', 'whatsapp', 'viber', 'instagram', 'other')) NOT VALID;
ALTER TABLE public.client_contacts ADD CONSTRAINT ck_client_contacts_value_normalized CHECK (
  (kind = 'email' AND value_normalized ~ '^[^@[:space:]]+@[^@[:space:]]+$' AND value_normalized = lower(value_normalized))
  OR (kind = 'telegram' AND value_normalized ~ '^[a-z0-9_]{5,32}$')
  OR (kind IN ('whatsapp', 'viber') AND value_normalized ~ '^7[0-9]{10}$')
  OR (kind = 'instagram' AND value_normalized ~ '^[a-z0-9._]{1,30}$')
  OR (kind = 'other' AND char_length(value_normalized) BETWEEN 1 AND 200 AND value_normalized = lower(value_normalized))) NOT VALID;
-- «Другое» is read by its label: «VK», «Skype».
ALTER TABLE public.client_contacts ADD CONSTRAINT ck_client_contacts_other_note
  CHECK (kind <> 'other' OR (note IS NOT NULL AND btrim(note) <> '')) NOT VALID;

INSERT INTO public.permissions_catalog
  (permission_name, domain, label, description, sort_order, is_dangerous, is_active)
SELECT v.permission_name, v.domain, v.label, v.description,
       (SELECT COALESCE(max(sort_order), 0) FROM public.permissions_catalog) + v.ord, false, true
  FROM (VALUES
    (1, 'clients.contacts.view', 'clients', 'Клиенты: экран «Контакты клиентов»',
     'Список телефонов, email и мессенджеров всех клиентов с поиском и фильтрами'),
    (2, 'clients.contacts.manage', 'clients', 'Клиенты: правка на экране «Контакты клиентов»',
     'Менять телефоны, email и мессенджеры клиентов прямо в списке')
  ) AS v(ord, permission_name, domain, label, description)
ON CONFLICT (permission_name) DO UPDATE SET
  domain = EXCLUDED.domain, label = EXCLUDED.label, description = EXCLUDED.description,
  is_dangerous = EXCLUDED.is_dangerous, is_active = true, updated_at = now();

DO $$
DECLARE
  granted jsonb := '{}'::jsonb;
  before_json jsonb := '{}'::jsonb;
  diff jsonb := '{}'::jsonb;
  role_ids integer[] := '{}';
  r record;
  version_before integer;
BEGIN
  FOR r IN
    WITH inserted AS (
      INSERT INTO public.role_permissions (role_id, permission_name, is_enabled)
      SELECT ro.role_id, p.permission_name, true
        FROM public.roles ro
        CROSS JOIN (VALUES ('clients.contacts.view'), ('clients.contacts.manage')) AS p(permission_name)
       WHERE ro.role_code IN ('superadmin', 'admin', 'top_manager')
      ON CONFLICT (role_id, permission_name) DO NOTHING
      RETURNING role_id, permission_name
    )
    SELECT i.role_id, i.permission_name, ro.role_code FROM inserted i JOIN public.roles ro USING (role_id)
     ORDER BY ro.role_code, i.permission_name
  LOOP
    granted := jsonb_set(granted, ARRAY[r.role_code], COALESCE(granted -> r.role_code, '{}'::jsonb) || jsonb_build_object(r.permission_name, true));
    before_json := jsonb_set(before_json, ARRAY[r.role_code], COALESCE(before_json -> r.role_code, '{}'::jsonb) || jsonb_build_object(r.permission_name, false));
    diff := diff || jsonb_build_object('rolePermissions.' || r.role_code || '.' || r.permission_name,
                                       jsonb_build_object('from', false, 'to', true));
    IF NOT r.role_id = ANY (role_ids) THEN role_ids := role_ids || r.role_id; END IF;
  END LOOP;

  IF cardinality(role_ids) = 0 THEN
    RETURN; -- all grants already present: nothing changes, nothing is audited
  END IF;

  SELECT version INTO version_before FROM public.permissions_state WHERE id = true;
  UPDATE public.permissions_state SET version = version + 1, updated_at = now() WHERE id = true;

  INSERT INTO public.audit_log (event, entity_type, entity_id, request_id, source, before_json, after_json, diff_json,
                                metadata_json)
  VALUES ('permissions.roles_matrix.update', 'role_permissions_matrix', 'all',
          'migration-269', 'migration',
          jsonb_build_object('rolePermissions', before_json),
          jsonb_build_object('rolePermissions', granted),
          diff,
          jsonb_build_object('correlationId', 'migration-269', 'operation', 'client_contacts_screen_permissions',
            'roleIds', to_jsonb(role_ids), 'permissionsVersionBefore', version_before,
            'permissionsVersionAfter', version_before + 1));
END $$;

COMMIT;

-- Old rows against the new checks: SHARE UPDATE EXCLUSIVE only (reads and writes go on). A failure here leaves the
-- checks NOT VALID but enforced for new rows; running the whole file again repeats both phases.
SET lock_timeout = '5s';
SET statement_timeout = '60s';
ALTER TABLE public.client_contacts VALIDATE CONSTRAINT ck_client_contacts_kind;
ALTER TABLE public.client_contacts VALIDATE CONSTRAINT ck_client_contacts_value_normalized;
ALTER TABLE public.client_contacts VALIDATE CONSTRAINT ck_client_contacts_other_note;
RESET lock_timeout;
RESET statement_timeout;
