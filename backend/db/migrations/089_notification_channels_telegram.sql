-- 089_notification_channels_telegram.sql
-- Extensible notification channels, secure Telegram account linking and
-- durable external-channel delivery queue.

BEGIN;

ALTER TABLE notification_rules
  ADD COLUMN IF NOT EXISTS channels_json JSONB NOT NULL DEFAULT '["in_app"]'::jsonb;

ALTER TABLE notification_rules
  DROP CONSTRAINT IF EXISTS chk_notification_rules_channels_nonempty;

ALTER TABLE notification_rules
  ADD CONSTRAINT chk_notification_rules_channels_nonempty
    CHECK (
      jsonb_typeof(channels_json) = 'array'
      AND jsonb_array_length(channels_json) BETWEEN 1 AND 10
    );

CREATE TABLE IF NOT EXISTS notification_channel_bindings (
  notification_channel_binding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  display_name TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_notification_channel_binding_user UNIQUE (user_id, channel),
  CONSTRAINT uq_notification_channel_binding_external_user UNIQUE (channel, external_user_id),
  CONSTRAINT uq_notification_channel_binding_destination UNIQUE (channel, destination),
  CONSTRAINT chk_notification_channel_binding_channel
    CHECK (channel ~ '^[a-z][a-z0-9_]{1,31}$')
);

CREATE TABLE IF NOT EXISTS notification_channel_link_tokens (
  notification_channel_link_token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_notification_channel_link_token_channel
    CHECK (channel ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT chk_notification_channel_link_token_expiry
    CHECK (expires_at > created_at),
  CONSTRAINT chk_notification_channel_link_token_terminal
    CHECK (NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_channel_link_token_active
  ON notification_channel_link_tokens(user_id, channel)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notification_channel_link_token_expiry
  ON notification_channel_link_tokens(expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_channel_deliveries (
  notification_channel_delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_rule_id UUID,
  outbox_event_id UUID,
  user_id BIGINT NOT NULL,
  channel TEXT NOT NULL,
  level TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  send_started_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  external_message_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_notification_channel_delivery_channel
    CHECK (channel ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT chk_notification_channel_delivery_level
    CHECK (level IN ('info', 'warning', 'error')),
  CONSTRAINT chk_notification_channel_delivery_status
    CHECK (status IN ('pending', 'processing', 'delivered', 'skipped', 'failed', 'unknown')),
  CONSTRAINT chk_notification_channel_delivery_attempts
    CHECK (attempts >= 0)
);

-- CREATE TABLE IF NOT EXISTS does not repair a table left half-created by an
-- interrupted/manual rollout. Converge every column used by enqueue/delivery.
-- Required columns intentionally fail closed when incompatible legacy rows
-- prevent NOT NULL/FK/UNIQUE validation.
ALTER TABLE notification_channel_deliveries
  ADD COLUMN IF NOT EXISTS notification_channel_delivery_id UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS notification_rule_id UUID,
  ADD COLUMN IF NOT EXISTS outbox_event_id UUID,
  ADD COLUMN IF NOT EXISTS user_id BIGINT,
  ADD COLUMN IF NOT EXISTS channel TEXT,
  ADD COLUMN IF NOT EXISTS level TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS message TEXT,
  ADD COLUMN IF NOT EXISTS entity_type TEXT,
  ADD COLUMN IF NOT EXISTS entity_id TEXT,
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_id TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by TEXT,
  ADD COLUMN IF NOT EXISTS send_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_message_id TEXT,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS last_error_message TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

ALTER TABLE notification_channel_deliveries
  ALTER COLUMN notification_channel_delivery_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN notification_channel_delivery_id SET NOT NULL,
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN channel SET NOT NULL,
  ALTER COLUMN level SET NOT NULL,
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN message SET NOT NULL,
  ALTER COLUMN source_type SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN attempts SET DEFAULT 0,
  ALTER COLUMN attempts SET NOT NULL,
  ALTER COLUMN next_attempt_at SET DEFAULT now(),
  ALTER COLUMN next_attempt_at SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'notification_channel_deliveries'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE notification_channel_deliveries
      ADD CONSTRAINT notification_channel_deliveries_pkey
      PRIMARY KEY (notification_channel_delivery_id);
  END IF;
END $$;

ALTER TABLE notification_channel_deliveries
  DROP CONSTRAINT IF EXISTS fk_notification_channel_delivery_rule,
  DROP CONSTRAINT IF EXISTS fk_notification_channel_delivery_outbox_event,
  DROP CONSTRAINT IF EXISTS fk_notification_channel_delivery_user,
  DROP CONSTRAINT IF EXISTS uq_notification_channel_delivery_idempotency,
  DROP CONSTRAINT IF EXISTS chk_notification_channel_delivery_channel,
  DROP CONSTRAINT IF EXISTS chk_notification_channel_delivery_level,
  DROP CONSTRAINT IF EXISTS chk_notification_channel_delivery_status,
  DROP CONSTRAINT IF EXISTS chk_notification_channel_delivery_attempts;

ALTER TABLE notification_channel_deliveries
  ADD CONSTRAINT fk_notification_channel_delivery_rule
    FOREIGN KEY (notification_rule_id)
    REFERENCES notification_rules(notification_rule_id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_notification_channel_delivery_outbox_event
    FOREIGN KEY (outbox_event_id)
    REFERENCES outbox_events(outbox_event_id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_notification_channel_delivery_user
    FOREIGN KEY (user_id)
    REFERENCES users(user_id) ON DELETE CASCADE,
  ADD CONSTRAINT uq_notification_channel_delivery_idempotency
    UNIQUE (idempotency_key),
  ADD CONSTRAINT chk_notification_channel_delivery_channel
    CHECK (channel ~ '^[a-z][a-z0-9_]{1,31}$'),
  ADD CONSTRAINT chk_notification_channel_delivery_level
    CHECK (level IN ('info', 'warning', 'error')),
  ADD CONSTRAINT chk_notification_channel_delivery_status
    CHECK (status IN ('pending', 'processing', 'delivered', 'skipped', 'failed', 'unknown')),
  ADD CONSTRAINT chk_notification_channel_delivery_attempts
    CHECK (attempts >= 0);

CREATE INDEX IF NOT EXISTS idx_notification_channel_deliveries_pending
  ON notification_channel_deliveries(next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_notification_channel_deliveries_processing
  ON notification_channel_deliveries(locked_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_notification_channel_deliveries_user
  ON notification_channel_deliveries(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS telegram_notification_webhook_updates (
  update_id BIGINT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

COMMIT;
