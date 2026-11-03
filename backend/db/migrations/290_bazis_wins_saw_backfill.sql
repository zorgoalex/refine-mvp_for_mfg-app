-- «Базис» важнее «Раскроя» (решение 03.11): деталь в карточке «Базис раскрой» на шаге «Новый» / «Отрисован» получает
-- статус «Базис» — и когда её держит задание ЧПУ (команды карточек теперь делают так же, saw-status-sync.ts; правило
-- «МДФ файлы на станке → Детали Отрисован» такие детали не трогает). Один раз переводит уже имеющиеся детали:
-- 286 пропустила детали в задании ЧПУ, а правило автостатусов ставило «Отрисован» деталям карточек.
-- Как в 286: заказы (FOR UPDATE) → детали (по id), версия заказа +1, аудит orders.detail_production_status_auto_change
-- по заказу с деталями и переходами, событие outbox order.detail_production_status_auto_changed; буквы пересчитывают
-- триггеры миграции 282. Детали дальше шага не трогаются.
-- Итог — строка аудита orders.saw_status_backfill с entity_id '290' (её наличие — признак применённой миграции).
-- Повторный запуск — no-op; без статусов saw/new/drawn — только итоговая строка.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Маршрут «Базис» (282): деталь, вернувшаяся из saw на тот же шаг — в «Новый» или теперь в «Отрисован» (из карточки
-- убрали, а задание ЧПУ её держит), — в том же круге теряет маршрут, иначе буква «Б» осталась бы у детали ЧПУ.
CREATE OR REPLACE FUNCTION public.trg_order_detail_saw_route()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_saw smallint;
BEGIN
  IF current_setting('erp.pse_writer', true) = 'historical_import' THEN
    RETURN NULL;
  END IF;
  SELECT production_status_id INTO v_saw FROM public.production_statuses WHERE production_status_code = 'saw';
  IF NEW.production_status_id = v_saw THEN
    INSERT INTO public.order_detail_stage_routes (detail_id, round_no, request_id)
    VALUES (NEW.detail_id, NEW.production_round, NULLIF(current_setting('erp.request_id', true), ''))
    ON CONFLICT DO NOTHING;
  ELSIF TG_OP = 'UPDATE' AND OLD.production_status_id = v_saw AND OLD.production_round = NEW.production_round
        AND NEW.production_status_id IN (SELECT production_status_id FROM public.production_statuses
                                          WHERE production_status_code IN ('new', 'drawn')) THEN
    DELETE FROM public.order_detail_stage_routes WHERE detail_id = NEW.detail_id AND round_no = NEW.production_round;
  END IF;
  RETURN NULL;
END $fn$;

DO $$
DECLARE
  v_saw smallint;
  v_new smallint;
  v_drawn smallint;
  v_order record;
  v_version integer;
  v_client bigint;
  v_metadata jsonb;
  v_audit_id uuid;
  v_total integer := 0;
  v_orders integer := 0;
  v_in_cnc integer := 0;
  v_stale_routes integer := 0;
  v_route_order record;
BEGIN
  SELECT production_status_id INTO v_saw FROM public.production_statuses WHERE production_status_code = 'saw';
  SELECT production_status_id INTO v_new FROM public.production_statuses WHERE production_status_code = 'new';
  SELECT production_status_id INTO v_drawn FROM public.production_statuses WHERE production_status_code = 'drawn';

  -- One run only (see 286): a committed run without the ledger row is not repeated.
  PERFORM pg_advisory_xact_lock(hashtext('erp-migration-290-bazis-wins-saw-backfill'));
  IF EXISTS (SELECT 1 FROM public.audit_log WHERE event = 'orders.saw_status_backfill' AND entity_type = 'migration' AND entity_id = '290') THEN
    RAISE NOTICE 'migration 290 already ran (summary row present) — nothing to do';
    RETURN;
  END IF;

  -- Write barrier through the commit (a few seconds): orders EXCLUSIVE (waits for every holder of an order row lock —
  -- every detail-status command takes its order first), then order_details SHARE (waits for in-flight detail writes).
  -- So every saw → drawn written under the 282 trigger is committed and seen by the cleanup below, and every later one
  -- waits for this commit and then runs the trigger replaced above (the lock wait re-reads the catalog).
  LOCK TABLE public.orders IN EXCLUSIVE MODE;
  LOCK TABLE public.order_details IN SHARE MODE;

  -- Letters events written by the 282 triggers carry this request id (correlation with the backfill rows).
  PERFORM set_config('erp.request_id', 'migration-290', true);

  CREATE TEMP TABLE saw_backfill_290_orders (order_id bigint PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE saw_routes_290 (detail_id bigint NOT NULL, order_id bigint NOT NULL, round_no smallint NOT NULL,
                                     status_code text NOT NULL) ON COMMIT DROP;
  CREATE TEMP TABLE saw_backfill_290 (detail_id bigint PRIMARY KEY, order_id bigint NOT NULL, from_code text NOT NULL,
                                      in_cnc boolean NOT NULL) ON COMMIT DROP;

  IF v_saw IS NOT NULL AND v_new IS NOT NULL AND v_drawn IS NOT NULL THEN
    -- The orders first, by id, FOR UPDATE (conflicts with a CNC reservation and the «Базис раскрой» owner lock);
    -- the candidates are read by the next statement within the locked orders, then the details by id.
    WITH locked AS (
      SELECT o.order_id FROM public.orders o
       WHERE o.order_id IN (
         SELECT od.order_id FROM public.order_details od
          WHERE od.production_status_id IN (v_new, v_drawn) AND NOT COALESCE(od.delete_flag, false)
            AND EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id)
         -- and the orders with a stale «Базис» route (below), in the same single lock pass
         UNION SELECT od.order_id FROM public.order_details od
           JOIN public.order_detail_stage_routes r ON r.detail_id = od.detail_id AND r.round_no = od.production_round
          WHERE od.production_status_id IN (v_new, v_drawn))
       ORDER BY o.order_id FOR UPDATE
    )
    INSERT INTO saw_backfill_290_orders (order_id) SELECT order_id FROM locked;

    INSERT INTO saw_backfill_290 (detail_id, order_id, from_code, in_cnc)
    SELECT od.detail_id, od.order_id, CASE WHEN od.production_status_id = v_new THEN 'new' ELSE 'drawn' END,
           EXISTS (SELECT 1 FROM public.cut_job_item c WHERE c.order_detail_id = od.detail_id AND c.is_active)
      FROM public.order_details od
     WHERE od.order_id IN (SELECT order_id FROM saw_backfill_290_orders)
       AND od.production_status_id IN (v_new, v_drawn) AND NOT COALESCE(od.delete_flag, false)
       AND EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id)
     ORDER BY od.detail_id
     FOR UPDATE OF od;

    UPDATE public.order_details od SET production_status_id = v_saw
      FROM saw_backfill_290 s WHERE od.detail_id = s.detail_id;

    -- Stale «Базис» routes: a detail back on «Новый»/«Отрисован» in the same round keeps no route (the trigger above
    -- now drops it on saw → new|drawn; a saw → drawn written while the 282 trigger was still in place — the new backend
    -- before this migration — left one). Only within the orders locked above; the letters follow by the 282 triggers.
    WITH gone AS (
      DELETE FROM public.order_detail_stage_routes r USING public.order_details od
       WHERE r.detail_id = od.detail_id AND r.round_no = od.production_round
         AND od.order_id IN (SELECT order_id FROM saw_backfill_290_orders)
         AND od.production_status_id IN (v_new, v_drawn)
      RETURNING r.detail_id, od.order_id, r.round_no, CASE WHEN od.production_status_id = v_new THEN 'new' ELSE 'drawn' END
    )
    INSERT INTO saw_routes_290 (detail_id, order_id, round_no, status_code) SELECT * FROM gone;
    SELECT count(*) INTO v_stale_routes FROM saw_routes_290;

    -- One audit row per order for the dropped routes (the letters audit of 282 writes nothing when the letters stay).
    FOR v_route_order IN
      SELECT order_id, array_agg(detail_id ORDER BY detail_id) AS detail_ids,
             jsonb_agg(jsonb_build_object('detailId', detail_id, 'roundNo', round_no, 'status', status_code,
                                          'route', jsonb_build_object('before', 'saw', 'after', NULL)) ORDER BY detail_id) AS routes
        FROM saw_routes_290 GROUP BY order_id ORDER BY order_id
    LOOP
      SELECT client_id INTO v_client FROM public.orders WHERE order_id = v_route_order.order_id;
      INSERT INTO public.audit_log (event, entity_type, entity_id, user_id, username, request_id, source,
                                    related_order_id, related_client_id, metadata_json)
      VALUES ('orders.stage_route_repair', 'order', v_route_order.order_id::text, NULL, 'system',
              'migration-290', 'migration', v_route_order.order_id, v_client,
              jsonb_build_object('cause', 'migration_route_repair', 'reason', 'saw_route_on_new_or_drawn',
                'detailIds', to_jsonb(v_route_order.detail_ids), 'routes', v_route_order.routes, 'requestId', 'migration-290'))
      RETURNING audit_id INTO v_audit_id;
      INSERT INTO public.audit_log_related_entity (audit_id, entity_type, entity_id)
      SELECT v_audit_id, 'order_detail', d FROM unnest(v_route_order.detail_ids) d
      ON CONFLICT DO NOTHING;
    END LOOP;

    FOR v_order IN
      SELECT order_id, array_agg(detail_id ORDER BY detail_id) AS detail_ids,
             jsonb_agg(jsonb_build_object('detailId', detail_id, 'from', from_code, 'to', 'saw') ORDER BY detail_id) AS transitions
        FROM saw_backfill_290 GROUP BY order_id ORDER BY order_id
    LOOP
      UPDATE public.orders SET version = version + 1 WHERE order_id = v_order.order_id
        RETURNING version, client_id INTO v_version, v_client;
      v_metadata := jsonb_build_object(
        'cause', 'migration_backfill', 'setId', NULL, 'detailIds', to_jsonb(v_order.detail_ids),
        'transitions', v_order.transitions, 'orderVersion', v_version, 'requestId', 'migration-290');
      INSERT INTO public.audit_log (event, entity_type, entity_id, user_id, username, request_id, source,
                                    related_order_id, related_client_id, status_field, metadata_json)
      VALUES ('orders.detail_production_status_auto_change', 'order', v_order.order_id::text, NULL, 'system',
              'migration-290', 'migration', v_order.order_id, v_client, 'productionDetailStatus', v_metadata)
      RETURNING audit_id INTO v_audit_id;
      INSERT INTO public.audit_log_related_entity (audit_id, entity_type, entity_id)
      SELECT v_audit_id, 'order_detail', d FROM unnest(v_order.detail_ids) d
      ON CONFLICT DO NOTHING;
      INSERT INTO public.outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
      VALUES ('order.detail_production_status_auto_changed', 'order', v_order.order_id::text,
              jsonb_build_object('eventType', 'order.detail_production_status_auto_changed',
                'orderId', v_order.order_id, 'actorUserId', NULL) || v_metadata,
              'saw-backfill:290:' || v_order.order_id)
      ON CONFLICT (idempotency_key) DO NOTHING;
      v_orders := v_orders + 1;
      v_total := v_total + cardinality(v_order.detail_ids);
    END LOOP;
    SELECT count(*) INTO v_in_cnc FROM saw_backfill_290 WHERE in_cnc;
  END IF;

  INSERT INTO public.audit_log (event, entity_type, entity_id, user_id, username, request_id, source, metadata_json)
  VALUES ('orders.saw_status_backfill', 'migration', '290', NULL, 'system', 'migration-290', 'migration',
          jsonb_build_object('origin', 'bazis_wins_over_cnc', 'details', v_total, 'orders', v_orders,
            'inCncJob', v_in_cnc, 'staleRoutesDropped', v_stale_routes,
            'fromNew', (SELECT count(*) FROM pg_temp.saw_backfill_290 WHERE from_code = 'new'),
            'fromDrawn', (SELECT count(*) FROM pg_temp.saw_backfill_290 WHERE from_code = 'drawn')));
END $$;

COMMIT;
