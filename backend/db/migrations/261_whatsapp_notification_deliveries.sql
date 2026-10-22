-- Канал уведомлений WhatsApp: модули backend ставят короткое сообщение в своей транзакции, worker доставляет.
-- WhatsApp notification channel: deliveries queued by backend modules (first consumer — 1C alerts) and the
-- delivery epoch of the worker. Additive: two new tables; the previous backend knows neither.
BEGIN;

SET LOCAL lock_timeout = '5s';

-- One row: the delivery epoch. Every backend start raises it and cancels what an earlier epoch left queued, so
-- nothing queued before a restart, a rollback or a switch of the flags is sent afterwards.
CREATE TABLE IF NOT EXISTS whatsapp_notification_worker_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  epoch BIGINT NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  epoch_started_at TIMESTAMPTZ
);
INSERT INTO whatsapp_notification_worker_state (singleton) VALUES (TRUE) ON CONFLICT (singleton) DO NOTHING;

-- Rows are never deleted: the compact row left after the purge keeps the idempotency key answering forever.
CREATE TABLE IF NOT EXISTS whatsapp_notification_deliveries (
  delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  source_type TEXT NOT NULL CHECK (source_type ~ '^[a-z][a-z0-9_]{1,40}$'),
  source_id TEXT CHECK (source_id IS NULL OR char_length(source_id) BETWEEN 1 AND 200),
  correlation_id TEXT NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 200),
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('user', 'chat')),
  -- The requested user, not a checked reference: a user that does not exist is a stored «skipped».
  recipient_user_id BIGINT,
  employee_id BIGINT,
  employee_contact_id BIGINT,
  phone_normalized TEXT CHECK (phone_normalized IS NULL OR phone_normalized ~ '^7[0-9]{10}$'),
  -- Same contract as WHATSAPP_GROUP_ID_PATTERN (whatsapp-groups.ts).
  chat_id TEXT CHECK (chat_id IS NULL OR chat_id ~ '^[0-9]{5,24}(-[0-9]{5,24})?@g\.us$'),
  destination_chat_id TEXT CHECK (destination_chat_id IS NULL OR char_length(destination_chat_id) <= 100),
  required_permission TEXT CHECK (required_permission IS NULL OR required_permission ~ '^[a-z0-9_.]{1,100}$'),
  title TEXT CHECK (title IS NULL OR char_length(title) <= 200),
  body TEXT CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 4096),
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  delivery_epoch BIGINT NOT NULL,
  not_before TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'sent', 'failed', 'unknown', 'cancelled', 'skipped')),
  reason TEXT CHECK (reason IS NULL OR reason ~ '^[A-Za-z0-9_]{1,64}$'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  intent_token UUID,
  intent_at TIMESTAMPTZ,
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 200),
  sent_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  purged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_wnd_window CHECK (expires_at > not_before),
  CONSTRAINT chk_wnd_user CHECK (recipient_kind <> 'user' OR (recipient_user_id IS NOT NULL AND chat_id IS NULL)),
  -- A purged chat row loses its group id with the rest of the address.
  CONSTRAINT chk_wnd_chat CHECK (recipient_kind <> 'chat' OR (recipient_user_id IS NULL AND (chat_id IS NOT NULL OR purged_at IS NOT NULL))),
  CONSTRAINT chk_wnd_body CHECK (body IS NOT NULL OR purged_at IS NOT NULL),
  CONSTRAINT chk_wnd_purged CHECK (purged_at IS NULL OR (state IN ('sent', 'failed', 'unknown', 'cancelled', 'skipped')
    AND title IS NULL AND body IS NULL AND phone_normalized IS NULL AND destination_chat_id IS NULL AND chat_id IS NULL
    AND provider_message_id IS NULL)),
  CONSTRAINT chk_wnd_finished CHECK ((state IN ('queued', 'sending')) = (finished_at IS NULL)),
  CONSTRAINT chk_wnd_sending CHECK (state <> 'sending' OR (intent_token IS NOT NULL AND intent_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_wnd_queue ON whatsapp_notification_deliveries (next_attempt_at) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS idx_wnd_sending ON whatsapp_notification_deliveries (intent_at) WHERE state = 'sending';
-- The frequency gate: one message per 10 s over all recipients, at most 20 an hour per recipient (by intent time).
CREATE INDEX IF NOT EXISTS idx_wnd_intent ON whatsapp_notification_deliveries (intent_at DESC) WHERE intent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wnd_user_intent ON whatsapp_notification_deliveries (recipient_user_id, intent_at) WHERE intent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wnd_chat_intent ON whatsapp_notification_deliveries (chat_id, intent_at) WHERE intent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wnd_source ON whatsapp_notification_deliveries (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_wnd_purge ON whatsapp_notification_deliveries (finished_at) WHERE purged_at IS NULL AND finished_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wnd_created ON whatsapp_notification_deliveries (created_at DESC);

COMMIT;
