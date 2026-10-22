-- K4b rollback cleanup (not a migration: the runner skips *_rollback.sql): run it between stopping the K4b backend and starting the previous image (nothing writes then);
-- order: BACKEND_CLIENT_ONEC_CONTACTS_SYNC=false in the env → stop the backend → this file → start the previous image.
-- The copies of 1C contacts of clients and their profiles go; every client that had a copy or a profile gets a new
-- contacts version (an open editor re-reads). Migration 271 stays (its checks are only wider).
-- Even with a writer still running it is safe: every client concerned is locked first, as the contacts command, the 1C
-- sync and a merge undo lock the client before its contacts and profile — an undo that waits behind this reads no
-- profile afterwards and gives no copy back; a held client lock makes the file fail at once (lock_timeout) — run again.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TEMP TABLE k4b_rollback_clients ON COMMIT DROP AS
  SELECT client_id FROM client_contacts WHERE origin = 'onec'
  UNION SELECT party_id FROM party_onec_profiles WHERE party_kind = 'client';
SELECT c.client_id FROM clients c JOIN k4b_rollback_clients r USING (client_id) ORDER BY c.client_id FOR NO KEY UPDATE OF c;
-- A copy or a profile that appeared between the snapshot of the list and the locks: the list is read again under them.
INSERT INTO k4b_rollback_clients
  SELECT client_id FROM client_contacts WHERE origin = 'onec'
  UNION SELECT party_id FROM party_onec_profiles WHERE party_kind = 'client'
  EXCEPT SELECT client_id FROM k4b_rollback_clients;
SELECT c.client_id FROM clients c JOIN k4b_rollback_clients r USING (client_id) ORDER BY c.client_id FOR NO KEY UPDATE OF c;
INSERT INTO party_contact_versions (party_kind, party_id, version)
SELECT 'client', client_id, 1 FROM k4b_rollback_clients
ON CONFLICT (party_kind, party_id) DO UPDATE SET version = party_contact_versions.version + 1, updated_at = now();
DELETE FROM client_contacts WHERE origin = 'onec';
DELETE FROM party_onec_profiles WHERE party_kind = 'client';
COMMIT;
-- Expect 0 and 0:
SELECT count(*) AS client_copies FROM client_contacts WHERE origin = 'onec';
SELECT count(*) AS client_profiles FROM party_onec_profiles WHERE party_kind = 'client';
