-- Статус «Базис» (миграция 282) для деталей, попавших в карточки «Базис раскрой» до его появления: один раз переводит
-- «Новый» → «Базис» по тому же правилу, что команды карточек (saw-status-sync.ts): деталь в карточке «Базис раскрой»,
-- не в задании ЧПУ (такие ведёт человек — статус не меняется), не удалена. Детали дальше «Новый» не трогаются.
-- Как в команде: заказы (FOR UPDATE — конфликтует с резервом ЧПУ) → детали (по id), версия заказа +1, аудит orders.detail_production_status_auto_change по заказу
-- с деталями, событие outbox order.detail_production_status_auto_changed; буквы пересчитывают триггеры миграции 282.
-- Итог — строка аудита orders.saw_status_backfill (её наличие — признак применённой миграции).
-- Повторный запуск — no-op: при итоговой строке миграция ничего не делает (и не дописывает); без статусов saw/new —
-- только итоговая строка.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  v_saw smallint;
  v_new smallint;
  v_order record;
  v_version integer;
  v_client bigint;
  v_metadata jsonb;
  v_audit_id uuid;
  v_total integer := 0;
  v_orders integer := 0;
BEGIN
  SELECT production_status_id INTO v_saw FROM public.production_statuses WHERE production_status_code = 'saw';
  SELECT production_status_id INTO v_new FROM public.production_statuses WHERE production_status_code = 'new';

  -- One run only: a run that committed (its summary row) but missed the migration ledger is not repeated — a repeat
  -- could move a detail freed since then without its own outbox event (the per-order key is already taken).
  PERFORM pg_advisory_xact_lock(hashtext('erp-migration-286-saw-status-backfill'));
  IF EXISTS (SELECT 1 FROM public.audit_log WHERE event = 'orders.saw_status_backfill' AND entity_type = 'migration' AND entity_id = '286') THEN
    RAISE NOTICE 'migration 286 already ran (summary row present) — nothing to do';
    RETURN;
  END IF;

  -- Letters events written by the 282 triggers carry this request id (correlation with the backfill rows).
  PERFORM set_config('erp.request_id', 'migration-286', true);

  CREATE TEMP TABLE saw_backfill_286_orders (order_id bigint PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE saw_backfill_286 (detail_id bigint PRIMARY KEY, order_id bigint NOT NULL) ON COMMIT DROP;

  IF v_saw IS NOT NULL AND v_new IS NOT NULL THEN
    -- The orders of every «Новый» detail in a card, by id, FOR UPDATE: it conflicts with the FOR KEY SHARE a CNC
    -- reservation takes on its orders (lockReservedOrders) and with the «Базис раскрой» owner lock, so no reservation
    -- or card change of these orders is in flight once it is held. The candidates are read by the next statement
    -- (a fresh snapshot in READ COMMITTED) and only within the locked orders; then the details by id.
    WITH locked AS (
      SELECT o.order_id FROM public.orders o
       WHERE o.order_id IN (
         SELECT od.order_id FROM public.order_details od
          WHERE od.production_status_id = v_new AND NOT COALESCE(od.delete_flag, false)
            AND EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id))
       ORDER BY o.order_id FOR UPDATE
    )
    INSERT INTO saw_backfill_286_orders (order_id) SELECT order_id FROM locked;

    INSERT INTO saw_backfill_286 (detail_id, order_id)
    SELECT od.detail_id, od.order_id FROM public.order_details od
     WHERE od.order_id IN (SELECT order_id FROM saw_backfill_286_orders)
       AND od.production_status_id = v_new AND NOT COALESCE(od.delete_flag, false)
       AND EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id)
       AND NOT EXISTS (SELECT 1 FROM public.cut_job_item c WHERE c.order_detail_id = od.detail_id AND c.is_active)
     ORDER BY od.detail_id
     FOR UPDATE OF od;

    UPDATE public.order_details od SET production_status_id = v_saw
      FROM saw_backfill_286 s WHERE od.detail_id = s.detail_id;

    FOR v_order IN
      SELECT order_id, array_agg(detail_id ORDER BY detail_id) AS detail_ids
        FROM saw_backfill_286 GROUP BY order_id ORDER BY order_id
    LOOP
      -- A stale client of the order (its version) must not overwrite the new statuses.
      UPDATE public.orders SET version = version + 1 WHERE order_id = v_order.order_id
        RETURNING version, client_id INTO v_version, v_client;
      v_metadata := jsonb_build_object(
        'cause', 'migration_backfill', 'setId', NULL, 'detailIds', to_jsonb(v_order.detail_ids),
        'transitions', (SELECT jsonb_agg(jsonb_build_object('detailId', d, 'from', 'new', 'to', 'saw') ORDER BY d)
                          FROM unnest(v_order.detail_ids) d),
        'orderVersion', v_version, 'requestId', 'migration-286');
      INSERT INTO public.audit_log (event, entity_type, entity_id, user_id, username, request_id, source,
                                    related_order_id, related_client_id, status_field, metadata_json)
      VALUES ('orders.detail_production_status_auto_change', 'order', v_order.order_id::text, NULL, 'system',
              'migration-286', 'migration', v_order.order_id, v_client, 'productionDetailStatus', v_metadata)
      RETURNING audit_id INTO v_audit_id;
      INSERT INTO public.audit_log_related_entity (audit_id, entity_type, entity_id)
      SELECT v_audit_id, 'order_detail', d FROM unnest(v_order.detail_ids) d
      ON CONFLICT DO NOTHING;
      INSERT INTO public.outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
      VALUES ('order.detail_production_status_auto_changed', 'order', v_order.order_id::text,
              jsonb_build_object('eventType', 'order.detail_production_status_auto_changed',
                'orderId', v_order.order_id, 'actorUserId', NULL) || v_metadata,
              'saw-backfill:286:' || v_order.order_id)
      ON CONFLICT (idempotency_key) DO NOTHING;
      v_orders := v_orders + 1;
      v_total := v_total + cardinality(v_order.detail_ids);
    END LOOP;
  END IF;

  INSERT INTO public.audit_log (event, entity_type, entity_id, user_id, username, request_id, source, metadata_json)
  VALUES ('orders.saw_status_backfill', 'migration', '286', NULL, 'system', 'migration-286', 'migration',
          jsonb_build_object('origin', 'bazis_cut_cards_before_282', 'details', v_total, 'orders', v_orders,
            'skippedInCncJob', (SELECT count(*) FROM public.order_details od
                                 WHERE od.production_status_id = v_new AND NOT COALESCE(od.delete_flag, false)
                                   AND EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id))));
END $$;

COMMIT;
