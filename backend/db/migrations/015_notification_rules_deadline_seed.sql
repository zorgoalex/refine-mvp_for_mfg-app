-- Migration 015: notification rules deadline convergence seed (additive)
-- Seeds default parity rules for the deadline convergence cutover. Idempotent
-- (ON CONFLICT DO NOTHING) so it is safe to re-apply or run after the
-- admin UI has already created rules with the same codes. The
-- cutover itself is opt-in (BACKEND_NOTIFICATION_ENGINE_OWNS_DEADLINE=false
-- by default); this migration only inserts rule rows, it does not change
-- engine ownership of any event type.
--
-- Does NOT alter notification_rules, outbox_events, or notifications schema.
--
-- Rule parity is documented in
-- spec_erp/plans/2026-06-10-notification-engine-convergence-decisions.md
-- §3 (parity matrix) and §6.4 (seed codes):
--   - deadline-expired-notify-manager        (legacy notify_manager)
--   - deadline-expired-notify-assignee       (legacy notify_assignee)
--   - deadline-expired-project-participants  (legacy P8 PROJECT_DEADLINE_OVERDUE)
--   - deadline-expired-escalate-manager      (legacy escalate)
-- notify_department_head is intentionally NOT seeded (no org model in schema v14).
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
VALUES
  (
    'deadline-expired-notify-manager',
    'DEADLINE_EXPIRED',
    true,
    100,
    'warning',
    '{"excludeCompletedOrders": true}'::jsonb,
    '{"resolvers": ["order_manager"]}'::jsonb,
    'Deadline expired',
    'Order {orderId} deadline expired'
  ),
  (
    'deadline-expired-notify-assignee',
    'DEADLINE_EXPIRED',
    true,
    100,
    'warning',
    '{"excludeCompletedOrders": true}'::jsonb,
    '{"resolvers": ["stage_assignee"]}'::jsonb,
    'Deadline expired',
    'Order {orderId} deadline expired'
  ),
  (
    'deadline-expired-project-participants',
    'DEADLINE_EXPIRED',
    true,
    100,
    'warning',
    '{}'::jsonb,
    '{"resolvers": ["project_participants"]}'::jsonb,
    'Project deadline overdue',
    'Project linked to order {orderId} has an overdue deadline'
  ),
  (
    'deadline-expired-escalate-manager',
    'DEADLINE_EXPIRED',
    true,
    200,
    'error',
    '{}'::jsonb,
    '{"resolvers": ["order_manager"]}'::jsonb,
    'Deadline escalation',
    'Order {orderId} deadline escalated'
  )
ON CONFLICT (rule_code) DO NOTHING;

COMMIT;
