-- Balloon slots (user request 18.11.2026): a notification may name its balloon slot; a fresh notification of the same
-- slot replaces the previous balloon instead of piling up (the bell keeps the whole history). Written by the single
-- notification writer: older not yet shown balloons of the slot are marked shown + superseded; a tab that still shows
-- one learns it from the claim response and closes it.
-- Additive: two nullable columns and a partial index; nothing existing changes.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS balloon_slot text;
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS balloon_superseded_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_notifications_balloon_slot'
                   AND conrelid = 'public.notifications'::regclass) THEN
    ALTER TABLE public.notifications ADD CONSTRAINT chk_notifications_balloon_slot
      CHECK (balloon_slot IS NULL OR (char_length(balloon_slot) BETWEEN 1 AND 200 AND balloon_mode IS NOT NULL));
  END IF;
END $$;

-- The writer's lookup of a user's older balloons of one slot not yet replaced (shown or not).
DROP INDEX IF EXISTS public.idx_notifications_balloon_slot_pending;
CREATE INDEX IF NOT EXISTS idx_notifications_balloon_slot_live
  ON public.notifications (user_id, balloon_slot)
  WHERE balloon_slot IS NOT NULL AND balloon_superseded_at IS NULL;

COMMENT ON COLUMN public.notifications.balloon_slot IS
  'Balloon slot: a newer notification of the same user and slot replaces this balloon (bell history is kept).';
COMMENT ON COLUMN public.notifications.balloon_superseded_at IS
  'When a newer balloon of the same slot replaced this one (balloon_shown_at is set at the same time).';

COMMIT;
