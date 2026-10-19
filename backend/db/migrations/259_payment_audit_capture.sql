-- 259: the payment audit records exactly the rows its own transaction changed (plan 2026-10-18 payment history, R4).
--
-- A command that writes payments turns capture on for its transaction (transaction-local setting
-- app.payment_audit_capture = 'on') and creates the session temp table pg_temp.payment_audit_capture. While it is
-- on, these triggers keep the FIRST image of every payments row and of the payment totals of every orders row the
-- transaction touches: the old row for UPDATE/DELETE, null for an inserted payment, and a zero baseline for an
-- inserted order. The backend then compares those images with the rows as the transaction left them. Rows changed
-- by other transactions are never captured, so they are never attributed to the command.
--
-- Additive: two functions and three triggers. With capture off (the default, and always for the previous backend)
-- each trigger returns at its first check. A rolled-back savepoint also rolls back its captured rows.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.payment_audit_capture_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(current_setting('app.payment_audit_capture', true), '') <> 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO pg_temp.payment_audit_capture (kind, id, image)
  VALUES (
    'payment',
    CASE WHEN TG_OP = 'INSERT' THEN NEW.payment_id ELSE OLD.payment_id END,
    CASE WHEN TG_OP = 'INSERT' THEN 'null'::jsonb ELSE to_jsonb(OLD) END
  )
  ON CONFLICT (kind, id) DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.payment_audit_capture_order() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(current_setting('app.payment_audit_capture', true), '') <> 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO pg_temp.payment_audit_capture (kind, id, image)
  VALUES (
    'order',
    NEW.order_id,
    CASE WHEN TG_OP = 'INSERT'
      THEN jsonb_build_object('paid_amount', 0, 'payment_status_id', NULL, 'created', true)
      ELSE jsonb_build_object('paid_amount', OLD.paid_amount, 'payment_status_id', OLD.payment_status_id, 'created', false)
    END
  )
  ON CONFLICT (kind, id) DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_payments_audit_capture ON public.payments;
CREATE TRIGGER trg_payments_audit_capture
  AFTER INSERT OR UPDATE OR DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.payment_audit_capture_payment();

DROP TRIGGER IF EXISTS trg_orders_audit_capture_insert ON public.orders;
CREATE TRIGGER trg_orders_audit_capture_insert
  AFTER INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.payment_audit_capture_order();

DROP TRIGGER IF EXISTS trg_orders_audit_capture_totals ON public.orders;
CREATE TRIGGER trg_orders_audit_capture_totals
  AFTER UPDATE OF paid_amount, payment_status_id ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.payment_audit_capture_order();

COMMIT;
