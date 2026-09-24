-- Random dispatch window for the WhatsApp daily order digest.
-- send_time becomes the window start; send_window_minutes bounds the daily
-- random minute offset [0, duration). Zero keeps the legacy exact send_time.
BEGIN;

ALTER TABLE whatsapp_daily_digest_settings
  ADD COLUMN IF NOT EXISTS send_window_minutes INTEGER NOT NULL DEFAULT 0;

ALTER TABLE whatsapp_daily_digest_settings
  ADD CONSTRAINT chk_whatsapp_daily_digest_window_minutes_range
    CHECK (send_window_minutes BETWEEN 0 AND 1439);

-- A dispatch window may not end at or beyond local midnight; next-day windows
-- are not modeled. Epoch-second arithmetic keeps SQL-direct second-bearing
-- TIME values exact instead of truncating to minutes or wrapping past 24:00.
ALTER TABLE whatsapp_daily_digest_settings
  ADD CONSTRAINT chk_whatsapp_daily_digest_window_same_day
    CHECK (EXTRACT(EPOCH FROM send_time) + send_window_minutes * 60 < 86400);

-- Stricter successor of the migration-183 catch_up_deadline >= send_time check
-- (kept so SQL-direct second-bearing TIME values stay constrained): the
-- configured catch-up deadline must not precede the dispatch window end.
ALTER TABLE whatsapp_daily_digest_settings
  ADD CONSTRAINT chk_whatsapp_daily_digest_deadline_after_window
    CHECK (catch_up_policy <> 'until_deadline'
      OR EXTRACT(EPOCH FROM catch_up_deadline) >= EXTRACT(EPOCH FROM send_time) + send_window_minutes * 60);

-- Durable once-per-day chosen dispatch minute. Written exactly once per
-- business date (insert-on-conflict winner wins); never updated or redrawn.
-- Row-level checks keep a persisted schedule self-coherent: the stored window
-- matches start+duration without wrapping, the chosen minute sits on the
-- business date inside [window_start, window_end) (exactly window_start for a
-- zero window), and an until_deadline policy cannot precede the window end.
CREATE TABLE IF NOT EXISTS whatsapp_daily_digest_schedules (
  business_date DATE PRIMARY KEY,
  scheduled_at TIMESTAMPTZ NOT NULL,
  window_start TIME NOT NULL,
  window_end TIME NOT NULL,
  send_window_minutes INTEGER NOT NULL CHECK (send_window_minutes BETWEEN 0 AND 1439),
  catch_up_policy TEXT NOT NULL CHECK (catch_up_policy IN ('skip','until_deadline','end_of_day')),
  catch_up_deadline TIME NOT NULL,
  settings_version INTEGER NOT NULL CHECK (settings_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (scheduled_at = date_trunc('minute', scheduled_at)),
  CHECK (EXTRACT(EPOCH FROM window_end) = EXTRACT(EPOCH FROM window_start) + send_window_minutes * 60
         AND EXTRACT(EPOCH FROM window_end) < 86400),
  CHECK ((scheduled_at AT TIME ZONE 'Asia/Almaty')::date = business_date),
  CHECK ((scheduled_at AT TIME ZONE 'Asia/Almaty')::time >= window_start
         AND ((send_window_minutes = 0 AND (scheduled_at AT TIME ZONE 'Asia/Almaty')::time = window_start)
           OR (send_window_minutes > 0 AND (scheduled_at AT TIME ZONE 'Asia/Almaty')::time < window_end))),
  CHECK (catch_up_policy <> 'until_deadline' OR catch_up_deadline >= window_end)
);

COMMIT;
