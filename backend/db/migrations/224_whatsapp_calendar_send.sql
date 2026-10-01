-- «Отправить в чат» from the calendar: one system broadcast (purpose = 'calendar') that is never
-- scheduled; its manual runs carry source = 'calendar' and may target any day within a year.
-- The frequency threshold (calendar_min_interval_minutes) is enforced against
-- calendar_last_delivery_at, the start of the latest calendar delivery.
-- Deploy like 209: stop the old backend, apply, start the new one (the old code does not know
-- purpose and would show and send the system broadcast as an ordinary one).
BEGIN;

ALTER TABLE whatsapp_broadcasts
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'schedule',
  ADD COLUMN IF NOT EXISTS calendar_min_interval_minutes SMALLINT,
  ADD COLUMN IF NOT EXISTS calendar_last_delivery_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_whatsapp_broadcasts_purpose') THEN
    ALTER TABLE whatsapp_broadcasts ADD CONSTRAINT chk_whatsapp_broadcasts_purpose
      CHECK (purpose IN ('schedule','calendar'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_whatsapp_broadcasts_calendar_manual') THEN
    -- The scheduler fixes only enabled broadcasts: the system one can never be enabled.
    ALTER TABLE whatsapp_broadcasts ADD CONSTRAINT chk_whatsapp_broadcasts_calendar_manual
      CHECK (purpose = 'schedule' OR NOT enabled);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_whatsapp_broadcasts_calendar_interval') THEN
    ALTER TABLE whatsapp_broadcasts ADD CONSTRAINT chk_whatsapp_broadcasts_calendar_interval
      CHECK (CASE WHEN purpose = 'calendar'
        THEN calendar_min_interval_minutes IS NOT NULL AND calendar_min_interval_minutes BETWEEN 1 AND 1440
        ELSE calendar_min_interval_minutes IS NULL AND calendar_last_delivery_at IS NULL END);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_broadcasts_calendar_active
  ON whatsapp_broadcasts ((purpose)) WHERE purpose = 'calendar' AND archived_at IS NULL;

-- Names are unique among the user's (schedule) broadcasts only.
DROP INDEX IF EXISTS idx_whatsapp_broadcasts_name_active;
CREATE UNIQUE INDEX idx_whatsapp_broadcasts_name_active
  ON whatsapp_broadcasts (lower(name)) WHERE archived_at IS NULL AND purpose = 'schedule';

ALTER TABLE whatsapp_broadcast_runs
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'broadcast';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_whatsapp_broadcast_runs_source') THEN
    ALTER TABLE whatsapp_broadcast_runs ADD CONSTRAINT chk_whatsapp_broadcast_runs_source
      CHECK (source IN ('broadcast','calendar') AND (source = 'broadcast' OR kind <> 'auto'));
  END IF;
  -- The calendar shows past days too: calendar runs may target any day within a year.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_whatsapp_broadcast_runs_target'
      AND pg_get_constraintdef(oid) LIKE '%calendar%') THEN
    ALTER TABLE whatsapp_broadcast_runs DROP CONSTRAINT IF EXISTS chk_whatsapp_broadcast_runs_target;
    ALTER TABLE whatsapp_broadcast_runs ADD CONSTRAINT chk_whatsapp_broadcast_runs_target CHECK (
      (source = 'broadcast' AND target_date BETWEEN business_date AND business_date + 14)
      OR (source = 'calendar' AND target_date BETWEEN business_date - 366 AND business_date + 366));
  END IF;
END $$;

INSERT INTO whatsapp_broadcasts (name, purpose, enabled, group_chat_id, weekdays, send_window_minutes,
    catch_up_policy, partial_policy, order_date_offset_days, attach_cards, cards_per_message,
    caption_template, calendar_min_interval_minutes)
SELECT 'Отправка из календаря', 'calendar', FALSE, NULL, '{}', 0, 'skip', 'remaining', 0, TRUE, 2,
    'Заказы на {target_date}', 15
WHERE NOT EXISTS (SELECT 1 FROM whatsapp_broadcasts WHERE purpose = 'calendar');

COMMIT;
