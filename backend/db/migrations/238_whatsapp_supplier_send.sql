-- Заявка поставщику в WhatsApp из экрана снабжения: текст заявки уходит на телефон поставщика через ту же
-- очередь и тот же порог, что отправка заказа из карточки.
-- Additive. The previous backend never makes such rows and keeps working on this schema; the compatible
-- backend (K3a) and the full one (K3b) come after it.
BEGIN;

-- Runs while the backend works: every table it changes is locked up front with NOWAIT, so the migration never
-- waits while holding one of them; a table in use makes it fail at once without changes — run it again.
SET LOCAL lock_timeout = '5s';
LOCK TABLE whatsapp_order_send_settings IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE whatsapp_order_sends IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE whatsapp_order_send_parts IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE whatsapp_order_send_refusals IN ACCESS EXCLUSIVE MODE NOWAIT;

-- Off by default: sends of supplier requests are switched on in the settings («Заявки поставщикам»).
-- (A constant default: a catalog-only change.)
ALTER TABLE whatsapp_order_send_settings ADD COLUMN IF NOT EXISTS supplier_requests_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- A supplier send belongs to a supplier request, not to an order.
ALTER TABLE whatsapp_order_sends ALTER COLUMN order_id DROP NOT NULL;

-- New columns: nullable, no default, no inline CHECK (catalog-only; no rewrite and no scan under this lock).
-- No foreign keys: history outlives the request, the supplier and the contact; it keeps the mask and the fingerprint.
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS supplier_request_id BIGINT;
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS supplier_request_version INTEGER;
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS supplier_key TEXT;
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS supplier_id BIGINT;
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS supplier_contact_id BIGINT;
-- What the request was when the send was queued (supplier, date, comment, lines): a changed request cancels it.
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS request_content_sha256 TEXT;
-- The first message of the text (messages 2..N are rows of whatsapp_order_send_parts); cleared by retention.
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS text_body TEXT;
-- The whole text as the user sent it: its hash, length and whether it was edited by hand (kept for history).
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS text_sha256 TEXT;
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS text_length INTEGER;
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS text_edited BOOLEAN;
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS template_id BIGINT;
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS template_version INTEGER;
ALTER TABLE whatsapp_order_send_parts ADD COLUMN IF NOT EXISTS text_body TEXT;
ALTER TABLE whatsapp_order_send_refusals ADD COLUMN IF NOT EXISTS supplier_request_id BIGINT;

-- Every changed CHECK is re-created NOT VALID: new and updated rows are checked from now on, the existing
-- history is not scanned under this lock — it is validated below, after COMMIT, under a lock that does not
-- block the application. (Every existing row satisfies the new definitions: they only add alternatives.)
ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_target_kind;
ALTER TABLE whatsapp_order_sends ADD CONSTRAINT chk_whatsapp_order_sends_target_kind
  CHECK (target_kind IN ('client','chat','employee','supplier')) NOT VALID;

ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_form_code;
ALTER TABLE whatsapp_order_sends ADD CONSTRAINT chk_whatsapp_order_sends_form_code CHECK (form_code IN
  ('production_pdf','order_pdf','production_excel','order_excel','production_image','order_image','supplier_text')) NOT VALID;

ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_cancel_reason;
ALTER TABLE whatsapp_order_sends ADD CONSTRAINT chk_whatsapp_order_sends_cancel_reason CHECK (cancel_reason IS NULL OR cancel_reason IN
  ('disabled','recipient_removed','recipient_changed','form_not_allowed','permission_revoked','paused','manual','request_changed')) NOT VALID;

-- An order send keeps its order (the column itself is nullable now); a supplier send has no order and names
-- its request, supplier, recipient fingerprint and text.
ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_target;
ALTER TABLE whatsapp_order_sends ADD CONSTRAINT chk_whatsapp_order_sends_target CHECK (
  (target_kind = 'chat' AND order_id IS NOT NULL AND chat_key IS NOT NULL AND phone_normalized IS NULL AND recipient_key IS NULL
      AND employee_id IS NULL AND supplier_request_id IS NULL)
  OR (target_kind = 'client' AND order_id IS NOT NULL AND chat_key IS NULL AND recipient_key IS NULL AND employee_id IS NULL
      AND supplier_request_id IS NULL)
  OR (target_kind = 'employee' AND order_id IS NOT NULL AND chat_key IS NULL AND recipient_key IS NOT NULL AND employee_id IS NOT NULL
      AND recipient_fingerprint IS NOT NULL AND supplier_request_id IS NULL)
  OR (target_kind = 'supplier' AND order_id IS NULL AND chat_key IS NULL AND recipient_key IS NULL AND employee_id IS NULL
      AND form_code = 'supplier_text' AND supplier_request_id IS NOT NULL AND supplier_request_version IS NOT NULL
      AND supplier_key IS NOT NULL AND supplier_id IS NOT NULL AND supplier_contact_id IS NOT NULL
      AND recipient_fingerprint IS NOT NULL AND request_content_sha256 ~ '^[0-9a-f]{64}$'
      AND text_sha256 ~ '^[0-9a-f]{64}$' AND text_length BETWEEN 1 AND 20000 AND text_edited IS NOT NULL)) NOT VALID;

-- A waiting send has a recipient and something to deliver: a file, or (a supplier send) the text.
ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_payload;
ALTER TABLE whatsapp_order_sends ADD CONSTRAINT chk_whatsapp_order_sends_payload CHECK (
  purged_at IS NOT NULL OR state NOT IN ('queued','sending')
  OR ((destination_chat_id IS NOT NULL OR phone_normalized IS NOT NULL)
    AND ((file_key IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL)
      OR (target_kind = 'supplier' AND text_body IS NOT NULL)))) NOT VALID;

-- Retention clears the text together with the phone, the file and the provider id.
ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_purged;
ALTER TABLE whatsapp_order_sends ADD CONSTRAINT chk_whatsapp_order_sends_purged CHECK (
  purged_at IS NULL OR (file_key IS NULL AND destination_chat_id IS NULL AND phone_normalized IS NULL
    AND provider_message_id IS NULL AND text_body IS NULL AND state NOT IN ('queued','sending'))) NOT VALID;

-- One WhatsApp message holds at most 4096 characters.
ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_text_body;
ALTER TABLE whatsapp_order_sends ADD CONSTRAINT chk_whatsapp_order_sends_text_body
  CHECK (text_body IS NULL OR char_length(text_body) BETWEEN 1 AND 4096) NOT VALID;

-- A part is a picture of an image form or a message of a supplier text; purged — neither.
ALTER TABLE whatsapp_order_send_parts DROP CONSTRAINT IF EXISTS chk_whatsapp_order_send_parts_payload;
ALTER TABLE whatsapp_order_send_parts ADD CONSTRAINT chk_whatsapp_order_send_parts_payload CHECK (
  purged_at IS NOT NULL
  OR (file_key IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL AND text_body IS NULL)
  OR (text_body IS NOT NULL AND file_key IS NULL)) NOT VALID;
ALTER TABLE whatsapp_order_send_parts DROP CONSTRAINT IF EXISTS chk_whatsapp_order_send_parts_purged;
ALTER TABLE whatsapp_order_send_parts ADD CONSTRAINT chk_whatsapp_order_send_parts_purged CHECK (
  purged_at IS NULL OR (file_key IS NULL AND provider_message_id IS NULL AND text_body IS NULL)) NOT VALID;
ALTER TABLE whatsapp_order_send_parts DROP CONSTRAINT IF EXISTS chk_whatsapp_order_send_parts_text_body;
ALTER TABLE whatsapp_order_send_parts ADD CONSTRAINT chk_whatsapp_order_send_parts_text_body
  CHECK (text_body IS NULL OR char_length(text_body) BETWEEN 1 AND 4096) NOT VALID;

COMMIT;

-- Sends of one request (the duplicate and unknown-outcome guards). Built CONCURRENTLY, outside the transaction
-- above: the scan of the history never runs under a lock that stops the application. An index left invalid by
-- an interrupted run is dropped first (a rerun before the migration is recorded rebuilds a valid one too).
DROP INDEX CONCURRENTLY IF EXISTS idx_whatsapp_order_sends_supplier_request;
CREATE INDEX CONCURRENTLY idx_whatsapp_order_sends_supplier_request
  ON whatsapp_order_sends (supplier_request_id, created_at DESC) WHERE supplier_request_id IS NOT NULL;

-- Validation of the re-created CHECKs: each statement is its own short transaction and takes
-- SHARE UPDATE EXCLUSIVE — reads and writes of the application go on while the history is scanned.
-- A failure here leaves the constraints enforced for new rows; run the migration again.
ALTER TABLE whatsapp_order_sends VALIDATE CONSTRAINT chk_whatsapp_order_sends_target_kind;
ALTER TABLE whatsapp_order_sends VALIDATE CONSTRAINT chk_whatsapp_order_sends_form_code;
ALTER TABLE whatsapp_order_sends VALIDATE CONSTRAINT chk_whatsapp_order_sends_cancel_reason;
ALTER TABLE whatsapp_order_sends VALIDATE CONSTRAINT chk_whatsapp_order_sends_target;
ALTER TABLE whatsapp_order_sends VALIDATE CONSTRAINT chk_whatsapp_order_sends_payload;
ALTER TABLE whatsapp_order_sends VALIDATE CONSTRAINT chk_whatsapp_order_sends_purged;
ALTER TABLE whatsapp_order_sends VALIDATE CONSTRAINT chk_whatsapp_order_sends_text_body;
ALTER TABLE whatsapp_order_send_parts VALIDATE CONSTRAINT chk_whatsapp_order_send_parts_payload;
ALTER TABLE whatsapp_order_send_parts VALIDATE CONSTRAINT chk_whatsapp_order_send_parts_purged;
ALTER TABLE whatsapp_order_send_parts VALIDATE CONSTRAINT chk_whatsapp_order_send_parts_text_body;
