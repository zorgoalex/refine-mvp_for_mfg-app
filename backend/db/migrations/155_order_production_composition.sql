-- Informative production summary is not an automation readiness predicate.
BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS production_detail_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS production_unassigned_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS production_distinct_status_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION order_production_summary(
  p_order_id bigint, p_detail_ids bigint[] DEFAULT NULL
) RETURNS TABLE (
  detail_count integer, unassigned_count integer, status_ids integer[], least_status_id smallint
) LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer,
    count(*) FILTER (WHERE ps.production_status_id IS NULL)::integer,
    COALESCE(array_agg(DISTINCT ps.production_status_id::integer ORDER BY ps.production_status_id::integer)
      FILTER (WHERE ps.production_status_id IS NOT NULL), ARRAY[]::integer[]),
    CASE WHEN count(*) FILTER (WHERE ps.production_status_id IS NULL) = 0
      THEN (array_agg(ps.production_status_id ORDER BY ps.sort_order, ps.production_status_id))[1]
      ELSE NULL END
  FROM order_details od
  LEFT JOIN production_statuses ps ON ps.production_status_id = od.production_status_id
  WHERE od.order_id = p_order_id AND COALESCE(od.delete_flag, false) = false
    AND (p_detail_ids IS NULL OR od.detail_id = ANY(p_detail_ids));
$$;

CREATE OR REPLACE FUNCTION recalc_order_production_status(p_order_id bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  summary record;
  previous_guard text := current_setting('erp.detail_status_to_order_recalc', true);
BEGIN
  IF current_setting('erp.order_status_to_details_sync', true) = 'on' THEN RETURN; END IF;
  SELECT * INTO summary FROM order_production_summary(p_order_id);
  PERFORM set_config('erp.detail_status_to_order_recalc', 'on', true);
  UPDATE orders SET production_status_id = summary.least_status_id,
    production_detail_count = summary.detail_count,
    production_unassigned_count = summary.unassigned_count,
    production_distinct_status_count = cardinality(summary.status_ids),
    updated_at = now()
  WHERE order_id = p_order_id AND (
    production_status_id IS DISTINCT FROM summary.least_status_id
    OR production_detail_count IS DISTINCT FROM summary.detail_count
    OR production_unassigned_count IS DISTINCT FROM summary.unassigned_count
    OR production_distinct_status_count IS DISTINCT FROM cardinality(summary.status_ids)
  );
  PERFORM set_config('erp.detail_status_to_order_recalc', COALESCE(previous_guard, ''), true);
END $$;
COMMENT ON FUNCTION recalc_order_production_status(bigint) IS
  'v155: ordinary-detail composition; missing/empty clears minimum; HDF excluded; informative counts, not readiness.';

CREATE OR REPLACE FUNCTION trg_od_recalc_order_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_parent bigint; new_parent bigint; parent bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_parent := OLD.order_id; END IF;
  IF TG_OP <> 'DELETE' THEN new_parent := NEW.order_id; END IF;
  IF TG_OP = 'UPDATE'
    AND OLD.production_status_id IS NOT DISTINCT FROM NEW.production_status_id
    AND OLD.delete_flag IS NOT DISTINCT FROM NEW.delete_flag
    AND OLD.order_id IS NOT DISTINCT FROM NEW.order_id THEN RETURN NEW; END IF;
  FOR parent IN SELECT DISTINCT id FROM unnest(ARRAY[old_parent, new_parent]) id
    WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM recalc_order_production_status(parent);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

-- Membership-only transfers must fire too, even when the stage is unchanged.
DROP TRIGGER IF EXISTS t_od_recalc_order_status ON order_details;
CREATE TRIGGER t_od_recalc_order_status
  AFTER INSERT OR DELETE OR UPDATE OF production_status_id, delete_flag, order_id ON order_details
  FOR EACH ROW EXECUTE FUNCTION trg_od_recalc_order_status();

-- Direct legacy header commands still cascade, then restore a truthful summary.
CREATE OR REPLACE FUNCTION trg_orders_sync_details_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_guard text := current_setting('erp.order_status_to_details_sync', true);
BEGIN
  IF current_setting('erp.detail_status_to_order_recalc', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.production_status_id IS NOT DISTINCT FROM OLD.production_status_id THEN RETURN NEW; END IF;
  IF NEW.production_status_id IS NOT NULL THEN
    PERFORM set_config('erp.order_status_to_details_sync', 'on', true);
    UPDATE order_details SET production_status_id = NEW.production_status_id, updated_at = now()
    WHERE order_id = NEW.order_id AND COALESCE(delete_flag, false) = false
      AND production_status_id IS DISTINCT FROM NEW.production_status_id;
    PERFORM set_config('erp.order_status_to_details_sync', COALESCE(previous_guard, ''), true);
  END IF;
  PERFORM recalc_order_production_status(NEW.order_id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS t_orders_sync_details_status ON orders;
CREATE TRIGGER t_orders_sync_details_status AFTER UPDATE OF production_status_id ON orders
  FOR EACH ROW EXECUTE FUNCTION trg_orders_sync_details_status();

-- Append columns without changing the existing view's order, types or consumers.
DO $$
DECLARE definition text; view_name text;
BEGIN
  FOREACH view_name IN ARRAY ARRAY['orders_view','payments_view'] LOOP
  IF EXISTS (SELECT 1 FROM information_schema.views
    WHERE table_schema = current_schema() AND table_name = view_name)
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = view_name
      AND column_name = 'production_detail_count') THEN
    SELECT pg_get_viewdef(format('%I.%I', current_schema(), view_name)::regclass, true) INTO definition;
    EXECUTE format('CREATE OR REPLACE VIEW %I AS SELECT original.*, ', view_name)
      || 'summary.production_detail_count, summary.production_unassigned_count, '
      || 'summary.production_distinct_status_count FROM (' || rtrim(definition, E';\n ') || ') original '
      || 'LEFT JOIN orders summary ON summary.order_id = original.order_id';
  END IF;
  END LOOP;
END $$;

-- This corrects only derived fields. Do not fire workflow/CRM cascades for backfill.
SET LOCAL session_replication_role = replica;
SELECT recalc_order_production_status(order_id) FROM orders;
SET LOCAL session_replication_role = origin;
COMMIT;
