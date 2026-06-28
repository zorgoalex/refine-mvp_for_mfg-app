ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS order_detail_columns JSONB NOT NULL DEFAULT '{}'::jsonb;
