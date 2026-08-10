-- 114_production_status_always_from_details.sql
--
-- Retire production_status_from_details_enabled as a durable manual lock.
-- Order production status is always derived from active details. A manual order
-- status write still cascades that status to active details; recalc writes are
-- marked so the reverse trigger does not loop.

-- Preserve historical manual choices before changing recalc semantics. While the
-- old recalc function still honors production_status_from_details_enabled=false,
-- these detail updates cannot move the parent order backwards.
UPDATE order_details od
SET production_status_id = o.production_status_id,
    updated_at = now()
FROM orders o
WHERE o.order_id = od.order_id
  AND o.production_status_from_details_enabled IS DISTINCT FROM true
  AND o.production_status_id IS NOT NULL
  AND COALESCE(od.delete_flag, false) = false
  AND od.production_status_id IS DISTINCT FROM o.production_status_id;

UPDATE orders
SET production_status_from_details_enabled = true,
    updated_at = now()
WHERE production_status_from_details_enabled IS DISTINCT FROM true;

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
    ORDER BY ps.sort_order ASC
    LIMIT 1;

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
    'Пересчитывает production_status_id заказа из самой отстающей активной детали. Не использует production_status_from_details_enabled как ручной lock.';

CREATE OR REPLACE FUNCTION trg_orders_sync_details_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('erp.detail_status_to_order_recalc', true) = 'on' THEN
        RETURN NEW;
    END IF;

    IF NEW.production_status_id IS NOT DISTINCT FROM OLD.production_status_id THEN
        RETURN NEW;
    END IF;

    IF NEW.production_status_id IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM set_config('erp.order_status_to_details_sync', 'on', true);
    UPDATE order_details
    SET production_status_id = NEW.production_status_id,
        updated_at = now()
    WHERE order_id = NEW.order_id
      AND COALESCE(delete_flag, false) = false
      AND production_status_id IS DISTINCT FROM NEW.production_status_id;
    PERFORM set_config('erp.order_status_to_details_sync', 'off', true);

    RETURN NEW;
END $$;

COMMENT ON FUNCTION trg_orders_sync_details_status() IS
    'Синхронизирует активные детали при прямом изменении production_status_id заказа. Recalc-переходы помечаются и не запускают обратную синхронизацию.';
