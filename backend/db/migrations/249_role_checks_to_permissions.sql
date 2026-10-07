-- Access groups 0A.3: role-name checks become permissions, with exactly the former behaviour.
--   bitrix24.requests.view_all      — every Bitrix24 request (was: superadmin, admin, top_manager);
--   bitrix24.requests.view_assigned — requests assigned to the user (was: manager, operator; superadmin and admin get it
--                                     too, as in the static matrix — «all» wins);
--   groups.batch_link               — batch linking of entities to a group (was the role list admin, top_manager;
--                                     superadmin was not in it and stays without it).
-- Catalog rows are added; role grants only where missing (runtime settings of the roles are kept).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

INSERT INTO public.permissions_catalog
  (permission_name, domain, label, description, sort_order, is_dangerous, is_active)
SELECT v.permission_name, v.domain, v.label, v.description,
       (SELECT COALESCE(max(sort_order), 0) FROM public.permissions_catalog) + v.ord, false, true
  FROM (VALUES
    (1, 'bitrix24.requests.view_all', 'bitrix24', 'Заявки Bitrix24: все',
     'Видны все заявки Bitrix24 (без этого права — только назначенные пользователю)'),
    (2, 'bitrix24.requests.view_assigned', 'bitrix24', 'Заявки Bitrix24: назначенные',
     'Видны заявки Bitrix24, назначенные пользователю'),
    (3, 'groups.batch_link', 'groups', 'Группы: пакетная привязка',
     'Пакетная привязка заказов и других записей к группе')
  ) AS v(ord, permission_name, domain, label, description)
ON CONFLICT (permission_name) DO UPDATE SET
  domain = EXCLUDED.domain, label = EXCLUDED.label, description = EXCLUDED.description,
  is_dangerous = EXCLUDED.is_dangerous, is_active = true, updated_at = now();

INSERT INTO public.role_permissions (role_id, permission_name, is_enabled)
SELECT r.role_id, g.permission_name, true
  FROM (VALUES
    ('bitrix24.requests.view_all', 'superadmin'),
    ('bitrix24.requests.view_all', 'admin'),
    ('bitrix24.requests.view_all', 'top_manager'),
    ('bitrix24.requests.view_assigned', 'superadmin'),
    ('bitrix24.requests.view_assigned', 'admin'),
    ('bitrix24.requests.view_assigned', 'manager'),
    ('bitrix24.requests.view_assigned', 'operator'),
    ('groups.batch_link', 'admin'),
    ('groups.batch_link', 'top_manager')
  ) AS g(permission_name, role_code)
  JOIN public.roles r ON r.role_code = g.role_code
ON CONFLICT (role_id, permission_name) DO NOTHING;

UPDATE public.permissions_state SET version = version + 1, updated_at = now() WHERE id = true;

COMMIT;
