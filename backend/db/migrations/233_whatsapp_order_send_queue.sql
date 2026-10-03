-- Отправка заказа из карточки: очередь вместо отказа «раньше порога» / «есть активная отправка»,
-- ручная отмена, формы-картинки (PNG по 55 деталей).
-- Sends wait in a FIFO queue and leave one by one through the system-wide gate; the author or a
-- WhatsApp manager may cancel a waiting send. Compatible with the previous backend: it still refuses
-- new commands while the queue is not empty and drains the queue one by one.
BEGIN;

-- Several sends may now wait at once.
DROP INDEX IF EXISTS idx_whatsapp_order_sends_one_active;

-- A manual cancellation (by the author or a WhatsApp manager) and who did it.
ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS whatsapp_order_sends_cancel_reason_check;
ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_cancel_reason;
ALTER TABLE whatsapp_order_sends ADD CONSTRAINT chk_whatsapp_order_sends_cancel_reason CHECK (cancel_reason IS NULL OR cancel_reason IN
  ('disabled','recipient_removed','recipient_changed','form_not_allowed','permission_revoked','paused','manual'));
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS cancelled_by BIGINT;
ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_cancelled_by;
ALTER TABLE whatsapp_order_sends ADD CONSTRAINT chk_whatsapp_order_sends_cancelled_by
  CHECK (cancelled_by IS NULL OR cancel_reason = 'manual');

-- Image forms («Изображение заказа» / «для производства»): PNG pages of up to 55 details each.
ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS whatsapp_order_sends_form_code_check;
ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_form_code;
ALTER TABLE whatsapp_order_sends ADD CONSTRAINT chk_whatsapp_order_sends_form_code CHECK (form_code IN
  ('production_pdf','order_pdf','production_excel','order_excel','production_image','order_image'));
ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS whatsapp_order_sends_file_key_check;
ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_file_key;
ALTER TABLE whatsapp_order_sends ADD CONSTRAINT chk_whatsapp_order_sends_file_key CHECK (file_key IS NULL
  OR file_key ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(pdf|xlsx|png)$');
-- The image forms may be enabled for the client and for chats.
ALTER TABLE whatsapp_order_send_settings DROP CONSTRAINT IF EXISTS whatsapp_order_send_settings_client_forms_check;
ALTER TABLE whatsapp_order_send_settings DROP CONSTRAINT IF EXISTS chk_whatsapp_order_send_settings_client_forms;
ALTER TABLE whatsapp_order_send_settings ADD CONSTRAINT chk_whatsapp_order_send_settings_client_forms CHECK (client_forms <@
  ARRAY['production_pdf','order_pdf','production_excel','order_excel','production_image','order_image']::text[]);
ALTER TABLE whatsapp_order_send_chats DROP CONSTRAINT IF EXISTS whatsapp_order_send_chats_forms_check;
ALTER TABLE whatsapp_order_send_chats DROP CONSTRAINT IF EXISTS chk_whatsapp_order_send_chats_forms;
ALTER TABLE whatsapp_order_send_chats ADD CONSTRAINT chk_whatsapp_order_send_chats_forms CHECK (forms <@
  ARRAY['production_pdf','order_pdf','production_excel','order_excel','production_image','order_image']::text[]);
-- Page 1 stays in the send row; pages 2..N of an image form live in whatsapp_order_send_parts.
ALTER TABLE whatsapp_order_sends ADD COLUMN IF NOT EXISTS parts_total SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE whatsapp_order_sends DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_parts_total;
ALTER TABLE whatsapp_order_sends ADD CONSTRAINT chk_whatsapp_order_sends_parts_total CHECK (parts_total BETWEEN 1 AND 20);

CREATE TABLE IF NOT EXISTS whatsapp_order_send_parts (
  send_id UUID NOT NULL REFERENCES whatsapp_order_sends(send_id) ON DELETE CASCADE,
  part_no SMALLINT NOT NULL CHECK (part_no BETWEEN 2 AND 20),
  file_key TEXT CHECK (file_key IS NULL OR file_key ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.png$'),
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 10485760),
  provider_message_id TEXT,
  sent_at TIMESTAMPTZ,
  purged_at TIMESTAMPTZ,
  PRIMARY KEY (send_id, part_no),
  CONSTRAINT chk_whatsapp_order_send_parts_payload CHECK (
    purged_at IS NOT NULL OR (file_key IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL)),
  CONSTRAINT chk_whatsapp_order_send_parts_purged CHECK (
    purged_at IS NULL OR (file_key IS NULL AND provider_message_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_order_send_parts_file ON whatsapp_order_send_parts (file_key) WHERE file_key IS NOT NULL;

-- The queue in delivery order (FIFO by created_at) and the journal of waiting sends.
CREATE INDEX IF NOT EXISTS idx_whatsapp_order_sends_queue
  ON whatsapp_order_sends (created_at) WHERE state IN ('queued','sending');

COMMIT;
