-- 094_user_preferences_sidebar_menu_order.sql
-- Store per-user ordering for the left sidebar menu.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS sidebar_menu_order JSONB NOT NULL DEFAULT '{}'::jsonb;
