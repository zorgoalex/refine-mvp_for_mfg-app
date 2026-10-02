-- Отправка заказа в WhatsApp из карточки заказа: клиенту на личный номер и в настроенные чаты.
-- Additive: an older backend never reads these tables, so no cutover is needed. Disabled by default.
BEGIN;

-- One settings row (singleton). last_delivery_at is the start of the latest delivery attempt:
-- the system-wide frequency threshold counts from it. send_window_minutes (at most half the
-- threshold) adds a random delay: next_delivery_at = last delivery + threshold + random(0..window),
-- drawn once when a delivery starts.
CREATE TABLE IF NOT EXISTS whatsapp_order_send_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  min_interval_minutes SMALLINT NOT NULL DEFAULT 1 CHECK (min_interval_minutes BETWEEN 1 AND 1440),
  send_window_minutes SMALLINT NOT NULL DEFAULT 0
    CHECK (send_window_minutes >= 0 AND send_window_minutes * 2 <= min_interval_minutes),
  client_forms TEXT[] NOT NULL DEFAULT '{}'
    CHECK (client_forms <@ ARRAY['production_pdf','order_pdf','production_excel','order_excel']::text[]),
  client_caption TEXT NOT NULL DEFAULT 'Заказ {order_name}' CHECK (char_length(client_caption) <= 1000),
  last_delivery_at TIMESTAMPTZ,
  next_delivery_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT
);
INSERT INTO whatsapp_order_send_settings (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;

-- Chats offered in the order card. A row is never deleted and its group never changes: changing
-- the group archives the row and adds a new one, so a queued send can never be redirected.
CREATE TABLE IF NOT EXISTS whatsapp_order_send_chats (
  chat_key UUID PRIMARY KEY,
  group_chat_id TEXT NOT NULL CHECK (group_chat_id ~ '^[0-9]+(-[0-9]+)?@g\.us$'),
  label TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 100),
  forms TEXT[] NOT NULL DEFAULT '{}'
    CHECK (forms <@ ARRAY['production_pdf','order_pdf','production_excel','order_excel']::text[]),
  caption TEXT NOT NULL DEFAULT 'Заказ {order_name}' CHECK (char_length(caption) <= 1000),
  position SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 99),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_order_send_chats_group_active
  ON whatsapp_order_send_chats (group_chat_id) WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION whatsapp_order_send_chats_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.chat_key <> OLD.chat_key OR NEW.group_chat_id <> OLD.group_chat_id THEN
    RAISE EXCEPTION 'whatsapp_order_send_chats: chat_key and group_chat_id are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'whatsapp_order_send_chats: an archived chat cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_whatsapp_order_send_chats_immutable ON whatsapp_order_send_chats;
CREATE TRIGGER trg_whatsapp_order_send_chats_immutable BEFORE UPDATE ON whatsapp_order_send_chats
  FOR EACH ROW EXECUTE FUNCTION whatsapp_order_send_chats_immutable();

-- One row per send. It is also the idempotency ledger (actor + key) and the delivery outbox.
CREATE TABLE IF NOT EXISTS whatsapp_order_sends (
  send_id UUID PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(order_id),
  client_id BIGINT,
  actor_id BIGINT NOT NULL,
  request_id TEXT NOT NULL,
  idempotency_key UUID NOT NULL,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('client','chat')),
  chat_key UUID REFERENCES whatsapp_order_send_chats(chat_key) ON DELETE RESTRICT,
  form_code TEXT NOT NULL CHECK (form_code IN ('production_pdf','order_pdf','production_excel','order_excel')),
  -- Recipient: the group id for a chat, the normalized phone (7XXXXXXXXXX) for a client. The chat id
  -- of a client is resolved by the worker right before the delivery attempt.
  destination_chat_id TEXT,
  phone_normalized TEXT CHECK (phone_normalized IS NULL OR phone_normalized ~ '^7[0-9]{10}$'),
  recipient_masked TEXT NOT NULL CHECK (char_length(recipient_masked) <= 40),
  file_key TEXT CHECK (file_key IS NULL OR file_key ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(pdf|xlsx)$'),
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 10485760),
  file_name TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 160),
  caption TEXT CHECK (caption IS NULL OR char_length(caption) <= 1000),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','sending','sent','failed','unknown','cancelled','expired')),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Za-z0-9_]{1,64}$'),
  cancel_reason TEXT CHECK (cancel_reason IS NULL OR cancel_reason IN
    ('disabled','recipient_removed','recipient_changed','form_not_allowed','permission_revoked','paused')),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lock_token UUID,
  send_started_at TIMESTAMPTZ,
  provider_message_id TEXT,
  provider_ack BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at TIMESTAMPTZ,
  queue_expires_at TIMESTAMPTZ NOT NULL,
  purged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_whatsapp_order_sends_command UNIQUE (actor_id, idempotency_key),
  CONSTRAINT chk_whatsapp_order_sends_target CHECK (
    (target_kind = 'chat' AND chat_key IS NOT NULL AND phone_normalized IS NULL)
    OR (target_kind = 'client' AND chat_key IS NULL)),
  CONSTRAINT chk_whatsapp_order_sends_payload CHECK (
    purged_at IS NOT NULL OR state NOT IN ('queued','sending')
    OR (file_key IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL
      AND (destination_chat_id IS NOT NULL OR phone_normalized IS NOT NULL))),
  CONSTRAINT chk_whatsapp_order_sends_sending CHECK (
    state <> 'sending' OR (lock_token IS NOT NULL AND send_started_at IS NOT NULL AND attempt_count = 1)),
  CONSTRAINT chk_whatsapp_order_sends_sent CHECK (
    state <> 'sent' OR (provider_ack AND sent_at IS NOT NULL AND (provider_message_id IS NOT NULL OR purged_at IS NOT NULL))),
  CONSTRAINT chk_whatsapp_order_sends_cancelled CHECK ((state = 'cancelled') = (cancel_reason IS NOT NULL)),
  CONSTRAINT chk_whatsapp_order_sends_purged CHECK (
    purged_at IS NULL OR (file_key IS NULL AND destination_chat_id IS NULL AND phone_normalized IS NULL
      AND provider_message_id IS NULL AND state NOT IN ('queued','sending')))
);
-- At most one active send in the whole system: the global threshold serializes deliveries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_order_sends_one_active
  ON whatsapp_order_sends ((true)) WHERE state IN ('queued','sending');
CREATE INDEX IF NOT EXISTS idx_whatsapp_order_sends_order ON whatsapp_order_sends (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_order_sends_retention ON whatsapp_order_sends (created_at) WHERE purged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_order_sends_file ON whatsapp_order_sends (file_key) WHERE file_key IS NOT NULL;

COMMIT;
