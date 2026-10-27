-- Контакты поставщика из 1С: происхождение строки контакта, адреса, сведения о контрагенте 1С и итог сверки.
-- Additive for the data: supplier_contacts gets three columns with constant defaults and re-created CHECKs (a small,
-- cold table); two new tables; two SQL functions; the phone sync of migration 242 and the «saved by the command»
-- trigger are re-created so that neither touches the rows that came from 1C. The previous backend keeps working:
-- it reads the new columns as nothing and its rows are origin 'erp'.
BEGIN;

-- Runs while the backend works: the tables are locked up front with NOWAIT, so the migration never waits while
-- holding one of them; a table in use makes it fail at once without changes — run it again.
SET LOCAL lock_timeout = '5s';
LOCK TABLE suppliers IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE party_contact_versions, supplier_contacts, vendor_contacts, client_contacts IN ACCESS EXCLUSIVE MODE NOWAIT;

-- Where a contact came from. A row 'onec' is created, changed and deleted only by the 1C sync of the backend; the
-- contacts command keeps its value and only moves its «основной» flag. Every existing row is the user's own.
-- All three contact tables get the columns (one code path for the set command); only suppliers have rows from 1C
-- for now — vendors never, clients after their own stage.
ALTER TABLE supplier_contacts ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'erp';
ALTER TABLE supplier_contacts ADD COLUMN IF NOT EXISTS onec_source_id BIGINT;
ALTER TABLE supplier_contacts ADD COLUMN IF NOT EXISTS onec_synced_at TIMESTAMPTZ;
ALTER TABLE supplier_contacts ADD COLUMN IF NOT EXISTS onec_snapshot_version TIMESTAMPTZ;
ALTER TABLE vendor_contacts ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'erp';
ALTER TABLE vendor_contacts ADD COLUMN IF NOT EXISTS onec_source_id BIGINT;
ALTER TABLE vendor_contacts ADD COLUMN IF NOT EXISTS onec_synced_at TIMESTAMPTZ;
ALTER TABLE vendor_contacts ADD COLUMN IF NOT EXISTS onec_snapshot_version TIMESTAMPTZ;
ALTER TABLE vendor_contacts DROP CONSTRAINT IF EXISTS ck_vendor_contacts_origin;
ALTER TABLE vendor_contacts ADD CONSTRAINT ck_vendor_contacts_origin CHECK (origin = 'erp' AND onec_source_id IS NULL AND onec_synced_at IS NULL AND onec_snapshot_version IS NULL);
ALTER TABLE client_contacts ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'erp';
ALTER TABLE client_contacts ADD COLUMN IF NOT EXISTS onec_source_id BIGINT;
ALTER TABLE client_contacts ADD COLUMN IF NOT EXISTS onec_synced_at TIMESTAMPTZ;
ALTER TABLE client_contacts ADD COLUMN IF NOT EXISTS onec_snapshot_version TIMESTAMPTZ;
ALTER TABLE client_contacts DROP CONSTRAINT IF EXISTS ck_client_contacts_origin;
ALTER TABLE client_contacts ADD CONSTRAINT ck_client_contacts_origin CHECK (origin = 'erp' AND onec_source_id IS NULL AND onec_synced_at IS NULL AND onec_snapshot_version IS NULL);

-- Every CHECK of the table is re-created under its own name (the K1 ones were unnamed): addresses join the kinds
-- and may be longer than the other values. A rerun drops and re-adds the same set.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'supplier_contacts'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE supplier_contacts DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE supplier_contacts
  ADD CONSTRAINT ck_supplier_contacts_kind CHECK (kind IN ('phone','email','telegram','address')),
  ADD CONSTRAINT ck_supplier_contacts_value CHECK (char_length(btrim(value)) BETWEEN 1 AND CASE WHEN kind = 'address' THEN 500 ELSE 200 END),
  ADD CONSTRAINT ck_supplier_contacts_normalized CHECK (
    (kind = 'phone' AND value_normalized ~ '^7[0-9]{10}$')
    OR (kind = 'email' AND value_normalized ~ '^[^@[:space:]]+@[^@[:space:]]+$' AND value_normalized = lower(value_normalized))
    OR (kind = 'telegram' AND value_normalized ~ '^[a-z0-9_]{5,32}$')
    OR (kind = 'address' AND char_length(value_normalized) BETWEEN 1 AND 500 AND value_normalized = lower(value_normalized))),
  ADD CONSTRAINT ck_supplier_contacts_note CHECK (note IS NULL OR char_length(note) <= 200),
  ADD CONSTRAINT ck_supplier_contacts_position CHECK (position BETWEEN 0 AND 99),
  ADD CONSTRAINT ck_supplier_contacts_origin CHECK (
    (origin = 'erp' AND onec_source_id IS NULL AND onec_synced_at IS NULL AND onec_snapshot_version IS NULL)
    OR (origin = 'onec' AND onec_source_id IS NOT NULL AND onec_synced_at IS NOT NULL AND onec_snapshot_version IS NOT NULL));

-- What the last sync saw of the 1C counterparty linked to an owner: its name, ИИН/БИН and the state of the 1C
-- contacts set. Written only by the sync and deleted with the link; ИИН/БИН is personal data and is cleared when the
-- contacts set of 1C is revoked or expired.
CREATE TABLE IF NOT EXISTS party_onec_profiles (
  party_kind TEXT NOT NULL CHECK (party_kind IN ('supplier','client')),
  party_id BIGINT NOT NULL,
  source_id BIGINT NOT NULL,
  ref_key_1c UUID NOT NULL,
  counterparty_name TEXT,
  identification_number TEXT,
  counterparty_state TEXT NOT NULL CHECK (counterparty_state IN ('active','deletion_mark','missing','not_found')),
  contacts_state TEXT NOT NULL CHECK (contacts_state IN ('available','revoked','expired','not_loaded')),
  snapshot_version TIMESTAMPTZ,
  skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (party_kind, party_id)
);

-- The last pass of the sync per owner kind (diagnostics on the card and in logs).
CREATE TABLE IF NOT EXISTS party_onec_sync_state (
  party_kind TEXT PRIMARY KEY CHECK (party_kind IN ('supplier','client')),
  trigger TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  processed INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- May a value of 1C be shown or used right now: it was reconciled with the snapshot the source holds now (a copy from
-- an earlier snapshot — e.g. before a revocation and a later re-enable — waits for the next sync), and that snapshot
-- is not revoked and not older than the personal data term of the 1C module (30 days, PERSONAL_DATA_TTL_MS — a test
-- keeps the two equal). Versions compare to the millisecond (the backend carries them as JS dates). A row of the
-- user (no source) always may. Without the 1C tables nothing of 1C may.
CREATE OR REPLACE FUNCTION party_onec_contacts_available(p_source_id bigint, p_snapshot timestamptz) RETURNS boolean AS $$
BEGIN
  IF p_source_id IS NULL THEN RETURN TRUE; END IF;
  IF p_snapshot IS NULL OR to_regclass('onec_etl_entity_state') IS NULL THEN RETURN FALSE; END IF;
  RETURN EXISTS (SELECT 1 FROM onec_etl_entity_state s
                  WHERE s.source_id = p_source_id AND s.entity_code = 'counterparty_contacts'
                    AND s.revoked_at IS NULL AND s.snapshot_version IS NOT NULL
                    AND date_trunc('milliseconds', s.snapshot_version) = date_trunc('milliseconds', p_snapshot)
                    AND s.snapshot_version >= now() - interval '30 days');
END;
$$ LANGUAGE plpgsql STABLE;

-- The same answer that holds until the caller's commit: the state row of the set is share-locked first (a revocation
-- or a new snapshot of 1C takes it FOR UPDATE and waits, or has already happened and is seen). For commands that use a
-- value of 1C.
CREATE OR REPLACE FUNCTION party_onec_contacts_lock(p_source_id bigint, p_snapshot timestamptz) RETURNS boolean AS $$
BEGIN
  IF p_source_id IS NULL THEN RETURN TRUE; END IF;
  IF to_regclass('onec_etl_entity_state') IS NULL THEN RETURN FALSE; END IF;
  PERFORM 1 FROM onec_etl_entity_state s
    WHERE s.source_id = p_source_id AND s.entity_code = 'counterparty_contacts' FOR SHARE;
  RETURN party_onec_contacts_available(p_source_id, p_snapshot);
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Migration 242, narrowed to the user's own rows: the old «Телефон» field of a supplier keeps only its own phone
-- contact in step; a phone that came from 1C is never removed by it. A number typed into the field that is already
-- there from 1C becomes the user's own row (the same row and id, no duplicate): it stays when 1C later drops it.
CREATE OR REPLACE FUNCTION supplier_phone_contact_sync() RETURNS trigger AS $$
DECLARE
  number text := supplier_phone_number(NEW.phone);
  removed integer := 0;
  added integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM party_contact_versions v
              WHERE v.party_kind = 'supplier' AND v.party_id = NEW.supplier_id AND v.saved_by_command) THEN
    RETURN NULL;
  END IF;
  DELETE FROM supplier_contacts
   WHERE supplier_id = NEW.supplier_id AND kind = 'phone' AND origin = 'erp' AND (number IS NULL OR value_normalized <> number);
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF number IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM supplier_contacts WHERE supplier_id = NEW.supplier_id AND kind = 'phone' AND origin = 'erp') THEN
    UPDATE supplier_contacts SET origin = 'erp', onec_source_id = NULL, onec_snapshot_version = NULL, onec_synced_at = NULL,
           value = btrim(NEW.phone), updated_at = now()
     WHERE supplier_id = NEW.supplier_id AND kind = 'phone' AND value_normalized = number AND origin = 'onec';
    IF NOT FOUND THEN
      -- Primary only when no other phone holds the flag (a 1C phone the user made primary keeps it).
      INSERT INTO supplier_contacts (supplier_id, kind, value, value_normalized, is_primary, position)
      VALUES (NEW.supplier_id, 'phone', btrim(NEW.phone), number,
              NOT EXISTS (SELECT 1 FROM supplier_contacts WHERE supplier_id = NEW.supplier_id AND kind = 'phone' AND is_primary), 0);
    END IF;
    added := 1;
  END IF;
  IF removed > 0 OR added > 0 THEN
    INSERT INTO party_contact_versions (party_kind, party_id, version, saved_by_command)
    VALUES ('supplier', NEW.supplier_id, 1, FALSE)
    ON CONFLICT (party_kind, party_id) DO UPDATE SET version = party_contact_versions.version + 1, updated_at = now();
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- A deleted supplier takes its 1C profile (ИИН/БИН) with it; its contacts block the deletion anyway (FK RESTRICT).
CREATE OR REPLACE FUNCTION supplier_drop_onec_profile() RETURNS trigger AS $$
BEGIN
  DELETE FROM party_onec_profiles WHERE party_kind = 'supplier' AND party_id = OLD.supplier_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_supplier_drop_onec_profile ON suppliers;
CREATE TRIGGER trg_supplier_drop_onec_profile AFTER DELETE ON suppliers FOR EACH ROW EXECUTE FUNCTION supplier_drop_onec_profile();

-- Who wrote the version row (migration 242): the phone sync (nested trigger) — «not saved by the command»; the
-- contacts command — saved. The 1C sync of the backend marks its transaction (erp.party_contacts_onec_sync = on):
-- its bump keeps whatever the row said, and a row it creates is «not saved by the command» — a change from 1C is
-- not the user's decision, so the old phone field keeps following until the user saves the set.
CREATE OR REPLACE FUNCTION party_contact_versions_saved() RETURNS trigger AS $$
BEGIN
  IF COALESCE(current_setting('erp.party_contacts_onec_sync', true), '') = 'on' THEN
    NEW.saved_by_command := CASE WHEN TG_OP = 'UPDATE' THEN OLD.saved_by_command ELSE FALSE END;
  ELSE
    NEW.saved_by_command := pg_trigger_depth() <= 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
