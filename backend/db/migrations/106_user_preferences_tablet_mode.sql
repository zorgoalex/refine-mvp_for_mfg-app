-- 106_user_preferences_tablet_mode.sql
-- Persist the explicit tablet-layout override as a per-user preference.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS tablet_mode BOOLEAN NOT NULL DEFAULT FALSE;
