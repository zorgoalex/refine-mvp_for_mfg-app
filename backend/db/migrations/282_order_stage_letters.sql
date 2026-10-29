-- Буквы этапов заказа: «все живые детали прошли этап» + ручная правка до следующего изменения автоматики;
-- новый производственный статус «Базис» (код saw, буква «Б») — пильный центр, на одном шаге с «Отрисован».
-- План: spec_erp/plans/production-stages/2026-10-28-stage-letters-all-details-plan.md (v9, GPT-6 R9 APPROVED).
--
-- Буквы вычисляются из текущих деталей; материализуется только авто-значение этапа (order_stage_auto_state, seq —
-- счётчик его изменений, непрерывный между кругами) и явная ручная правка (order_stage_letter_overrides: действует,
-- пока seq не изменился). Отметки production_status_events и триггеры 266/274/275 не меняются (журнал этапов);
-- у заказов без живых деталей буквы по-прежнему — отметки текущего круга.
--
-- Повторный запуск — no-op: IF NOT EXISTS / ON CONFLICT / CREATE OR REPLACE; backfill — только отсутствующие строки.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Справочник: «Базис» на шаге «Отрисован» (тот же sort_order). Флаг процедуры справочника — для защиты ниже.
SELECT set_config('erp.stage_reference_recompute', 'on', true);
INSERT INTO public.production_statuses (production_status_name, production_status_code, sort_order, color, description, is_active)
SELECT 'Базис', 'saw', drawn.sort_order, '#8D6E63', 'Деталь в карточке файла станка «Базис раскрой» (пильный центр)', true
  FROM public.production_statuses drawn
 WHERE drawn.production_status_code = 'drawn'
ON CONFLICT (production_status_code) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.production_statuses WHERE production_status_code = 'saw') THEN
    RAISE EXCEPTION 'STOP 282: нет статуса drawn — некуда поставить «Базис»';
  END IF;
END $$;

-- Пройденный маршрут «Базис» детали в её круге (нет строки — вариант ЧПУ).
CREATE TABLE IF NOT EXISTS public.order_detail_stage_routes (
  detail_id bigint NOT NULL REFERENCES public.order_details(detail_id) ON DELETE CASCADE,
  round_no smallint NOT NULL,
  variant text NOT NULL DEFAULT 'saw' CHECK (variant = 'saw'),
  set_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id text,
  PRIMARY KEY (detail_id, round_no)
);

-- Последнее вычисленное авто-значение этапа заказа; seq растёт при каждом изменении passed.
CREATE TABLE IF NOT EXISTS public.order_stage_auto_state (
  order_id bigint NOT NULL REFERENCES public.orders(order_id) ON DELETE CASCADE,
  production_status_id smallint NOT NULL REFERENCES public.production_statuses(production_status_id),
  passed boolean NOT NULL,
  seq bigint NOT NULL DEFAULT 1,
  round_no_at_calc smallint,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (order_id, production_status_id)
);

-- Ручная правка буквы: действует, пока auto_seq_at_set = order_stage_auto_state.seq.
CREATE TABLE IF NOT EXISTS public.order_stage_letter_overrides (
  order_id bigint NOT NULL REFERENCES public.orders(order_id) ON DELETE CASCADE,
  production_status_id smallint NOT NULL REFERENCES public.production_statuses(production_status_id),
  shown boolean NOT NULL,
  auto_seq_at_set bigint NOT NULL,
  set_by bigint,
  set_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id text,
  round_no_at_set smallint,
  PRIMARY KEY (order_id, production_status_id)
);

-- Монотонная ревизия эффективных букв заказа (ключ идемпотентности событий); не удаляется.
CREATE TABLE IF NOT EXISTS public.order_stage_letters_rev (
  order_id bigint PRIMARY KEY REFERENCES public.orders(order_id) ON DELETE CASCADE,
  rev bigint NOT NULL DEFAULT 0,
  -- the last recorded effective letters {shown, manual}: the «before» of the next change (a recompute runs after the
  -- statement, when the source of the letters may already have changed — details → none)
  last_snapshot jsonb
);
ALTER TABLE public.order_stage_letters_rev ADD COLUMN IF NOT EXISTS last_snapshot jsonb;

-- Авто-значения этапов заказа по его живым деталям (собственный круг детали — для маршрута).
-- Нет живых деталей или заказ не производственный — строк нет.
CREATE OR REPLACE FUNCTION public.order_stage_auto_values(p_order_id bigint)
RETURNS TABLE (production_status_id smallint, passed boolean)
LANGUAGE sql STABLE AS $$
  WITH ord AS (
    SELECT o.order_id FROM public.orders o WHERE o.order_id = p_order_id AND o.order_kind = 'production_order'
  ), d AS (
    SELECT ps.sort_order, ps.production_status_code AS code,
           (ps.production_status_code = 'saw' OR EXISTS (
              SELECT 1 FROM public.order_detail_stage_routes r
               WHERE r.detail_id = od.detail_id AND r.round_no = od.production_round)) AS saw_route
      FROM public.order_details od
      JOIN ord ON ord.order_id = od.order_id
      LEFT JOIN public.production_statuses ps ON ps.production_status_id = od.production_status_id AND ps.is_active
     WHERE NOT COALESCE(od.delete_flag, false)
  ), a AS (
    SELECT count(*) AS n, count(sort_order) AS n_status, min(sort_order) AS min_sort,
           COALESCE(bool_and(code = 'film_purchase'), false) AS all_film,
           COALESCE(bool_or(saw_route), false) AS any_saw,
           COALESCE(bool_or(NOT saw_route), false) AS any_cnc
      FROM d
  ), h AS (
    SELECT count(*) AS n, COALESCE(bool_and(COALESCE(ps.production_status_code = 'hdf', false)), false) AS all_hdf
      FROM public.order_hdf_details hd
      JOIN ord ON ord.order_id = hd.order_id
      LEFT JOIN public.production_statuses ps ON ps.production_status_id = hd.production_status_id
     WHERE NOT COALESCE(hd.delete_flag, false) AND hd.hdf_enabled
  ), step AS (
    SELECT sort_order FROM public.production_statuses WHERE production_status_code = 'drawn'
  )
  SELECT s.production_status_id,
         CASE
           WHEN s.production_status_code = 'film_purchase' THEN a.n_status = a.n AND a.all_film
           WHEN s.production_status_code = 'hdf' THEN h.n > 0 AND h.all_hdf
           WHEN s.production_status_code = 'drawn' THEN a.n_status = a.n AND a.min_sort >= (SELECT sort_order FROM step) AND a.any_cnc
           WHEN s.production_status_code = 'saw' THEN a.n_status = a.n AND a.min_sort >= (SELECT sort_order FROM step) AND a.any_saw
           ELSE a.n_status = a.n AND a.min_sort >= s.sort_order
         END
    FROM public.production_statuses s, a, h
   WHERE s.is_active AND s.production_status_code <> 'new' AND a.n > 0
$$;

-- Эффективные буквы заказа: с живыми деталями — авто-значение или действующая ручная правка; без деталей — отметки
-- текущего круга (как до 282). manual — вручную поставленная буква (показывается другим цветом).
-- shown/manual — the real letter state (the stage menu, the manual command, the audit); visible/visible_manual — what
-- cards and the digest show (a finished order: only its last letter).
DROP FUNCTION IF EXISTS public.order_stage_letter_codes(bigint[]);
DROP FUNCTION IF EXISTS public.order_stage_letters_snapshot(bigint);
DROP FUNCTION IF EXISTS public.order_stage_letters_effective(bigint);
CREATE OR REPLACE FUNCTION public.order_stage_letters_effective(p_order_id bigint)
RETURNS TABLE (production_status_id smallint, code text, sort_order integer, shown boolean, manual boolean,
               visible boolean, visible_manual boolean)
LANGUAGE sql STABLE AS $$
  WITH has_details AS (
    SELECT EXISTS (SELECT 1 FROM public.order_details od WHERE od.order_id = p_order_id AND NOT COALESCE(od.delete_flag, false)) AS v
  ), base AS (
    SELECT st.production_status_id, ps.production_status_code::text AS code, ps.sort_order::integer AS sort_order,
           CASE WHEN ov.order_id IS NOT NULL THEN ov.shown ELSE st.passed END AS shown,
           ov.order_id IS NOT NULL AND ov.shown AS manual,
           st.passed AS auto
      FROM public.order_stage_auto_state st
      JOIN public.production_statuses ps ON ps.production_status_id = st.production_status_id AND ps.is_active
      LEFT JOIN public.order_stage_letter_overrides ov
        ON ov.order_id = st.order_id AND ov.production_status_id = st.production_status_id AND ov.auto_seq_at_set = st.seq
     WHERE st.order_id = p_order_id AND (SELECT v FROM has_details)
    UNION ALL
    SELECT DISTINCT e.production_status_id, ps.production_status_code::text, ps.sort_order::integer, true, false, false
      FROM public.production_status_events e
      JOIN public.orders o ON o.order_id = e.order_id
      JOIN public.production_statuses ps ON ps.production_status_id = e.production_status_id AND ps.is_active
     WHERE e.order_id = p_order_id AND e.detail_id IS NULL AND e.round_no = o.production_round
       AND NOT (SELECT v FROM has_details)
  ), fin AS (
    -- A finished order (every live detail passed «Выдан», by the details — not by a manual letter) shows only its last
    -- letter (user decision 28.10).
    SELECT COALESCE(bool_or(code = 'issued' AND auto), false) AS done,
           max(sort_order) FILTER (WHERE shown) AS top
      FROM base
  )
  SELECT b.production_status_id, b.code, b.sort_order, b.shown, b.manual,
         CASE WHEN fin.done THEN b.shown AND b.sort_order = fin.top ELSE b.shown END,
         CASE WHEN fin.done THEN b.manual AND b.sort_order = fin.top ELSE b.manual END
    FROM base b, fin
$$;

-- Снимок эффективных букв: {shown:[codes], manual:[codes]} в порядке этапов.
CREATE OR REPLACE FUNCTION public.order_stage_letters_snapshot(p_order_id bigint)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'shown', COALESCE(jsonb_agg(code ORDER BY sort_order, production_status_id) FILTER (WHERE shown), '[]'::jsonb),
    'manual', COALESCE(jsonb_agg(code ORDER BY sort_order, production_status_id) FILTER (WHERE manual), '[]'::jsonb))
    FROM public.order_stage_letters_effective(p_order_id)
$$;

-- Событие изменения эффективных букв (аудит + outbox, идемпотентно по ревизии заказа).
DROP FUNCTION IF EXISTS public.record_order_stage_letters_change(bigint, jsonb, jsonb, text, smallint[], bigint, text, text);
CREATE OR REPLACE FUNCTION public.record_order_stage_letters_change(
  p_order_id bigint, p_after jsonb, p_cause text,
  p_actor_user_id bigint, p_actor_username text, p_request_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_before jsonb;
  v_rev bigint;
  v_client_id bigint;
  v_round smallint;
  v_audit_id uuid;
  v_changed smallint[];
  v_http_request_id text := NULLIF(current_setting('erp.request_id', true), '');
  v_request_id text := COALESCE(p_request_id, v_http_request_id, 'stage-letters:' || txid_current()::text);
BEGIN
  INSERT INTO public.order_stage_letters_rev (order_id, rev, last_snapshot)
  VALUES (p_order_id, 0, '{"shown": [], "manual": []}'::jsonb)
  ON CONFLICT (order_id) DO NOTHING;
  SELECT COALESCE(last_snapshot, '{"shown": [], "manual": []}'::jsonb) INTO v_before
    FROM public.order_stage_letters_rev WHERE order_id = p_order_id FOR UPDATE;
  IF v_before = p_after THEN
    RETURN;
  END IF;
  -- The stages whose letter or manual mark changed (normalized dimensions of the audit row).
  SELECT array_agg(ps.production_status_id ORDER BY ps.production_status_id) INTO v_changed
    FROM public.production_statuses ps
   WHERE ((v_before->'shown') ? ps.production_status_code::text) IS DISTINCT FROM ((p_after->'shown') ? ps.production_status_code::text)
      OR ((v_before->'manual') ? ps.production_status_code::text) IS DISTINCT FROM ((p_after->'manual') ? ps.production_status_code::text);
  UPDATE public.order_stage_letters_rev SET rev = rev + 1, last_snapshot = p_after
   WHERE order_id = p_order_id RETURNING rev INTO v_rev;
  SELECT client_id, production_round INTO v_client_id, v_round FROM public.orders WHERE order_id = p_order_id;

  INSERT INTO public.audit_log (
    created_at, event, entity_type, entity_id, user_id, username, request_id,
    before_json, after_json, diff_json, metadata_json, source,
    related_order_id, related_client_id, status_field
  ) VALUES (
    clock_timestamp(), 'production_stage_letters.changed', 'order', p_order_id::text, p_actor_user_id,
    COALESCE(p_actor_username, 'system'), v_request_id,
    v_before, p_after,
    jsonb_build_object('shown', jsonb_build_object('before', v_before->'shown', 'after', p_after->'shown'),
                       'manual', jsonb_build_object('before', v_before->'manual', 'after', p_after->'manual')),
    jsonb_build_object('cause', p_cause, 'orderId', p_order_id, 'clientId', v_client_id, 'roundNo', v_round,
                       'rev', v_rev, 'changedStatusIds', to_jsonb(COALESCE(v_changed, '{}')),
                       'causationRequestId', v_http_request_id, 'transactionId', txid_current()),
    CASE WHEN p_cause = 'manual' THEN 'backend-production-command' ELSE 'stage_letters_trigger' END,
    p_order_id, v_client_id, 'productionStageLetters'
  )
  RETURNING audit_id INTO v_audit_id;

  INSERT INTO public.audit_log_related_entity (audit_id, entity_type, entity_id)
  SELECT v_audit_id, 'production_status', s FROM unnest(COALESCE(v_changed, '{}')) s
  ON CONFLICT DO NOTHING;

  INSERT INTO public.outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
  VALUES ('order.stage_letters_changed', 'order', p_order_id::text,
    jsonb_build_object('eventType', 'order.stage_letters_changed', 'orderId', p_order_id, 'clientId', v_client_id,
      'roundNo', v_round, 'rev', v_rev, 'cause', p_cause, 'before', v_before, 'after', p_after,
      'changedStatusIds', to_jsonb(COALESCE(v_changed, '{}')), 'actorUserId', p_actor_user_id,
      'requestId', v_request_id, 'auditId', v_audit_id),
    'stage-letters:' || p_order_id || ':' || v_rev)
  ON CONFLICT DO NOTHING;
END $$;

-- Пересчёт авто-значений заказов (по возрастанию id, заказ FOR NO KEY UPDATE — как 266): изменившийся этап —
-- seq+1 и удаление его ручной правки; затем событие, если эффективные буквы изменились.
CREATE OR REPLACE FUNCTION public.refresh_order_stage_letters(p_order_ids bigint[], p_cause text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_order bigint;
  v_kind text;
  v_round smallint;
  v_changed smallint[];
BEGIN
  FOR v_order IN SELECT DISTINCT x FROM unnest(p_order_ids) x WHERE x IS NOT NULL ORDER BY x LOOP
    SELECT order_kind, production_round INTO v_kind, v_round FROM public.orders WHERE order_id = v_order FOR NO KEY UPDATE;
    IF NOT FOUND OR v_kind IS DISTINCT FROM 'production_order' THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.order_details WHERE order_id = v_order AND NOT COALESCE(delete_flag, false)) THEN
      -- No live details: no automatic values. A stage that was passed changes (seq+1), and every manual override ends —
      -- details added later start from the automation, never from an old override.
      UPDATE public.order_stage_auto_state SET passed = false, seq = seq + 1, updated_at = clock_timestamp()
       WHERE order_id = v_order AND passed;
      DELETE FROM public.order_stage_letter_overrides WHERE order_id = v_order;
      PERFORM public.record_order_stage_letters_change(v_order, public.order_stage_letters_snapshot(v_order), p_cause,
        NULL, NULL, NULL);
      CONTINUE;
    END IF;

    WITH calc AS (
      SELECT * FROM public.order_stage_auto_values(v_order)
    ), upserted AS (
      INSERT INTO public.order_stage_auto_state AS st (order_id, production_status_id, passed, seq, round_no_at_calc)
      SELECT v_order, c.production_status_id, c.passed, 1, v_round FROM calc c
      ON CONFLICT (order_id, production_status_id) DO UPDATE
        SET passed = EXCLUDED.passed, seq = st.seq + 1, round_no_at_calc = EXCLUDED.round_no_at_calc,
            updated_at = clock_timestamp()
        WHERE st.passed IS DISTINCT FROM EXCLUDED.passed
      RETURNING st.production_status_id, st.seq
    )
    SELECT array_agg(production_status_id) INTO v_changed FROM upserted WHERE seq > 1;

    IF v_changed IS NOT NULL THEN
      DELETE FROM public.order_stage_letter_overrides
       WHERE order_id = v_order AND production_status_id = ANY (v_changed);
    END IF;

    PERFORM public.record_order_stage_letters_change(v_order, public.order_stage_letters_snapshot(v_order), p_cause,
      NULL, NULL, NULL);
  END LOOP;
END $$;

-- Ручная правка буквы (команда этапа). Под блокировкой заказа вызывающего: пересчёт, затем правка:
-- override {shown} с текущим seq; событие при изменении эффективных букв. Возвращает {shown, manual, autoPassed}.
CREATE OR REPLACE FUNCTION public.set_order_stage_letter_override(
  p_order_id bigint, p_status_id smallint, p_shown boolean, p_user_id bigint, p_username text, p_request_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_state record;
  v_round smallint;
  v_has_details boolean;
BEGIN
  PERFORM public.refresh_order_stage_letters(ARRAY[p_order_id], 'detail_status');
  SELECT production_round INTO v_round FROM public.orders WHERE order_id = p_order_id;
  v_has_details := EXISTS (SELECT 1 FROM public.order_details WHERE order_id = p_order_id AND NOT COALESCE(delete_flag, false));
  IF NOT v_has_details THEN
    -- Без деталей буквы — отметки этапа (их пишет команда); правка не нужна.
    RETURN jsonb_build_object('shown', p_shown, 'manual', false, 'autoPassed', NULL);
  END IF;
  SELECT passed, seq INTO v_state FROM public.order_stage_auto_state
   WHERE order_id = p_order_id AND production_status_id = p_status_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('shown', p_shown, 'manual', false, 'autoPassed', NULL);
  END IF;
  INSERT INTO public.order_stage_letter_overrides AS ov
    (order_id, production_status_id, shown, auto_seq_at_set, set_by, set_at, request_id, round_no_at_set)
  VALUES (p_order_id, p_status_id, p_shown, v_state.seq, p_user_id, clock_timestamp(), p_request_id, v_round)
  ON CONFLICT (order_id, production_status_id) DO UPDATE
    SET shown = EXCLUDED.shown, auto_seq_at_set = EXCLUDED.auto_seq_at_set, set_by = EXCLUDED.set_by,
        set_at = EXCLUDED.set_at, request_id = EXCLUDED.request_id, round_no_at_set = EXCLUDED.round_no_at_set;
  PERFORM public.record_order_stage_letters_change(p_order_id, public.order_stage_letters_snapshot(p_order_id), 'manual',
    p_user_id, p_username, p_request_id);
  RETURN jsonb_build_object('shown', p_shown, 'manual', p_shown, 'autoPassed', v_state.passed);
END $$;

-- Буквы набора заказов для проекций (список, карточка, сводка): коды в порядке этапов.
CREATE OR REPLACE FUNCTION public.order_stage_letter_codes(p_order_ids bigint[])
RETURNS TABLE (order_id bigint, codes text[], manual_codes text[], stage_codes text[])
LANGUAGE sql STABLE AS $$
  -- Set-based over the whole page (one evaluation for all orders, not one per row); the same rules as
  -- order_stage_letters_effective (kept in step by the integration test «set-based letters equal per-order letters»).
  WITH ids AS (
    SELECT DISTINCT x AS order_id FROM unnest(p_order_ids) x WHERE x IS NOT NULL
  ), hd AS (
    SELECT i.order_id,
           EXISTS (SELECT 1 FROM public.order_details od WHERE od.order_id = i.order_id AND NOT COALESCE(od.delete_flag, false)) AS has
      FROM ids i
  ), base AS (
    SELECT st.order_id, st.production_status_id, ps.production_status_code::text AS code, ps.sort_order::integer AS sort_order,
           CASE WHEN ov.order_id IS NOT NULL THEN ov.shown ELSE st.passed END AS shown,
           ov.order_id IS NOT NULL AND ov.shown AS manual,
           st.passed AS auto
      FROM hd
      JOIN public.order_stage_auto_state st ON st.order_id = hd.order_id
      JOIN public.production_statuses ps ON ps.production_status_id = st.production_status_id AND ps.is_active
      LEFT JOIN public.order_stage_letter_overrides ov
        ON ov.order_id = st.order_id AND ov.production_status_id = st.production_status_id AND ov.auto_seq_at_set = st.seq
     WHERE hd.has
    UNION ALL
    SELECT DISTINCT e.order_id, e.production_status_id, ps.production_status_code::text, ps.sort_order::integer, true, false, false
      FROM hd
      JOIN public.orders o ON o.order_id = hd.order_id
      JOIN public.production_status_events e ON e.order_id = hd.order_id AND e.detail_id IS NULL AND e.round_no = o.production_round
      JOIN public.production_statuses ps ON ps.production_status_id = e.production_status_id AND ps.is_active
     WHERE NOT hd.has
  ), fin AS (
    SELECT b.order_id, COALESCE(bool_or(b.code = 'issued' AND b.auto), false) AS done,
           max(b.sort_order) FILTER (WHERE b.shown) AS top
      FROM base b GROUP BY b.order_id
  ), eff AS (
    SELECT b.order_id, b.code, b.sort_order, b.production_status_id, b.shown, b.manual,
           CASE WHEN f.done THEN b.shown AND b.sort_order = f.top ELSE b.shown END AS visible,
           CASE WHEN f.done THEN b.manual AND b.sort_order = f.top ELSE b.manual END AS visible_manual
      FROM base b JOIN fin f ON f.order_id = b.order_id
  )
  SELECT i.order_id,
         COALESCE(array_agg(e.code ORDER BY e.sort_order, e.production_status_id) FILTER (WHERE e.visible), '{}'),
         COALESCE(array_agg(e.code ORDER BY e.sort_order, e.production_status_id) FILTER (WHERE e.visible_manual), '{}'),
         COALESCE(array_agg(e.code ORDER BY e.sort_order, e.production_status_id) FILTER (WHERE e.shown), '{}')
    FROM ids i
    LEFT JOIN eff e ON e.order_id = i.order_id
   GROUP BY i.order_id
$$;

-- Backfill — до создания триггеров пересчёта: без событий по заказам (решение §12.1).
-- Backfill маршрутов: детали, которые сейчас в карточках «Базис раскрой», — маршрут их круга (статусы не меняются).
INSERT INTO public.order_detail_stage_routes (detail_id, round_no, request_id)
SELECT DISTINCT od.detail_id, od.production_round, 'migration-282'
  FROM public.bazis_cut_set_details bsd
  JOIN public.order_details od ON od.detail_id = bsd.source_order_detail_id
 WHERE NOT COALESCE(od.delete_flag, false)
ON CONFLICT DO NOTHING;

-- Backfill авто-состояния (seq = 1, без правок — решение пользователя §12.1); без аудита по заказам и без outbox.
INSERT INTO public.order_stage_auto_state (order_id, production_status_id, passed, seq, round_no_at_calc)
SELECT o.order_id, v.production_status_id, v.passed, 1, o.production_round
  FROM public.orders o
  CROSS JOIN LATERAL public.order_stage_auto_values(o.order_id) v
 WHERE o.order_kind = 'production_order'
ON CONFLICT (order_id, production_status_id) DO NOTHING;

-- The recorded letters of every production order (the «before» of its next change); rev stays 0 — no events.
INSERT INTO public.order_stage_letters_rev (order_id, rev, last_snapshot)
SELECT o.order_id, 0, public.order_stage_letters_snapshot(o.order_id)
  FROM public.orders o
 WHERE o.order_kind = 'production_order'
ON CONFLICT (order_id) DO NOTHING;

-- Маршрут «Базис»: любой вход детали в saw пишет маршрут её круга; saw→new в том же круге удаляет его.
-- Snapshot-импорт (historical_import) — владелец маршрутов своих деталей: здесь молчим.
CREATE OR REPLACE FUNCTION public.trg_order_detail_saw_route()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_saw smallint;
  v_new smallint;
BEGIN
  IF current_setting('erp.pse_writer', true) = 'historical_import' THEN
    RETURN NULL;
  END IF;
  SELECT production_status_id INTO v_saw FROM public.production_statuses WHERE production_status_code = 'saw';
  SELECT production_status_id INTO v_new FROM public.production_statuses WHERE production_status_code = 'new';
  IF NEW.production_status_id = v_saw THEN
    INSERT INTO public.order_detail_stage_routes (detail_id, round_no, request_id)
    VALUES (NEW.detail_id, NEW.production_round, NULLIF(current_setting('erp.request_id', true), ''))
    ON CONFLICT DO NOTHING;
  ELSIF TG_OP = 'UPDATE' AND OLD.production_status_id = v_saw AND NEW.production_status_id = v_new
        AND OLD.production_round = NEW.production_round THEN
    DELETE FROM public.order_detail_stage_routes WHERE detail_id = NEW.detail_id AND round_no = NEW.production_round;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_od_saw_route ON public.order_details;
CREATE TRIGGER trg_od_saw_route
  AFTER INSERT OR UPDATE OF production_status_id, production_round ON public.order_details
  FOR EACH ROW EXECUTE FUNCTION public.trg_order_detail_saw_route();

-- Пересчёт букв после операторов над входами расчёта (после триггеров 266 — имена zz_).
CREATE OR REPLACE FUNCTION public.trg_stage_letters_refresh()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_orders bigint[];
BEGIN
  IF TG_TABLE_NAME = 'order_details' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT array_agg(DISTINCT order_id) INTO v_orders FROM new_rows;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT array_agg(DISTINCT order_id) INTO v_orders FROM old_rows;
    ELSE
      SELECT array_agg(DISTINCT x) INTO v_orders FROM (
        SELECT o.order_id AS x FROM old_rows o JOIN new_rows n USING (detail_id)
         WHERE o.production_status_id IS DISTINCT FROM n.production_status_id
            OR COALESCE(o.delete_flag, false) IS DISTINCT FROM COALESCE(n.delete_flag, false)
            OR o.order_id IS DISTINCT FROM n.order_id
            OR o.production_round IS DISTINCT FROM n.production_round
        UNION
        SELECT n.order_id FROM old_rows o JOIN new_rows n USING (detail_id)
         WHERE o.production_status_id IS DISTINCT FROM n.production_status_id
            OR COALESCE(o.delete_flag, false) IS DISTINCT FROM COALESCE(n.delete_flag, false)
            OR o.order_id IS DISTINCT FROM n.order_id
            OR o.production_round IS DISTINCT FROM n.production_round) t;
    END IF;
  ELSIF TG_TABLE_NAME = 'order_hdf_details' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT array_agg(DISTINCT order_id) INTO v_orders FROM new_rows;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT array_agg(DISTINCT order_id) INTO v_orders FROM old_rows;
    ELSE
      SELECT array_agg(DISTINCT x) INTO v_orders FROM (
        SELECT o.order_id AS x FROM old_rows o JOIN new_rows n USING (order_hdf_detail_id)
         WHERE o.production_status_id IS DISTINCT FROM n.production_status_id
            OR COALESCE(o.delete_flag, false) IS DISTINCT FROM COALESCE(n.delete_flag, false)
            OR o.order_id IS DISTINCT FROM n.order_id
            OR o.hdf_enabled IS DISTINCT FROM n.hdf_enabled
        UNION
        SELECT n.order_id FROM old_rows o JOIN new_rows n USING (order_hdf_detail_id)
         WHERE o.production_status_id IS DISTINCT FROM n.production_status_id
            OR COALESCE(o.delete_flag, false) IS DISTINCT FROM COALESCE(n.delete_flag, false)
            OR o.order_id IS DISTINCT FROM n.order_id
            OR o.hdf_enabled IS DISTINCT FROM n.hdf_enabled) t;
    END IF;
  ELSIF TG_TABLE_NAME = 'order_detail_stage_routes' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT array_agg(DISTINCT od.order_id) INTO v_orders FROM new_rows r JOIN public.order_details od ON od.detail_id = r.detail_id;
    ELSE
      SELECT array_agg(DISTINCT od.order_id) INTO v_orders FROM old_rows r JOIN public.order_details od ON od.detail_id = r.detail_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'orders' THEN
    SELECT array_agg(DISTINCT n.order_id) INTO v_orders FROM old_rows o JOIN new_rows n USING (order_id)
     WHERE o.production_round IS DISTINCT FROM n.production_round
        OR COALESCE(o.delete_flag, false) IS DISTINCT FROM COALESCE(n.delete_flag, false);
  END IF;
  IF v_orders IS NOT NULL THEN
    PERFORM public.refresh_order_stage_letters(v_orders, CASE TG_TABLE_NAME WHEN 'order_detail_stage_routes' THEN 'route'
      WHEN 'orders' THEN 'order' ELSE 'detail_status' END);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_od_zz_stage_letters_insert ON public.order_details;
DROP TRIGGER IF EXISTS trg_od_zz_stage_letters_update ON public.order_details;
DROP TRIGGER IF EXISTS trg_od_zz_stage_letters_delete ON public.order_details;
CREATE TRIGGER trg_od_zz_stage_letters_insert AFTER INSERT ON public.order_details
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.trg_stage_letters_refresh();
CREATE TRIGGER trg_od_zz_stage_letters_update AFTER UPDATE ON public.order_details
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.trg_stage_letters_refresh();
CREATE TRIGGER trg_od_zz_stage_letters_delete AFTER DELETE ON public.order_details
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.trg_stage_letters_refresh();

DROP TRIGGER IF EXISTS trg_ohd_zz_stage_letters_insert ON public.order_hdf_details;
DROP TRIGGER IF EXISTS trg_ohd_zz_stage_letters_update ON public.order_hdf_details;
DROP TRIGGER IF EXISTS trg_ohd_zz_stage_letters_delete ON public.order_hdf_details;
CREATE TRIGGER trg_ohd_zz_stage_letters_insert AFTER INSERT ON public.order_hdf_details
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.trg_stage_letters_refresh();
CREATE TRIGGER trg_ohd_zz_stage_letters_update AFTER UPDATE ON public.order_hdf_details
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.trg_stage_letters_refresh();
CREATE TRIGGER trg_ohd_zz_stage_letters_delete AFTER DELETE ON public.order_hdf_details
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.trg_stage_letters_refresh();

DROP TRIGGER IF EXISTS trg_odsr_stage_letters_insert ON public.order_detail_stage_routes;
DROP TRIGGER IF EXISTS trg_odsr_stage_letters_delete ON public.order_detail_stage_routes;
CREATE TRIGGER trg_odsr_stage_letters_insert AFTER INSERT ON public.order_detail_stage_routes
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.trg_stage_letters_refresh();
CREATE TRIGGER trg_odsr_stage_letters_delete AFTER DELETE ON public.order_detail_stage_routes
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.trg_stage_letters_refresh();

DROP TRIGGER IF EXISTS trg_orders_zz_stage_letters ON public.orders;
CREATE TRIGGER trg_orders_zz_stage_letters AFTER UPDATE ON public.orders
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.trg_stage_letters_refresh();

-- Справочник производственных статусов: порядок, активность, создание активного, удаление и служебные коды — только
-- служебной процедурой (флаг erp.stage_reference_recompute в той же транзакции + пересчёт всех заказов).
CREATE OR REPLACE FUNCTION public.trg_production_statuses_stage_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_semantic text[] := ARRAY['new', 'drawn', 'saw', 'film_purchase', 'hdf', 'issued'];
BEGIN
  IF current_setting('erp.stage_reference_recompute', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' AND NEW.is_active THEN
    RAISE EXCEPTION 'PRODUCTION_STAGE_REFERENCE_PROCEDURE: активный производственный статус создаётся служебной процедурой'
      USING ERRCODE = 'P0001';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PRODUCTION_STAGE_REFERENCE_PROCEDURE: производственный статус удаляется служебной процедурой'
      USING ERRCODE = 'P0001';
  ELSIF TG_OP = 'UPDATE' AND (NEW.sort_order IS DISTINCT FROM OLD.sort_order OR NEW.is_active IS DISTINCT FROM OLD.is_active
        OR (NEW.production_status_code IS DISTINCT FROM OLD.production_status_code
            AND (OLD.production_status_code = ANY (v_semantic) OR NEW.production_status_code = ANY (v_semantic)))) THEN
    RAISE EXCEPTION 'PRODUCTION_STAGE_REFERENCE_PROCEDURE: порядок, активность и служебный код этапа меняются служебной процедурой'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_production_statuses_stage_guard ON public.production_statuses;
CREATE TRIGGER trg_production_statuses_stage_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.production_statuses
  FOR EACH ROW EXECUTE FUNCTION public.trg_production_statuses_stage_guard();

-- Служебная процедура: пересчёт всех производственных заказов с деталями (после изменения справочника в той же
-- транзакции, в окне с остановкой backend; runbook в плане §12.3).
CREATE OR REPLACE FUNCTION public.recompute_all_order_stage_letters()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_ids bigint[];
BEGIN
  IF current_setting('erp.stage_reference_recompute', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'PRODUCTION_STAGE_REFERENCE_PROCEDURE: только внутри служебной процедуры справочника';
  END IF;
  SELECT array_agg(o.order_id ORDER BY o.order_id) INTO v_ids FROM public.orders o
   WHERE o.order_kind = 'production_order'
     AND EXISTS (SELECT 1 FROM public.order_details od WHERE od.order_id = o.order_id AND NOT COALESCE(od.delete_flag, false));
  PERFORM public.refresh_order_stage_letters(COALESCE(v_ids, '{}'), 'reference');
  RETURN COALESCE(cardinality(v_ids), 0);
END $$;

INSERT INTO public.audit_log (created_at, event, entity_type, entity_id, username, request_id, after_json, metadata_json, source)
SELECT clock_timestamp(), 'production_stage_letters.backfilled', 'migration', '282', 'system', 'migration-282',
       jsonb_build_object('autoStateRows', (SELECT count(*) FROM public.order_stage_auto_state),
                          'orders', (SELECT count(DISTINCT order_id) FROM public.order_stage_auto_state),
                          'routes', (SELECT count(*) FROM public.order_detail_stage_routes)),
       jsonb_build_object('plan', 'stage-letters-all-details v9'), 'migration'
 WHERE NOT EXISTS (SELECT 1 FROM public.audit_log WHERE event = 'production_stage_letters.backfilled' AND entity_id = '282');

COMMIT;
