-- Статус «Базис» (миграция 282) в работе ЧПУ и откате:
-- 1) сохранённая настройка «готовые к раскрою статусы» (cut_settings 'eligibility.statuses', миграция 023) получает
--    код saw рядом с drawn, если drawn в ней есть и saw ещё нет (пользовательские коды сохраняются): деталь «Базис» можно
--    добавить в задание ЧПУ — с предупреждением, как задумано (план §10.4);
-- 2) reconcile_saw_detail_statuses() — сверка статуса «Базис» с составом карточек «Базис раскрой» после работы прежнего
--    backend (откат): «Базис»-деталь ни в одной карточке → «Новый»; «Новая» деталь, попавшая в карточку ПОСЛЕ p_since
--    (начало отката) и не в задании ЧПУ → «Базис»; такая деталь, уже ушедшая дальше шага (распил…), получает маршрут
--    «Базис» своего круга (статус сохраняется). Карточки до отката не переводятся (решение пользователя — отдельно).
--    Заказы по id FOR UPDATE, затем детали; erp.request_id = p_request_id; аудит со связями деталей и outbox-событие
--    order.detail_production_status_auto_changed (как синхронизация команд), идемпотентно по (run, order).
-- Повторный запуск — no-op.

BEGIN;

SET LOCAL lock_timeout = '5s';

UPDATE public.cut_settings
   SET value = jsonb_set(value, '{codes}', (value->'codes') || '["saw"]'::jsonb)
 WHERE key = 'eligibility.statuses'
   AND jsonb_typeof(value->'codes') = 'array'
   AND (value->'codes') ? 'drawn'
   AND NOT (value->'codes') ? 'saw';

DROP FUNCTION IF EXISTS public.reconcile_saw_detail_statuses(text);
CREATE OR REPLACE FUNCTION public.reconcile_saw_detail_statuses(p_since timestamptz, p_request_id text DEFAULT 'saw-reconcile')
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_saw smallint;
  v_new smallint;
  v_step integer;
  v_orders bigint[];
  v_changed integer := 0;
  v_order bigint;
  v_rows jsonb;
  v_routes jsonb;
  v_client bigint;
  v_version integer;
  v_audit uuid;
BEGIN
  SELECT production_status_id INTO v_saw FROM public.production_statuses WHERE production_status_code = 'saw';
  SELECT production_status_id INTO v_new FROM public.production_statuses WHERE production_status_code = 'new';
  SELECT sort_order INTO v_step FROM public.production_statuses WHERE production_status_code = 'drawn';
  IF v_saw IS NULL OR v_new IS NULL THEN
    RETURN 0;
  END IF;
  -- The correlation of every trigger fact of this run (letters, routes, marks) — as a command's request id.
  PERFORM set_config('erp.request_id', p_request_id, true);
  -- Candidates: (a) «Базис» in no card → «Новый»; (b) «Новая» in a card added in the window, not in a CNC job →
  -- «Базис»; (c) a detail of a card added in the window that already went past the step (cut, …) without a route of
  -- its round and not in a CNC job → the «Базис» route is restored (its status stays).
  SELECT array_agg(DISTINCT od.order_id ORDER BY od.order_id) INTO v_orders
    FROM public.order_details od
    LEFT JOIN public.production_statuses ps ON ps.production_status_id = od.production_status_id
   WHERE NOT COALESCE(od.delete_flag, false)
     AND ((od.production_status_id = v_saw
           AND NOT EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id))
       OR (p_since IS NOT NULL
           AND EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id AND b.created_at >= p_since)
           AND NOT EXISTS (SELECT 1 FROM public.cut_job_item c WHERE c.order_detail_id = od.detail_id AND c.is_active)
           AND (od.production_status_id = v_new
             OR (ps.sort_order > v_step AND NOT EXISTS (SELECT 1 FROM public.order_detail_stage_routes r
                  WHERE r.detail_id = od.detail_id AND r.round_no = od.production_round)))));
  IF v_orders IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM 1 FROM public.orders WHERE order_id = ANY (v_orders) ORDER BY order_id FOR UPDATE;
  FOREACH v_order IN ARRAY v_orders LOOP
    -- (a)/(b): status changes
    WITH targets AS (
      SELECT od.detail_id,
             CASE WHEN od.production_status_id = v_saw THEN v_new ELSE v_saw END AS to_status,
             od.production_status_id AS from_status
        FROM public.order_details od
       WHERE od.order_id = v_order AND NOT COALESCE(od.delete_flag, false)
         AND ((od.production_status_id = v_saw
               AND NOT EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id))
           OR (od.production_status_id = v_new AND p_since IS NOT NULL
               AND EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id AND b.created_at >= p_since)
               AND NOT EXISTS (SELECT 1 FROM public.cut_job_item c WHERE c.order_detail_id = od.detail_id AND c.is_active)))
       ORDER BY od.detail_id
       FOR UPDATE OF od
    ), updated AS (
      UPDATE public.order_details od SET production_status_id = t.to_status
        FROM targets t WHERE od.detail_id = t.detail_id
      RETURNING od.detail_id, t.from_status, t.to_status
    )
    SELECT jsonb_agg(jsonb_build_object('detailId', detail_id, 'from', from_status, 'to', to_status) ORDER BY detail_id)
      INTO v_rows FROM updated;
    -- (c): restored routes of details past the step
    WITH restored AS (
      INSERT INTO public.order_detail_stage_routes (detail_id, round_no, request_id)
      SELECT od.detail_id, od.production_round, p_request_id
        FROM public.order_details od
        JOIN public.production_statuses ps ON ps.production_status_id = od.production_status_id
       WHERE od.order_id = v_order AND NOT COALESCE(od.delete_flag, false) AND p_since IS NOT NULL
         AND ps.sort_order > v_step
         AND EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id AND b.created_at >= p_since)
         AND NOT EXISTS (SELECT 1 FROM public.cut_job_item c WHERE c.order_detail_id = od.detail_id AND c.is_active)
      ON CONFLICT DO NOTHING
      RETURNING detail_id, round_no
    )
    SELECT jsonb_agg(jsonb_build_object('detailId', detail_id, 'roundNo', round_no) ORDER BY detail_id) INTO v_routes FROM restored;
    IF v_rows IS NULL AND v_routes IS NULL THEN
      CONTINUE;
    END IF;
    v_changed := v_changed + COALESCE(jsonb_array_length(v_rows), 0) + COALESCE(jsonb_array_length(v_routes), 0);
    UPDATE public.orders SET version = version + 1 WHERE order_id = v_order RETURNING client_id, version INTO v_client, v_version;
    INSERT INTO public.audit_log (created_at, event, entity_type, entity_id, username, request_id, related_order_id,
                                  related_client_id, status_field, metadata_json, source)
    VALUES (clock_timestamp(), 'orders.detail_production_status_auto_change', 'order', v_order::text, 'system',
            p_request_id, v_order, v_client, 'productionDetailStatus',
            jsonb_build_object('cause', 'saw_reconcile', 'transitions', COALESCE(v_rows, '[]'::jsonb),
                               'restoredRoutes', COALESCE(v_routes, '[]'::jsonb), 'orderVersion', v_version,
                               'since', p_since, 'requestId', p_request_id), 'saw_reconcile')
    RETURNING audit_id INTO v_audit;
    INSERT INTO public.audit_log_related_entity (audit_id, entity_type, entity_id)
    SELECT v_audit, 'order_detail', (x->>'detailId')::bigint
      FROM jsonb_array_elements(COALESCE(v_rows, '[]'::jsonb) || COALESCE(v_routes, '[]'::jsonb)) x
    ON CONFLICT DO NOTHING;
    -- The same event as the «Базис раскрой» sync (syncSawStatusForDetails), idempotent per run and order.
    INSERT INTO public.outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
    VALUES ('order.detail_production_status_auto_changed', 'order', v_order::text,
            jsonb_build_object('eventType', 'order.detail_production_status_auto_changed', 'orderId', v_order,
              'cause', 'saw_reconcile', 'transitions', COALESCE(v_rows, '[]'::jsonb),
              'restoredRoutes', COALESCE(v_routes, '[]'::jsonb), 'orderVersion', v_version,
              'requestId', p_request_id, 'auditId', v_audit),
            'saw-reconcile:' || p_request_id || ':' || v_order)
    ON CONFLICT (idempotency_key) DO NOTHING;
  END LOOP;
  RETURN v_changed;
END $$;

COMMIT;
