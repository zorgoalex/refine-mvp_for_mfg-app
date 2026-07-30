-- Allow the two new modern palette variants while keeping Evolutionary as default.
ALTER TABLE user_preferences
  DROP CONSTRAINT IF EXISTS chk_user_preferences_ui_variant;

UPDATE user_preferences
SET ui_variant = 'evolution'
WHERE ui_variant IS NULL
   OR ui_variant NOT IN ('legacy', 'evolution', 'line', 'air');

ALTER TABLE user_preferences
  ALTER COLUMN ui_variant SET DEFAULT 'evolution',
  ALTER COLUMN ui_variant SET NOT NULL;

ALTER TABLE user_preferences
  ADD CONSTRAINT chk_user_preferences_ui_variant
  CHECK (ui_variant IN ('legacy', 'evolution', 'line', 'air'));
