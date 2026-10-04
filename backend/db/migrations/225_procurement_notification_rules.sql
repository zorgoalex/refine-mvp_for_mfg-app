-- Экран снабжения, фаза 4б (план spec_erp/plans/order_resource_req/2026-09-28-procurement-workspace-plan.md §5.7):
-- правило «Материал пришёл по заказу» — распределение прихода 1С на заказ → in_app ответственному по заказу.
-- Засевается ВЫКЛЮЧЕННЫМ: включение — на экране правил (решение пользователя В-4) и только вместе с флагом
-- BACKEND_PROCUREMENT_NOTIFICATIONS_ENABLED (движок проверяет его в момент обработки события).
-- Только данные конфигурации: без изменений схемы, без уведомлений, без событий.
BEGIN;

INSERT INTO notification_rules (
  rule_code,
  event_type,
  is_enabled,
  priority,
  level,
  conditions_json,
  recipients_json,
  channels_json,
  title_template,
  message_template
)
VALUES (
  'procurement-material-arrived',
  'order.resource_procurement_changed',
  false, -- is_enabled: включается на экране правил
  100,
  'info',
  '{"procurementChangeTypes":["allocation_added"],"allocationRoles":["receipt"]}'::jsonb,
  '{"resolvers":["order_manager"]}'::jsonb,
  '["in_app"]'::jsonb,
  'Материал пришёл по заказу',
  'Приход из 1С распределён на заказ {orderId}.'
)
ON CONFLICT (rule_code) DO NOTHING;

COMMIT;
