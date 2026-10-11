-- «Отправить в чат» из шапки дня календаря — отдельным правом (решение пользователя 11.10: отправлять может
-- топ-менеджер и выше, менеджеру право не нужно).
--   whatsapp.calendar_send — поставить карточки заказов дня в очередь отправки в настроенный чат.
-- Настройки отправки из календаря (группа, подпись, интервал) и рассылки остаются за whatsapp.manage.
-- По умолчанию: superadmin, admin, top_manager. Кроме того, право получает каждая роль, у которой сейчас включено
-- whatsapp.manage: до этой миграции именно оно открывало кнопку, и ни одна роль её не теряет.
-- Catalog row is added; role grants only where missing (runtime settings are kept).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Lock order of authorization changes: permissions_state first, as the roles matrix does before its seed —
-- otherwise this migration (catalog → state) and a matrix save (state → catalog) can deadlock.
SELECT version FROM public.permissions_state WHERE id = true FOR UPDATE;

INSERT INTO public.permissions_catalog
  (permission_name, domain, label, description, sort_order, is_dangerous, is_active)
SELECT 'whatsapp.calendar_send', 'whatsapp', 'WhatsApp: отправка из календаря',
       'Кнопка «Отправить в чат» в шапке дня календаря: карточки заказов дня уходят в настроенный чат (нужны также просмотр календаря, заказов и их финансов)',
       (SELECT COALESCE(max(sort_order), 0) FROM public.permissions_catalog) + 1, false, true
ON CONFLICT (permission_name) DO UPDATE SET
  domain = EXCLUDED.domain, label = EXCLUDED.label, description = EXCLUDED.description,
  is_dangerous = EXCLUDED.is_dangerous, is_active = true, updated_at = now();

INSERT INTO public.role_permissions (role_id, permission_name, is_enabled)
SELECT r.role_id, g.permission_name, true
  FROM (VALUES
    ('whatsapp.calendar_send', 'superadmin'),
    ('whatsapp.calendar_send', 'admin'),
    ('whatsapp.calendar_send', 'top_manager')
  ) AS g(permission_name, role_code)
  JOIN public.roles r ON r.role_code = g.role_code
ON CONFLICT (role_id, permission_name) DO NOTHING;

-- Roles that could send from the calendar before (the button needed whatsapp.manage) keep it.
INSERT INTO public.role_permissions (role_id, permission_name, is_enabled)
SELECT rp.role_id, 'whatsapp.calendar_send', true
  FROM public.role_permissions rp
 WHERE rp.permission_name = 'whatsapp.manage' AND rp.is_enabled
ON CONFLICT (role_id, permission_name) DO NOTHING;

-- The system broadcast of the calendar send names the bundle its runs need: the new backend writes it on every
-- calendar run itself, and a backend of the previous release (rollback) copies it from this row.
-- version and updated_at are not touched: the settings form keeps its compare-and-swap.
UPDATE public.whatsapp_broadcasts
   SET required_permissions = ARRAY['whatsapp.calendar_send', 'calendar.view', 'orders.view', 'orders.view_financials']
 WHERE purpose = 'calendar'
   AND required_permissions IS DISTINCT FROM ARRAY['whatsapp.calendar_send', 'calendar.view', 'orders.view', 'orders.view_financials'];

UPDATE public.permissions_state SET version = version + 1, updated_at = now() WHERE id = true;

COMMIT;
