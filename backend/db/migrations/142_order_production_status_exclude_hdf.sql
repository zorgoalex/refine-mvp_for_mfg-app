-- Order production status is derived exclusively from active ordinary details.
-- HDF details have their own workflow and must not move the parent order.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM production_statuses
    GROUP BY lower(btrim(production_status_name))
    HAVING count(DISTINCT production_status_code) > 1
  ) THEN
    RAISE EXCEPTION 'production_statuses contains ambiguous normalized names';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION recalc_order_production_status(p_order_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_new_status_id SMALLINT;
    v_current_status_id SMALLINT;
BEGIN
    IF current_setting('erp.order_status_to_details_sync', true) = 'on' THEN
        RETURN;
    END IF;

    SELECT production_status_id
    INTO v_current_status_id
    FROM orders
    WHERE order_id = p_order_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT ps.production_status_id
    INTO v_new_status_id
    FROM order_details od
    JOIN production_statuses ps ON ps.production_status_id = od.production_status_id
    WHERE od.order_id = p_order_id
      AND COALESCE(od.delete_flag, false) = false
      AND od.production_status_id IS NOT NULL
    ORDER BY ps.sort_order ASC, ps.production_status_id ASC
    LIMIT 1;

    -- No ordinary-detail candidate: preserve the current order header.
    IF v_new_status_id IS NULL THEN
        RETURN;
    END IF;

    IF v_current_status_id IS DISTINCT FROM v_new_status_id THEN
        PERFORM set_config('erp.detail_status_to_order_recalc', 'on', true);
        UPDATE orders
        SET production_status_id = v_new_status_id,
            updated_at = now()
        WHERE order_id = p_order_id;
        PERFORM set_config('erp.detail_status_to_order_recalc', 'off', true);
    END IF;
END $$;

COMMENT ON FUNCTION recalc_order_production_status(BIGINT) IS
  'v142: derives order production_status_id from the least-advanced active ordinary order_detail only; HDF is excluded.';

-- This is a system correction, not a user workflow transition. Suppress row
-- triggers (notably CRM outbox) only for this transaction while recalculating.
SET LOCAL session_replication_role = replica;
SELECT recalc_order_production_status(order_id)
FROM orders
WHERE COALESCE(delete_flag, false) = false;
SET LOCAL session_replication_role = origin;

COMMIT;
