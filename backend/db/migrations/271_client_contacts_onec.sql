-- Контакты клиента из 1С (K4b): телефоны, email и адреса связанного контрагента 1С как строки client_contacts с
-- происхождением 'onec'. Additive: only the checks of client_contacts get wider (the same names as 243/269); phones and
-- addresses are rows of 1C only (the client's own phones stay in client_phones), a phone of 1C is never «основной».
-- The previous backend keeps working while the sync is off: no row of 1C exists.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Swapping a check takes ACCESS EXCLUSIVE: taken up front, failing at once (run again) instead of queueing readers
-- of the contacts behind a waiting lock.
LOCK TABLE public.client_contacts IN ACCESS EXCLUSIVE MODE NOWAIT;

-- 236 created the value length check inline (client_contacts_value_check, 1..200); 243 the origin check; 269 the kind
-- and normalized value checks. A rerun drops and re-adds the same set under the same names.
ALTER TABLE public.client_contacts DROP CONSTRAINT IF EXISTS client_contacts_value_check;
ALTER TABLE public.client_contacts DROP CONSTRAINT IF EXISTS ck_client_contacts_value;
ALTER TABLE public.client_contacts DROP CONSTRAINT IF EXISTS ck_client_contacts_kind;
ALTER TABLE public.client_contacts DROP CONSTRAINT IF EXISTS ck_client_contacts_value_normalized;
ALTER TABLE public.client_contacts DROP CONSTRAINT IF EXISTS ck_client_contacts_origin;
ALTER TABLE public.client_contacts DROP CONSTRAINT IF EXISTS ck_client_contacts_onec_kinds;

-- NOT VALID: no scan under ACCESS EXCLUSIVE; new and changed rows are checked at once, old rows by VALIDATE below.
ALTER TABLE public.client_contacts ADD CONSTRAINT ck_client_contacts_value
  CHECK (char_length(btrim(value)) BETWEEN 1 AND CASE WHEN kind = 'address' THEN 500 ELSE 200 END) NOT VALID;
ALTER TABLE public.client_contacts ADD CONSTRAINT ck_client_contacts_kind
  CHECK (kind IN ('email', 'telegram', 'whatsapp', 'viber', 'instagram', 'other', 'phone', 'address')) NOT VALID;
ALTER TABLE public.client_contacts ADD CONSTRAINT ck_client_contacts_value_normalized CHECK (
  (kind = 'email' AND value_normalized ~ '^[^@[:space:]]+@[^@[:space:]]+$' AND value_normalized = lower(value_normalized))
  OR (kind = 'telegram' AND value_normalized ~ '^[a-z0-9_]{5,32}$')
  OR (kind IN ('whatsapp', 'viber', 'phone') AND value_normalized ~ '^7[0-9]{10}$')
  OR (kind = 'instagram' AND value_normalized ~ '^[a-z0-9._]{1,30}$')
  OR (kind = 'other' AND char_length(value_normalized) BETWEEN 1 AND 200 AND value_normalized = lower(value_normalized))
  OR (kind = 'address' AND char_length(value_normalized) BETWEEN 1 AND 500 AND value_normalized = lower(value_normalized))) NOT VALID;
ALTER TABLE public.client_contacts ADD CONSTRAINT ck_client_contacts_origin CHECK (
  (origin = 'erp' AND onec_source_id IS NULL AND onec_synced_at IS NULL AND onec_snapshot_version IS NULL)
  OR (origin = 'onec' AND onec_source_id IS NOT NULL AND onec_synced_at IS NOT NULL AND onec_snapshot_version IS NOT NULL)) NOT VALID;
-- A phone or an address of a client is a row of 1C; the primary phone of a client is in client_phones.
ALTER TABLE public.client_contacts ADD CONSTRAINT ck_client_contacts_onec_kinds CHECK (
  (kind NOT IN ('phone', 'address') OR origin = 'onec') AND NOT (kind = 'phone' AND is_primary)) NOT VALID;

COMMIT;

-- Old rows against the new checks: SHARE UPDATE EXCLUSIVE only (reads and writes go on). A failure here leaves the
-- checks NOT VALID but enforced for new rows; running the whole file again repeats both phases.
SET lock_timeout = '5s';
SET statement_timeout = '60s';
ALTER TABLE public.client_contacts VALIDATE CONSTRAINT ck_client_contacts_value;
ALTER TABLE public.client_contacts VALIDATE CONSTRAINT ck_client_contacts_kind;
ALTER TABLE public.client_contacts VALIDATE CONSTRAINT ck_client_contacts_value_normalized;
ALTER TABLE public.client_contacts VALIDATE CONSTRAINT ck_client_contacts_origin;
ALTER TABLE public.client_contacts VALIDATE CONSTRAINT ck_client_contacts_onec_kinds;
RESET lock_timeout;
RESET statement_timeout;
