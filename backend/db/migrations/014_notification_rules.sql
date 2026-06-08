-- Migration 014: notification_rules (additive)
-- Runtime-configurable notification rules for the global notification engine.
-- Additive only: does not alter outbox_events or notifications.
BEGIN;

CREATE TABLE IF NOT EXISTS notification_rules (
  notification_rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_code        TEXT UNIQUE NOT NULL,
  event_type       TEXT NOT NULL,
  is_enabled       BOOLEAN NOT NULL DEFAULT true,
  priority         INTEGER NOT NULL DEFAULT 100,
  level            TEXT NOT NULL DEFAULT 'info',
  conditions_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  recipients_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  title_template   TEXT,
  message_template TEXT,
  created_by_user_id BIGINT,
  updated_by_user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_notification_rules_level CHECK (level IN ('info','warning','error'))
);

CREATE INDEX IF NOT EXISTS idx_notification_rules_event
  ON notification_rules(event_type, is_enabled, priority);

COMMIT;
