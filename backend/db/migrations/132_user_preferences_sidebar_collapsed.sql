-- 132_user_preferences_sidebar_collapsed.sql
-- Persist the left sidebar collapsed state as a per-user preference.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS sidebar_collapsed BOOLEAN;
