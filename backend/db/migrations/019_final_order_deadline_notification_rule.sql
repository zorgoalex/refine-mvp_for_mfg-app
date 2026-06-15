-- Migration 019: final order deadline notification rule seed (disabled)
-- Prepares the first product-approved final-order Deadline notification rule.
-- The rule is inserted disabled by default because runtime enablement and
-- reconciliation with broad 015 parity rules require a separate operator window.
-- This is data configuration only: no runtime flags, no worker/relay execution,
-- no order mutation, no notification creation.
BEGIN;

INSERT INTO notification_rules (
  rule_code,
  event_type,
  is_enabled,
  priority,
  level,
  conditions_json,
  recipients_json,
  title_template,
  message_template
)
VALUES (
  'deadline-final-order-expired-manager',
  'DEADLINE_EXPIRED',
  false, -- is_enabled: prepared only, enable in a separate operator window
  90,
  'warning',
  '{"deadlineEntityTypes":["order"],"excludeOrderStatusIds":[7],"excludeCompletedOrders":true,"requireCurrentDeadlineEvent":true}'::jsonb,
  '{"resolvers":["order_manager"]}'::jsonb,
  'Просрочен срок заказа',
  'Заказ {orderId} просрочен. Проверьте срок выполнения.'
)
ON CONFLICT (rule_code) DO NOTHING;

COMMIT;
