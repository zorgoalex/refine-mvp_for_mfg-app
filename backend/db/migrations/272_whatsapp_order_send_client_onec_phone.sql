-- Отправка заказа клиенту на его телефон из 1С (K4b-2): какая копия контакта 1С (client_contacts, origin 'onec')
-- выбрана в команде. Additive: a nullable column without a default (catalog-only, no rewrite) and a check that only
-- new and changed rows meet at once (old rows: VALIDATE after the commit). The previous backend ignores both.
BEGIN;

-- Runs while the backend works: the table is locked up front with NOWAIT, so the migration never waits while
-- holding it; a table in use makes it fail at once without changes — run it again.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.whatsapp_order_sends IN ACCESS EXCLUSIVE MODE NOWAIT;

-- The 1C copy chosen in the command (NULL = an own phone or the default rule). No foreign key: the copy may go away
-- after the send (a link change, a merge, a revoked 1C set); history keeps the mask and the fingerprint.
ALTER TABLE public.whatsapp_order_sends ADD COLUMN IF NOT EXISTS client_onec_contact_id BIGINT;

-- A send names an own phone or a 1C copy, never both.
ALTER TABLE public.whatsapp_order_sends DROP CONSTRAINT IF EXISTS chk_whatsapp_order_sends_client_choice;
ALTER TABLE public.whatsapp_order_sends ADD CONSTRAINT chk_whatsapp_order_sends_client_choice
  CHECK (client_phone_id IS NULL OR client_onec_contact_id IS NULL) NOT VALID;

COMMIT;

-- Old rows against the check: SHARE UPDATE EXCLUSIVE only (sends go on). A failure here leaves the check NOT VALID
-- but enforced for new rows; running the whole file again repeats both phases.
SET lock_timeout = '5s';
SET statement_timeout = '60s';
ALTER TABLE public.whatsapp_order_sends VALIDATE CONSTRAINT chk_whatsapp_order_sends_client_choice;
RESET lock_timeout;
RESET statement_timeout;
