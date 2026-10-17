-- 256: the version of a doweling order follows every change of its fields and of its links.
--
-- Doweling writes move to backend commands that compare `doweling_orders.version` (optimistic lock of the doweling
-- card). Other writers change a doweling order too: the order save (links, design engineer), the order snapshot import,
-- the Bazis import and — until its write permissions are revoked — Hasura. None of them bumped the version, so a stale
-- card could silently overwrite their changes. Two triggers make every writer participate:
--   * BEFORE UPDATE on doweling_orders: a change of any column except version/updated_at/edited_by bumps the version,
--     unless the statement sets the version itself;
--   * AFTER INSERT/UPDATE/DELETE on order_doweling_links: a change of the set of active links (delete_flag, order_id,
--     doweling_order_id) bumps the version of the affected doweling orders.
-- At most one bump per doweling order per transaction: a bumped id is noted in the transaction-local setting
-- erp.doweling_versions_bumped (set_config(..., true) — rolled back with a savepoint or the transaction), so one order
-- save that touches several links of the same doweling order moves its version by one. A no-op UPDATE does not count
-- as a bump (unlike a test on the transaction id of the row version).
--
-- Additive (functions + triggers). Rollback: DROP TRIGGER trg_doweling_orders_bump_version ON doweling_orders;
-- DROP TRIGGER trg_odl_bump_doweling_version ON order_doweling_links; DROP TRIGGER trg_doweling_orders_note_created ON
-- doweling_orders; DROP FUNCTION of the five functions — the
-- previous backend never reads the version of a doweling order for a write.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.doweling_version_bumped_in_xact(p_doweling_order_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT position(',' || p_doweling_order_id || ',' IN coalesce(current_setting('erp.doweling_versions_bumped', true), '')) > 0
$$;

CREATE OR REPLACE FUNCTION public.note_doweling_version_bumped(p_doweling_order_id bigint)
RETURNS void
LANGUAGE sql
AS $$
  SELECT set_config(
    'erp.doweling_versions_bumped',
    coalesce(nullif(current_setting('erp.doweling_versions_bumped', true), ''), ',') || p_doweling_order_id || ',',
    true)
$$;

CREATE OR REPLACE FUNCTION public.doweling_orders_bump_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version IS DISTINCT FROM OLD.version THEN
    -- The statement moved the version itself (a backend command, or the link trigger below).
    PERFORM public.note_doweling_version_bumped(OLD.doweling_order_id);
  ELSIF (to_jsonb(NEW) - ARRAY['version', 'updated_at', 'edited_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['version', 'updated_at', 'edited_by'])
        AND NOT public.doweling_version_bumped_in_xact(OLD.doweling_order_id) THEN
    NEW.version := OLD.version + 1;
    PERFORM public.note_doweling_version_bumped(OLD.doweling_order_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.order_doweling_links_bump_doweling_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected bigint[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    affected := CASE WHEN NEW.delete_flag THEN ARRAY[]::bigint[] ELSE ARRAY[NEW.doweling_order_id] END;
  ELSIF TG_OP = 'DELETE' THEN
    affected := CASE WHEN OLD.delete_flag THEN ARRAY[]::bigint[] ELSE ARRAY[OLD.doweling_order_id] END;
  ELSIF (OLD.delete_flag, OLD.order_id, OLD.doweling_order_id)
        IS DISTINCT FROM (NEW.delete_flag, NEW.order_id, NEW.doweling_order_id) THEN
    affected := ARRAY[OLD.doweling_order_id, NEW.doweling_order_id];
  ELSE
    RETURN NULL;
  END IF;

  -- The BEFORE UPDATE trigger notes the bump (the version changes in this statement).
  UPDATE public.doweling_orders d
  SET version = d.version + 1
  WHERE d.doweling_order_id = ANY (affected)
    AND NOT public.doweling_version_bumped_in_xact(d.doweling_order_id);
  RETURN NULL;
END;
$$;

-- A doweling order created in this transaction starts at its inserted version: linking it right away (quick-create
-- from an order, Bazis import) is part of the creation, not a change.
CREATE OR REPLACE FUNCTION public.doweling_orders_note_created()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.note_doweling_version_bumped(NEW.doweling_order_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_doweling_orders_note_created ON public.doweling_orders;
CREATE TRIGGER trg_doweling_orders_note_created
  BEFORE INSERT ON public.doweling_orders
  FOR EACH ROW EXECUTE FUNCTION public.doweling_orders_note_created();

DROP TRIGGER IF EXISTS trg_doweling_orders_bump_version ON public.doweling_orders;
CREATE TRIGGER trg_doweling_orders_bump_version
  BEFORE UPDATE ON public.doweling_orders
  FOR EACH ROW EXECUTE FUNCTION public.doweling_orders_bump_version();

DROP TRIGGER IF EXISTS trg_odl_bump_doweling_version ON public.order_doweling_links;
CREATE TRIGGER trg_odl_bump_doweling_version
  AFTER INSERT OR UPDATE OR DELETE ON public.order_doweling_links
  FOR EACH ROW EXECUTE FUNCTION public.order_doweling_links_bump_doweling_version();

COMMIT;
