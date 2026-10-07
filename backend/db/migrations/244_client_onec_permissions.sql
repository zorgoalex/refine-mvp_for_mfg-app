-- Данные контрагента 1С в карточке клиента — отдельными правами (решение пользователя 08.10: «все контактные
-- данные клиента из 1С видят начиная от менеджера и старше»).
--   clients.onec_data.view      — телефоны, email, адреса, БИН/ИИН контрагента 1С в карточке клиента;
--   clients.onec_documents.view — раздел «Документы 1С» сопоставленного контрагента (суммы — дополнительно по
--                                 orders.view_financials).
-- По умолчанию: superadmin, admin, top_manager, manager. Оператор, рабочий, упаковщик, наблюдатель и оператор 1С
-- этих прав не получают. Catalog rows are added; role grants only where missing (runtime settings are kept).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Lock order of authorization changes: permissions_state first, as the roles matrix does before its seed —
-- otherwise this migration (catalog → state) and a matrix save (state → catalog) can deadlock.
SELECT version FROM public.permissions_state WHERE id = true FOR UPDATE;

INSERT INTO public.permissions_catalog
  (permission_name, domain, label, description, sort_order, is_dangerous, is_active)
SELECT v.permission_name, v.domain, v.label, v.description,
       (SELECT COALESCE(max(sort_order), 0) FROM public.permissions_catalog) + v.ord, false, true
  FROM (VALUES
    (1, 'clients.onec_data.view', 'clients', 'Клиенты: данные контрагента 1С',
     'Телефоны, email, адреса и БИН/ИИН сопоставленного контрагента 1С в карточке клиента'),
    (2, 'clients.onec_documents.view', 'clients', 'Клиенты: документы 1С',
     'Раздел «Документы 1С» сопоставленного контрагента в карточке клиента (суммы — при праве видеть финансы заказов)')
  ) AS v(ord, permission_name, domain, label, description)
ON CONFLICT (permission_name) DO UPDATE SET
  domain = EXCLUDED.domain, label = EXCLUDED.label, description = EXCLUDED.description,
  is_dangerous = EXCLUDED.is_dangerous, is_active = true, updated_at = now();

INSERT INTO public.role_permissions (role_id, permission_name, is_enabled)
SELECT r.role_id, g.permission_name, true
  FROM (VALUES
    ('clients.onec_data.view', 'superadmin'),
    ('clients.onec_data.view', 'admin'),
    ('clients.onec_data.view', 'top_manager'),
    ('clients.onec_data.view', 'manager'),
    ('clients.onec_documents.view', 'superadmin'),
    ('clients.onec_documents.view', 'admin'),
    ('clients.onec_documents.view', 'top_manager'),
    ('clients.onec_documents.view', 'manager')
  ) AS g(permission_name, role_code)
  JOIN public.roles r ON r.role_code = g.role_code
ON CONFLICT (role_id, permission_name) DO NOTHING;

UPDATE public.permissions_state SET version = version + 1, updated_at = now() WHERE id = true;

COMMIT;
