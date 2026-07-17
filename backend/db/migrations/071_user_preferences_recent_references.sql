-- 071_user_preferences_recent_references.sql
-- Per-user most-recently-used reference ids. Array order is recency order.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS recent_reference_entities JSONB NOT NULL DEFAULT '{}'::jsonb;
