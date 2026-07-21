-- 081_user_preferences_page_sizes.sql
-- Per-user page size for every independently paginated list.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS page_size_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
