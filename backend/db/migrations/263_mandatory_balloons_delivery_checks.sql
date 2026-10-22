-- Оповещения 1С → уведомления, срез 0 (план spec_erp/plans/1c-agent/2026-10-19-onec-alert-notifications-plan.md
-- §2.7–2.9): только добавление.
--   * notifications.balloon_mode: новый режим 'mandatory' (без таймера, закрывается только крестиком, выдаётся без
--     ограничения возраста и независимо от прочтения; только клиентам, заявившим возможность).
--   * notification_channel_deliveries: required_permission и expires_at — воркер внешнего канала перепроверяет право
--     получателя и срок годности перед отправкой (NULL у прежних строк — поведение не меняется).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS chk_notifications_balloon_mode;
ALTER TABLE public.notifications ADD CONSTRAINT chk_notifications_balloon_mode
  CHECK (balloon_mode IS NULL OR balloon_mode IN ('auto', 'persistent', 'mandatory')) NOT VALID;
ALTER TABLE public.notifications VALIDATE CONSTRAINT chk_notifications_balloon_mode;
-- Выдача обязательных балунов не смотрит на is_read и возраст.
CREATE INDEX IF NOT EXISTS idx_notifications_balloon_mandatory_pending ON public.notifications (user_id, created_at)
  WHERE balloon_mode = 'mandatory' AND balloon_shown_at IS NULL;
COMMENT ON COLUMN public.notifications.balloon_mode IS
  'Балун на момент записи: NULL — без балуна, auto / persistent / mandatory (обязательный: только крестиком, без срока)';

ALTER TABLE public.notification_channel_deliveries
  ADD COLUMN IF NOT EXISTS required_permission TEXT NULL,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;
COMMENT ON COLUMN public.notification_channel_deliveries.required_permission IS
  'Право, которое воркер перепроверяет у получателя перед отправкой (буквально); NULL — без перепроверки';
COMMENT ON COLUMN public.notification_channel_deliveries.expires_at IS
  'Срок годности: не начатая к этому времени отправка пропускается (skipped/EXPIRED); NULL — без срока';

COMMIT;
