-- Force orders older than one calendar month into the terminal production status.
-- Switching to manual mode is intentional: the existing order trigger then keeps
-- active order details in Done and prevents later detail aggregation from reverting it.

DO $migration$
DECLARE
  done_status_id production_statuses.production_status_id%TYPE;
  done_status_count integer;
  affected_orders integer;
BEGIN
  SELECT count(*), min(ps.production_status_id)
    INTO done_status_count, done_status_id
    FROM production_statuses ps
   WHERE LOWER(BTRIM(ps.production_status_name)) = 'done'
      OR LOWER(BTRIM(ps.production_status_code)) ~ '^done(_|$)';

  IF done_status_count = 0 THEN
    RAISE EXCEPTION 'Production status Done was not found';
  END IF;
  IF done_status_count > 1 THEN
    RAISE EXCEPTION 'Production status Done is ambiguous: % matches', done_status_count;
  END IF;

  UPDATE orders o
     SET production_status_id = done_status_id,
         production_status_from_details_enabled = false,
         version = o.version + 1
   WHERE o.created_at < CURRENT_TIMESTAMP - INTERVAL '1 month'
     AND (
       o.production_status_id IS DISTINCT FROM done_status_id
       OR o.production_status_from_details_enabled IS DISTINCT FROM false
     );

  GET DIAGNOSTICS affected_orders = ROW_COUNT;
  RAISE NOTICE 'Production Done backfill updated % orders', affected_orders;
END
$migration$;
