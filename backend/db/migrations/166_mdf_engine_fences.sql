-- Preserve source and publication fences before introducing runtime producers.
-- Additive follow-up: never edit the already-applied foundation migration.
BEGIN;

CREATE OR REPLACE FUNCTION mdf_guard_source_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'MDF source fence cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF (NEW.source_kind,NEW.source_id) IS DISTINCT FROM (OLD.source_kind,OLD.source_id)
    OR NEW.version<OLD.version OR NEW.correction_epoch<OLD.correction_epoch THEN
    RAISE EXCEPTION 'MDF source fence cannot move backwards' USING ERRCODE='55000';
  END IF;
  IF (NEW.received_revision_key,NEW.accepted_revision_key,NEW.correction_epoch)
      IS DISTINCT FROM (OLD.received_revision_key,OLD.accepted_revision_key,OLD.correction_epoch)
    AND NEW.version<=OLD.version THEN
    RAISE EXCEPTION 'MDF source change requires a new version' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mdf_source_fence_guard ON mdf_source_heads;
CREATE TRIGGER mdf_source_fence_guard BEFORE UPDATE OR DELETE ON mdf_source_heads
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_source_fence();

CREATE OR REPLACE FUNCTION mdf_guard_published_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'MDF engine fence cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.published_revision<OLD.published_revision THEN
    RAISE EXCEPTION 'MDF published revision cannot move backwards' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mdf_published_fence_guard ON mdf_engine_state;
CREATE TRIGGER mdf_published_fence_guard BEFORE UPDATE OR DELETE ON mdf_engine_state
  FOR EACH ROW EXECUTE FUNCTION mdf_guard_published_fence();

COMMIT;
