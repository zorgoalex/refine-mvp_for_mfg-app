-- Статус «Базис» (миграция 282) в работе ЧПУ и откате:
-- 1) сохранённая настройка «готовые к раскрою статусы» (cut_settings 'eligibility.statuses', миграция 023) получает
--    код saw рядом с drawn, если drawn в ней есть и saw ещё нет (пользовательские коды сохраняются): деталь «Базис» можно
--    добавить в задание ЧПУ — с предупреждением, как задумано (план §10.4);
-- 2) reconcile_saw_detail_statuses() — сверка статуса «Базис» с составом карточек «Базис раскрой» после работы прежнего
--    backend (откат): «Базис»-деталь ни в одной карточке → «Новый»; «Новая» деталь, попавшая в карточку ПОСЛЕ p_since
--    (начало отката) и не в задании ЧПУ → «Базис». Карточки, существовавшие до 282, не переводятся (решение пользователя
--    о массовом переводе — отдельно). Заказы — по возрастанию id FOR UPDATE, затем детали; аудит по заказу (system).
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
  v_orders bigint[];
  v_changed integer := 0;
  v_order bigint;
  v_rows jsonb;
BEGIN
  SELECT production_status_id INTO v_saw FROM public.production_statuses WHERE production_status_code = 'saw';
  SELECT production_status_id INTO v_new FROM public.production_statuses WHERE production_status_code = 'new';
  IF v_saw IS NULL OR v_new IS NULL THEN
    RETURN 0;
  END IF;
  SELECT array_agg(DISTINCT od.order_id ORDER BY od.order_id) INTO v_orders
    FROM public.order_details od
   WHERE NOT COALESCE(od.delete_flag, false)
     AND ((od.production_status_id = v_saw
           AND NOT EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id))
       OR (od.production_status_id = v_new
           AND p_since IS NOT NULL
           AND EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id AND b.created_at >= p_since)
           AND NOT EXISTS (SELECT 1 FROM public.cut_job_item c WHERE c.order_detail_id = od.detail_id AND c.is_active)));
  IF v_orders IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM 1 FROM public.orders WHERE order_id = ANY (v_orders) ORDER BY order_id FOR UPDATE;
  FOREACH v_order IN ARRAY v_orders LOOP
    WITH targets AS (
      SELECT od.detail_id,
             CASE WHEN od.production_status_id = v_saw THEN v_new ELSE v_saw END AS to_status,
             od.production_status_id AS from_status
        FROM public.order_details od
       WHERE od.order_id = v_order AND NOT COALESCE(od.delete_flag, false)
         AND ((od.production_status_id = v_saw
               AND NOT EXISTS (SELECT 1 FROM public.bazis_cut_set_details b WHERE b.source_order_detail_id = od.detail_id))
           OR (od.production_status_id = v_new
               AND p_since IS NOT NULL
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
    IF v_rows IS NOT NULL THEN
      v_changed := v_changed + jsonb_array_length(v_rows);
      UPDATE public.orders SET version = version + 1 WHERE order_id = v_order;
      INSERT INTO public.audit_log (created_at, event, entity_type, entity_id, username, request_id, related_order_id,
                                    status_field, metadata_json, source)
      VALUES (clock_timestamp(), 'orders.detail_production_status_auto_change', 'order', v_order::text, 'system',
              p_request_id, v_order, 'productionDetailStatus',
              jsonb_build_object('cause', 'saw_reconcile', 'transitions', v_rows), 'saw_reconcile');
    END IF;
  END LOOP;
  RETURN v_changed;
END $$;

COMMIT;
