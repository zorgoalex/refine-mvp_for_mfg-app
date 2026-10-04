-- Экран снабжения, фаза 4б-2 (план spec_erp/plans/order_resource_req/2026-09-28-procurement-workspace-plan.md §5.7
-- п.2, п.4): три правила, засеянные ВЫКЛЮЧЕННЫМИ (включение — на экране правил, вместе с флагом
-- BACKEND_PROCUREMENT_NOTIFICATIONS_ENABLED):
--  * «Потребность изменилась после закупа» — событие сканера закупа → ответственному по заказу (in_app);
--  * «Сводка дефицита» и «Приход не распределён» — уведомления пишет сервис закупа по расписанию; правило — только
--    включатель, получатели — по праву (procurement.manage / procurement.view), поэтому recipients пустые.
-- Только данные конфигурации: без изменений схемы, без уведомлений, без событий.
BEGIN;

INSERT INTO notification_rules (
  rule_code, event_type, is_enabled, priority, level, conditions_json, recipients_json, channels_json, title_template, message_template
)
VALUES
  ('procurement-demand-changed', 'order.resource_demand_changed_after_mark', false, 100, 'warning',
   '{}'::jsonb, '{"resolvers":["order_manager"]}'::jsonb, '["in_app"]'::jsonb,
   'Потребность изменилась после закупа',
   'По заказу {orderId} изменилась потребность в материале, отмеченном «Закуплено». Проверьте закупку.'),
  ('procurement-deficit-digest', 'procurement.deficit_digest', false, 100, 'info',
   '{}'::jsonb, '{}'::jsonb, '["in_app"]'::jsonb, NULL, NULL),
  ('procurement-receipt-unallocated', 'procurement.receipt_unallocated', false, 100, 'info',
   '{}'::jsonb, '{}'::jsonb, '["in_app"]'::jsonb, NULL, NULL)
ON CONFLICT (rule_code) DO NOTHING;

COMMIT;
