-- «Переделка» — закрытие круга при готовности (план 2026-09-27-order-rework-status-plan v18, §5.4).
--
-- Открытый круг закрывается, когда заказ достигает «Готов к выдаче» (legacy_6 →
-- close_reason ready), «Выдан» (legacy_7 → issued) или «Завершен» (legacy_8 →
-- completed) — из любого статуса и любым писателем (сохранение заказа, смена
-- статуса, автоматизация, Bitrix, WhatsApp-сигналы, …), в той же транзакции.
-- Реализовано триггером на orders, а не helper-ом в каждом писателе: ни один путь
-- не может забыть закрытие (deferred-constraint миграции 210 иначе отклонил бы
-- статус 6/7/8 при открытом круге).
--
-- Однократно на круг: audit_log `order.rework_closed` + outbox `order.rework_closed`
-- (ключ order:{id}:rework:{round}:closed:{seq}). Закрытие — системное следствие
-- смены статуса: актор не угадывается (closed_by и user_id = NULL; `app.user_id`
-- сессионный и может быть чужим), requestId = `db-order-rework-close:<txid>`.
-- Точный актор и запрос — в аудите писателя этой же транзакции: у всех строк
-- audit_log одной транзакции одинаковый created_at (= now()), поэтому связь —
-- related_order_id + created_at (metadata.correlation, metadata.transactionTimestamp).
-- «Это не переделка» закрывает круг сама до смены статуса — здесь круга уже нет.

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_orders_close_rework_round()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_code TEXT;
  v_close_reason TEXT;
  v_request_id TEXT := 'db-order-rework-close:' || txid_current()::TEXT;
  v_round RECORD;
  v_key TEXT;
  v_detail_ids BIGINT[];
  v_audit_id UUID;
BEGIN
  IF NEW.order_status_id IS NOT DISTINCT FROM OLD.order_status_id THEN
    RETURN NULL;
  END IF;
  SELECT order_status_code INTO v_code FROM public.order_statuses WHERE order_status_id = NEW.order_status_id;
  v_close_reason := CASE v_code
    WHEN 'legacy_6' THEN 'ready'
    WHEN 'legacy_7' THEN 'issued'
    WHEN 'legacy_8' THEN 'completed'
  END;
  IF v_close_reason IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE public.order_production_rounds
  SET closed_at = now(), closed_by = NULL, close_reason = v_close_reason, event_seq = event_seq + 1
  WHERE order_id = NEW.order_id AND closed_at IS NULL
  RETURNING order_production_round_id, round_no, mode, event_seq, from_order_status_id INTO v_round;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT array_agg(detail_id ORDER BY detail_id) INTO v_detail_ids
  FROM public.order_production_round_details
  WHERE order_production_round_id = v_round.order_production_round_id;

  v_key := format('order:%s:rework:%s:closed:%s', NEW.order_id, v_round.round_no, v_round.event_seq);

  INSERT INTO public.outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
  VALUES (
    'order.rework_closed',
    'order',
    NEW.order_id::TEXT,
    jsonb_build_object(
      'source', 'db-order-rework-close',
      'eventType', 'order.rework_closed',
      'entityType', 'order',
      'entityId', NEW.order_id::TEXT,
      'orderId', NEW.order_id,
      'clientId', NEW.client_id,
      'roundNo', v_round.round_no,
      'mode', v_round.mode,
      'closeReason', v_close_reason,
      'orderStatusId', NEW.order_status_id,
      'detailIds', COALESCE(to_jsonb(v_detail_ids), '[]'::jsonb),
      'actorUserId', NULL,
      'actor', 'system:order_status_transition',
      'requestId', v_request_id,
      'transactionTimestamp', now(),
      'txid', txid_current(),
      'outboxIdempotencyKey', v_key
    ),
    v_key
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.audit_log (
    event, entity_type, entity_id, user_id, request_id, source,
    related_order_id, related_client_id, status_field, status_id, status_code,
    before_json, after_json, diff_json, metadata_json
  ) VALUES (
    'order.rework_closed', 'order', NEW.order_id::TEXT, NULL, v_request_id, 'db-order-rework-close',
    NEW.order_id, NEW.client_id, 'orderStatus', NEW.order_status_id, v_code,
    jsonb_build_object('orderStatusId', OLD.order_status_id, 'roundOpen', true),
    jsonb_build_object('orderStatusId', NEW.order_status_id, 'roundOpen', false),
    jsonb_build_object('orderStatusId', jsonb_build_object('before', OLD.order_status_id, 'after', NEW.order_status_id)),
    jsonb_build_object(
      'roundNo', v_round.round_no, 'mode', v_round.mode, 'closeReason', v_close_reason,
      'detailIds', COALESCE(to_jsonb(v_detail_ids), '[]'::jsonb), 'eventSeq', v_round.event_seq,
      'txid', txid_current(), 'outboxIdempotencyKey', v_key,
      'actor', 'system:order_status_transition',
      'correlation', 'same_transaction_audit: related_order_id + created_at',
      'transactionTimestamp', now()
    )
  )
  RETURNING audit_id INTO v_audit_id;

  INSERT INTO public.audit_log_related_entity (audit_id, entity_type, entity_id)
  SELECT v_audit_id, 'order_detail', detail_id FROM unnest(COALESCE(v_detail_ids, ARRAY[]::BIGINT[])) AS detail_id
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_orders_close_rework_round ON public.orders;
CREATE TRIGGER trg_orders_close_rework_round
AFTER UPDATE OF order_status_id ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.trg_orders_close_rework_round();

COMMIT;
