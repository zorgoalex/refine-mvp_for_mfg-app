-- Allow the «Верстак» (workbench) UI variant. It is opt-in from the profile:
-- the column default and existing rows stay on their current values.
-- One transaction: DROP and ADD of the CHECK never leave the column unconstrained.
BEGIN;

ALTER TABLE user_preferences
  DROP CONSTRAINT IF EXISTS chk_user_preferences_ui_variant;

UPDATE user_preferences
SET ui_variant = 'evolution'
WHERE ui_variant IS NULL
   OR ui_variant NOT IN ('legacy', 'evolution', 'line', 'air', 'neutral', 'workbench');

ALTER TABLE user_preferences
  ALTER COLUMN ui_variant SET DEFAULT 'evolution',
  ALTER COLUMN ui_variant SET NOT NULL;

ALTER TABLE user_preferences
  ADD CONSTRAINT chk_user_preferences_ui_variant
  CHECK (ui_variant IN ('legacy', 'evolution', 'line', 'air', 'neutral', 'workbench'));

COMMIT;
