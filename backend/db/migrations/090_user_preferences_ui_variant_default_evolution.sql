-- New users default to the evolution interface. Existing stored choices stay unchanged.
ALTER TABLE user_preferences
  ALTER COLUMN ui_variant SET DEFAULT 'evolution';
