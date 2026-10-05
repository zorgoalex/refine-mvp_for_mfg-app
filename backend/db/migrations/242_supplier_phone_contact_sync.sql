-- Контакты поставщика: прежнее поле «Телефон» и контакт, перенесённый из него миграцией 236, не расходятся,
-- пока набор контактов поставщика ни разу не сохраняли новой командой.
-- Between migration 236 and the new frontend the previous form (and any tab left open with it) still writes
-- suppliers.phone. Without this, a number changed there would stay in the old column while the contacts — and
-- a supplier request sent to WhatsApp — kept the number copied earlier. Additive: a column with a constant
-- default, three functions, two triggers and a one-time resync; the previous backend is not affected.
BEGIN;

-- Runs while the backend works: the tables are locked up front with NOWAIT, so the migration never waits while
-- holding one of them; a table in use makes it fail at once without changes — run it again.
SET LOCAL lock_timeout = '5s';
LOCK TABLE suppliers IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE party_contact_versions IN ACCESS EXCLUSIVE MODE NOWAIT;

-- The version row of a set now says who made it: the contacts command (the set belongs to the user) or the
-- sync below (the set still follows the old phone field). Every existing row was made by the command.
ALTER TABLE party_contact_versions ADD COLUMN IF NOT EXISTS saved_by_command BOOLEAN NOT NULL DEFAULT TRUE;

-- Re-created at the end: the one-time resync below writes its rows as «not saved by the command» itself.
DROP TRIGGER IF EXISTS trg_party_contact_versions_saved ON party_contact_versions;

-- The number the backend reads from a free-form phone (the pattern of normalizeClientPhone, as in migration 236).
CREATE OR REPLACE FUNCTION supplier_phone_number(phone text) RETURNS text AS $$
  SELECT CASE WHEN m.parts IS NOT NULL AND char_length(btrim(phone)) <= 200
    THEN '7' || m.parts[1] || m.parts[2] || m.parts[3] || m.parts[4] END
  FROM (SELECT regexp_match(phone,
    '^\s*\+?[78][\s()-]*(\d{3})[\s()-]*(\d{3})[\s-]*(\d{2})[\s-]*(\d{2})(?:\s*(?:[-,;/]|доб\.?|вн\.?)\s*.*)?\s*$', 'i') AS parts) m;
$$ LANGUAGE sql IMMUTABLE;

-- The phone contact of a supplier follows suppliers.phone while its set was never saved by the contacts command.
-- A change made here bumps the version of the set (the row stays «not saved by the command»): a form that read
-- the set before the change is refused by the command's version check instead of silently dropping the phone.
-- The writer of suppliers.phone holds the supplier row; the contacts command takes the same row
-- (FOR NO KEY UPDATE) before it reads the version — the two never interleave.
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
  -- The same number keeps its contact row (and its id); another number or none replaces it.
  DELETE FROM supplier_contacts
   WHERE supplier_id = NEW.supplier_id AND kind = 'phone' AND (number IS NULL OR value_normalized <> number);
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF number IS NOT NULL AND NOT EXISTS (SELECT 1 FROM supplier_contacts WHERE supplier_id = NEW.supplier_id AND kind = 'phone') THEN
    INSERT INTO supplier_contacts (supplier_id, kind, value, value_normalized, is_primary, position)
    VALUES (NEW.supplier_id, 'phone', btrim(NEW.phone), number, TRUE, 0);
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

DROP TRIGGER IF EXISTS trg_supplier_phone_contact_sync ON suppliers;
CREATE TRIGGER trg_supplier_phone_contact_sync AFTER INSERT OR UPDATE OF phone ON suppliers
  FOR EACH ROW EXECUTE FUNCTION supplier_phone_contact_sync();

-- One-time resync of what was written to suppliers.phone after the copy of migration 236 (a no-op where the two
-- already agree): suppliers whose set the command never saved get exactly the contact their current phone
-- gives, and every set changed here gets its version bumped, like a change made by the trigger.
WITH removed AS (
  DELETE FROM supplier_contacts c
   USING suppliers s
   WHERE c.supplier_id = s.supplier_id AND c.kind = 'phone'
     AND (supplier_phone_number(s.phone) IS NULL OR c.value_normalized <> supplier_phone_number(s.phone))
     AND NOT EXISTS (SELECT 1 FROM party_contact_versions v
                      WHERE v.party_kind = 'supplier' AND v.party_id = c.supplier_id AND v.saved_by_command)
  RETURNING c.supplier_id
)
INSERT INTO party_contact_versions (party_kind, party_id, version, saved_by_command)
SELECT DISTINCT 'supplier', supplier_id, 1, FALSE FROM removed
ON CONFLICT (party_kind, party_id) DO UPDATE SET version = party_contact_versions.version + 1, updated_at = now();

WITH added AS (
  INSERT INTO supplier_contacts (supplier_id, kind, value, value_normalized, is_primary, position)
  SELECT s.supplier_id, 'phone', btrim(s.phone), supplier_phone_number(s.phone), TRUE, 0
    FROM suppliers s
   WHERE supplier_phone_number(s.phone) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM supplier_contacts c WHERE c.supplier_id = s.supplier_id AND c.kind = 'phone')
     AND NOT EXISTS (SELECT 1 FROM party_contact_versions v
                      WHERE v.party_kind = 'supplier' AND v.party_id = s.supplier_id AND v.saved_by_command)
  RETURNING supplier_id
)
INSERT INTO party_contact_versions (party_kind, party_id, version, saved_by_command)
SELECT 'supplier', supplier_id, 1, FALSE FROM added
ON CONFLICT (party_kind, party_id) DO UPDATE SET version = party_contact_versions.version + 1, updated_at = now();

-- Who wrote the version row: a write nested in the phone sync (trigger depth above 1) leaves the set «not saved
-- by the command»; any direct write — the contacts command of every backend release, which knows nothing of the
-- column — marks it saved. So no backend has to name the column, and the sync never overrides a saved set.
CREATE OR REPLACE FUNCTION party_contact_versions_saved() RETURNS trigger AS $$
BEGIN
  NEW.saved_by_command := pg_trigger_depth() <= 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_party_contact_versions_saved BEFORE INSERT OR UPDATE ON party_contact_versions
  FOR EACH ROW EXECUTE FUNCTION party_contact_versions_saved();

COMMIT;
