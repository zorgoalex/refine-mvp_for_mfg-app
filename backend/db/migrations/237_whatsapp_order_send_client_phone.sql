-- Отправка заказа клиенту на выбранный телефон: какой телефон клиента выбран в команде.
-- Additive: a nullable column without a default (a catalog-only change — no table rewrite, no scan) and a new
-- table. The previous backend ignores both; the compatible backend (K2a) and the full one (K2b) come after it.
BEGIN;

-- Runs while the backend works: the table is locked up front with NOWAIT, so the migration never waits while
-- holding it; a table in use makes it fail at once without changes — run it again.
SET LOCAL lock_timeout = '5s';
LOCK TABLE whatsapp_order_sends IN ACCESS EXCLUSIVE MODE NOWAIT;

-- The client phone row chosen in the command (NULL = the default rule: the primary phone, else the smallest).
-- No foreign key: the phone may be deleted after the send; history keeps the mask and the fingerprint.
-- No CHECK either: validating one would scan the whole history under this lock.
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS client_phone_id BIGINT;

-- Final refusals of card commands, by actor and idempotency key: a command refused because its recipient is no
-- longer what the user saw (the phone was edited or removed, the release makes no such sends) must stay refused
-- even if the same request arrives again later, when the phone is back or the release has changed. The ledger of
-- commands is the sends table plus this one. Rows are kept for good, like the key of an accepted send (they hold
-- no recipient data: the actor, the key, the code, the order and the request).
CREATE TABLE IF NOT EXISTS whatsapp_order_send_refusals (
  actor_id BIGINT NOT NULL,
  idempotency_key UUID NOT NULL,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  error_code TEXT NOT NULL CHECK (char_length(error_code) BETWEEN 1 AND 80),
  order_id BIGINT,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_order_send_refusals_created ON whatsapp_order_send_refusals (created_at);

COMMIT;
