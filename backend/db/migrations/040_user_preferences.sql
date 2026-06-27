CREATE TABLE IF NOT EXISTS user_preferences (
  user_id BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  theme_mode TEXT NOT NULL DEFAULT 'light',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_preferences_theme_mode_check CHECK (theme_mode IN ('light', 'dark'))
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_updated_at
  ON user_preferences(updated_at DESC);
