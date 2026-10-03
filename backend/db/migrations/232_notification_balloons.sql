-- Балуны уведомлений (план spec_erp/plans/2026-10-03-notification-balloons-plan.md, plan review R4 APPROVED).
-- Только добавление: канал правила `balloon` хранится в channels_json, свойство исчезновения — в balloon_mode правила;
-- уведомление запоминает решение на момент записи (balloon_mode) и состояние показа: аренда вкладки + подтверждение.
BEGIN;

ALTER TABLE public.notification_rules
  ADD COLUMN IF NOT EXISTS balloon_mode TEXT NOT NULL DEFAULT 'auto';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_notification_rules_balloon_mode') THEN
    ALTER TABLE public.notification_rules
      ADD CONSTRAINT chk_notification_rules_balloon_mode CHECK (balloon_mode IN ('auto', 'persistent'));
  END IF;
END $$;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS balloon_mode TEXT NULL,
  ADD COLUMN IF NOT EXISTS balloon_lease_token UUID NULL,
  ADD COLUMN IF NOT EXISTS balloon_leased_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS balloon_shown_at TIMESTAMPTZ NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_notifications_balloon_mode') THEN
    ALTER TABLE public.notifications
      ADD CONSTRAINT chk_notifications_balloon_mode CHECK (balloon_mode IS NULL OR balloon_mode IN ('auto', 'persistent'));
  END IF;
END $$;

-- Выдача непоказанных балунов пользователя (claim): только строки с балуном, без показа, непрочитанные.
CREATE INDEX IF NOT EXISTS idx_notifications_balloon_pending
  ON public.notifications (user_id, created_at)
  WHERE balloon_mode IS NOT NULL AND balloon_shown_at IS NULL AND NOT is_read;

COMMENT ON COLUMN public.notification_rules.balloon_mode IS 'Исчезновение балуна (канал balloon): auto — через 15 с, persistent — только крестиком';
COMMENT ON COLUMN public.notifications.balloon_mode IS 'Балун на момент записи: NULL — без балуна, auto / persistent';

COMMIT;
