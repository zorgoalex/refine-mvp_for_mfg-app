-- Событие order.payment_status_changed при любой смене статуса оплаты заказа (план
-- plans/notification-engine/2026-10-27-notification-push-and-payment-events-plan.md, часть A, R3 APPROVED).
-- Статус оплаты меняют платежи, сохранение и снимок заказа, перенос деталей, Bitrix (виджет, входящие оплаты) и
-- действие производства; раньше событие для правил уведомлений писало только действие производства. Теперь его пишет
-- один триггер на orders.payment_status_id.
-- Контекст события — только transaction-local GUC, которые backend ставит перед своим UPDATE
-- (shared/payment-status/payment-status-event-context.ts): erp.event_actor_user_id, erp.event_source,
-- erp.event_correlation_id (иначе erp.request_id). app.user_id (set_session_user) не читается: он живёт на соединении
-- пула и может остаться от прежнего запроса.
-- Молчит, если путь записал событие сам (erp.payment_status_event = 'emitted', действие производства) или служебная
-- массовая операция подавила события (= 'suppressed' — только с причиной в erp.payment_status_event_reason).
-- Только производственные заказы не в корзине. Ключ — на каждый переход (A→B→A→B в одной транзакции = 3 события);
-- откат транзакции убирает их вместе с ней. Старые изменения событий не дают.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.order_payment_status_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_mode text := COALESCE(current_setting('erp.payment_status_event', true), '');
  v_actor text := NULLIF(current_setting('erp.event_actor_user_id', true), '');
  v_source text := COALESCE(NULLIF(current_setting('erp.event_source', true), ''), 'unknown');
  v_correlation text := COALESCE(
    NULLIF(current_setting('erp.event_correlation_id', true), ''),
    NULLIF(current_setting('erp.request_id', true), '')
  );
BEGIN
  IF v_mode = 'emitted' THEN
    RETURN NULL;
  END IF;
  IF v_mode = 'suppressed' THEN
    IF COALESCE(NULLIF(current_setting('erp.payment_status_event_reason', true), ''), '') = '' THEN
      RAISE EXCEPTION 'erp.payment_status_event = suppressed requires erp.payment_status_event_reason'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.order_kind IS DISTINCT FROM 'production_order' OR COALESCE(NEW.delete_flag, false) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
  VALUES (
    'order.payment_status_changed', 'order', NEW.order_id::text,
    jsonb_build_object(
      'eventType', 'order.payment_status_changed',
      'origin', 'db_trigger',
      'actorUserId', CASE WHEN v_actor ~ '^[0-9]+$' THEN v_actor::bigint END,
      'requestId', v_correlation,
      'entityType', 'order', 'entityId', NEW.order_id::text,
      'orderId', NEW.order_id, 'clientId', NEW.client_id,
      'paymentStatusId', NEW.payment_status_id,
      'previousPaymentStatusId', OLD.payment_status_id,
      'action', 'payment_status_change',
      'scope', jsonb_build_object('source', v_source)
    ),
    'order.payment_status_changed:' || NEW.order_id::text || ':' || gen_random_uuid()::text
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_payment_status_event ON public.orders;
CREATE TRIGGER trg_order_payment_status_event
  AFTER UPDATE OF payment_status_id ON public.orders
  FOR EACH ROW
  WHEN (OLD.payment_status_id IS DISTINCT FROM NEW.payment_status_id)
  EXECUTE FUNCTION public.order_payment_status_event();

COMMIT;
