-- Authenticated provenance for BASIS refill: rows added to a set by a composition command.
-- A DB-level creation log proves a raw row was INSERTed (never merely updated) inside the
-- same transaction that records its provenance. No backfill: pre-existing rows have no log
-- row and can therefore never be claimed as newly added. Does not enable any producer.
BEGIN;

DO $$
BEGIN
  IF to_regclass(format('%I.%I',current_schema(),'bazis_cut_set_details')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_bazis_composition_intents')) IS NULL
    OR to_regclass(format('%I.%I',current_schema(),'mdf_revision_seals')) IS NULL THEN
    RAISE EXCEPTION 'MDF migration 187 requires BASIS raw rows and migration 185 composition intents in schema %',current_schema();
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS mdf_bazis_raw_row_creations (
  row_id BIGINT NOT NULL CHECK (row_id>0),
  set_id BIGINT NOT NULL CHECK (set_id>0),
  created_txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A (test/admin) re-INSERT of the same id after DELETE is a new creation event, never a conflict.
  PRIMARY KEY(row_id,created_txid)
);

CREATE OR REPLACE FUNCTION mdf_log_bazis_raw_row_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mdf_bazis_raw_row_creations(row_id,set_id,created_txid)
    VALUES (NEW.bazis_cut_set_detail_id,NEW.bazis_cut_set_id,pg_current_xact_id());
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mdf_reject_bazis_refill_log_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MDF BASIS refill provenance is immutable' USING ERRCODE='55000';
END;
$$;

CREATE TABLE IF NOT EXISTS mdf_bazis_composition_new_rows (
  intent_id UUID NOT NULL REFERENCES mdf_bazis_composition_intents(intent_id) ON DELETE RESTRICT,
  row_id BIGINT NOT NULL UNIQUE CHECK (row_id>0),
  order_id BIGINT NOT NULL CHECK (order_id>0),
  detail_id BIGINT NOT NULL CHECK (detail_id>0),
  quantity BIGINT NOT NULL CHECK (quantity>0),
  snapshot_digest TEXT NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(intent_id,row_id)
);

CREATE OR REPLACE FUNCTION mdf_guard_bazis_composition_new_row_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  intent_row mdf_bazis_composition_intents%ROWTYPE;
BEGIN
  SELECT * INTO intent_row FROM mdf_bazis_composition_intents WHERE intent_id=NEW.intent_id;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM mdf_revision_seals WHERE source_kind=intent_row.source_kind
    AND source_id=intent_row.source_id AND revision_key=intent_row.revision_key) THEN
    RAISE EXCEPTION 'MDF BASIS refill row must be attached to an unsealed composition intent' USING ERRCODE='55000';
  END IF;
  -- The raw row must have been INSERTed in THIS transaction into the intent's own set.
  IF NOT EXISTS (SELECT 1 FROM mdf_bazis_raw_row_creations c WHERE c.row_id=NEW.row_id
      AND c.created_txid=pg_current_xact_id() AND c.set_id=intent_row.set_id) THEN
    RAISE EXCEPTION 'MDF BASIS refill row was not created by this composition transaction' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bazis_cut_set_details d WHERE d.bazis_cut_set_detail_id=NEW.row_id
      AND d.bazis_cut_set_id=intent_row.set_id AND d.source_type='order_detail'
      AND d.source_order_id=NEW.order_id AND d.source_order_detail_id=NEW.detail_id AND d.quantity=NEW.quantity
      AND d.source_order_hdf_detail_id IS NULL)
    OR NOT (NEW.order_id = ANY(intent_row.owner_ids)) THEN
    RAISE EXCEPTION 'MDF BASIS refill row differs from its raw row or owner scope' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mdf_bazis_raw_row_creation_log ON bazis_cut_set_details;
CREATE TRIGGER mdf_bazis_raw_row_creation_log AFTER INSERT ON bazis_cut_set_details
  FOR EACH ROW EXECUTE FUNCTION mdf_log_bazis_raw_row_creation();
DROP TRIGGER IF EXISTS mdf_bazis_raw_row_creation_immutable ON mdf_bazis_raw_row_creations;
CREATE TRIGGER mdf_bazis_raw_row_creation_immutable BEFORE UPDATE OR DELETE ON mdf_bazis_raw_row_creations
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_bazis_refill_log_change();
DROP TRIGGER IF EXISTS mdf_bazis_composition_new_row_insert_guard ON mdf_bazis_composition_new_rows;
CREATE TRIGGER mdf_bazis_composition_new_row_insert_guard BEFORE INSERT ON mdf_bazis_composition_new_rows
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_bazis_composition_new_row_insert();
DROP TRIGGER IF EXISTS mdf_bazis_composition_new_row_immutable ON mdf_bazis_composition_new_rows;
CREATE TRIGGER mdf_bazis_composition_new_row_immutable BEFORE UPDATE OR DELETE ON mdf_bazis_composition_new_rows
  FOR EACH ROW EXECUTE FUNCTION mdf_reject_bazis_refill_log_change();

COMMENT ON TABLE mdf_bazis_raw_row_creations IS
  'Trigger-only log of BASIS raw row INSERTs (transaction id); proves refill rows were created, not repurposed.';
COMMENT ON TABLE mdf_bazis_composition_new_rows IS
  'Immutable provenance of rows a BASIS composition intent added (refill); verified by the composition worker.';

COMMIT;
