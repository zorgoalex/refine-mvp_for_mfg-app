-- §5.8 logic audit (B1): a lineage-v2 source may receive a contract-less revision ONLY when that revision has no
-- physical evidence line (a bath retirement receipt, a genesis membership) — there is nothing physical to trace.
-- Revision lines are written before the head moves (mdf-receipt.ts) and are sealed, so the check is exact.
-- Everything else of the migration-182 guard is unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION mdf_guard_physical_lineage_source_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_received_is_v2 BOOLEAN := false;
DECLARE new_received_predecessor TEXT;
DECLARE new_received_is_v2 BOOLEAN := false;
BEGIN
  IF TG_OP='INSERT' THEN
    IF EXISTS (SELECT 1 FROM mdf_physical_lineage_contracts c
      WHERE c.source_kind=NEW.source_kind AND c.source_id=NEW.source_id)
      AND NOT EXISTS (SELECT 1 FROM mdf_physical_lineage_contracts c
        WHERE c.source_kind=NEW.source_kind AND c.source_id=NEW.source_id
          AND c.revision_key=NEW.received_revision_key)
      AND EXISTS (SELECT 1 FROM mdf_evidence_lines e WHERE e.source_kind=NEW.source_kind AND e.source_id=NEW.source_id
        AND e.revision_key=NEW.received_revision_key AND e.evidence_kind='physical') THEN
      RAISE EXCEPTION 'MDF lineage-v2 source requires lineage-v2 receipts' USING ERRCODE='23514';
    END IF;
    SELECT c.predecessor_accepted_revision_key INTO new_received_predecessor
      FROM mdf_physical_lineage_contracts c WHERE c.source_kind=NEW.source_kind
        AND c.source_id=NEW.source_id AND c.revision_key=NEW.received_revision_key;
    new_received_is_v2 := FOUND;
    IF new_received_is_v2 AND new_received_predecessor IS NOT NULL THEN
      RAISE EXCEPTION 'MDF initial lineage receipt cannot name a prior accepted revision' USING ERRCODE='23514';
    END IF;
    IF new_received_is_v2 AND NEW.accepted_revision_key IS NOT NULL
      AND NEW.accepted_revision_key IS DISTINCT FROM NEW.received_revision_key THEN
      RAISE EXCEPTION 'MDF initial lineage acceptance must point to its received revision' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT EXISTS (SELECT 1 FROM mdf_physical_lineage_contracts c
    WHERE c.source_kind=OLD.source_kind AND c.source_id=OLD.source_id
      AND c.revision_key=OLD.received_revision_key) INTO old_received_is_v2;
  SELECT c.predecessor_accepted_revision_key INTO new_received_predecessor
    FROM mdf_physical_lineage_contracts c WHERE c.source_kind=NEW.source_kind
      AND c.source_id=NEW.source_id AND c.revision_key=NEW.received_revision_key;
  new_received_is_v2 := FOUND;

  -- Source-wide (like the INSERT branch): once ANY revision of the source carries a v2 contract, a contract-less revision
  -- with physical lines is refused — also after a contract-less intermediate (no downgrade through R2 without physical).
  IF NOT new_received_is_v2
    AND EXISTS (SELECT 1 FROM mdf_physical_lineage_contracts c
      WHERE c.source_kind=NEW.source_kind AND c.source_id=NEW.source_id)
    AND EXISTS (SELECT 1 FROM mdf_evidence_lines e WHERE e.source_kind=NEW.source_kind AND e.source_id=NEW.source_id
      AND e.revision_key=NEW.received_revision_key AND e.evidence_kind='physical') THEN
    RAISE EXCEPTION 'MDF lineage-v2 source requires lineage-v2 receipts' USING ERRCODE='23514';
  END IF;
  IF (old_received_is_v2 OR new_received_is_v2)
    AND NEW.received_revision_key IS DISTINCT FROM OLD.received_revision_key
    AND OLD.accepted_revision_key IS DISTINCT FROM OLD.received_revision_key THEN
    RAISE EXCEPTION 'MDF received lineage cannot advance while its predecessor is pending' USING ERRCODE='23514';
  END IF;
  IF new_received_is_v2 AND (
      NEW.received_revision_key IS DISTINCT FROM OLD.received_revision_key
      OR NEW.accepted_revision_key IS DISTINCT FROM OLD.accepted_revision_key)
    AND new_received_predecessor IS DISTINCT FROM OLD.accepted_revision_key THEN
    RAISE EXCEPTION 'MDF lineage receipt predecessor differs from accepted head' USING ERRCODE='23514';
  END IF;
  IF (old_received_is_v2 OR new_received_is_v2)
    AND NEW.accepted_revision_key IS DISTINCT FROM OLD.accepted_revision_key
    AND NEW.accepted_revision_key IS DISTINCT FROM NEW.received_revision_key THEN
    RAISE EXCEPTION 'MDF lineage acceptance must point to the received revision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
