-- Per-user visual shell preference. Legacy remains the safe/default choice;
-- runtime rollout flags can still force every user back to it.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS ui_variant TEXT NOT NULL DEFAULT 'legacy';

UPDATE user_preferences
SET ui_variant = 'legacy'
WHERE ui_variant IS NULL
   OR ui_variant NOT IN ('legacy', 'evolution');

ALTER TABLE user_preferences
  ALTER COLUMN ui_variant SET DEFAULT 'legacy',
  ALTER COLUMN ui_variant SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_user_preferences_ui_variant'
      AND conrelid = 'user_preferences'::regclass
  ) THEN
    ALTER TABLE user_preferences
      ADD CONSTRAINT chk_user_preferences_ui_variant
      CHECK (ui_variant IN ('legacy', 'evolution'));
  END IF;
END
$$;
