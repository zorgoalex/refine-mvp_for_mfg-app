-- «Присадка» → «Базис-проект»: карточка Базис-проекта = строка doweling_orders (+ клиент),
-- XML-проект Базиса ссылается на карточку. План: spec_erp/plans/bazis-doweling-merge (v8, GPT-6 R8 APPROVED).
--
-- Инвариант: клиент карточки = клиент каждого её активного живого заказа = клиент группы каждого прикреплённого
-- XML-проекта. Карточки client_source = 'default' (их создаёт только прежний backend, не передающий клиента)
-- инвариантом не охватываются, пока клиента не уточнят.
--
-- Повторный запуск — no-op: колонки IF NOT EXISTS, backfill трогает только client_id IS NULL и
-- bazis_projects.doweling_order_id IS NULL, функции/триггеры/представления пересоздаются.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------- схема

ALTER TABLE public.doweling_orders
  ADD COLUMN IF NOT EXISTS client_id bigint REFERENCES public.clients(client_id),
  ADD COLUMN IF NOT EXISTS client_source text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_doweling_orders_client_source') THEN
    ALTER TABLE public.doweling_orders
      ADD CONSTRAINT chk_doweling_orders_client_source
      CHECK (client_source IN ('manual', 'order', 'default', 'migration'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_doweling_orders_client_id ON public.doweling_orders (client_id);

ALTER TABLE public.bazis_projects
  ADD COLUMN IF NOT EXISTS doweling_order_id bigint
    REFERENCES public.doweling_orders(doweling_order_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bazis_projects_doweling_order_id
  ON public.bazis_projects (doweling_order_id) WHERE doweling_order_id IS NOT NULL;

COMMENT ON COLUMN public.doweling_orders.client_id IS
  'Клиент Базис-проекта (карточки). Равен клиенту всех активных живых заказов и групп прикреплённых XML-проектов';
COMMENT ON COLUMN public.doweling_orders.client_source IS
  'Откуда клиент: manual — задан пользователем, order — по заказу, migration — перенос 279, default — '
  'подставлен триггером для записи прежнего backend (вне инварианта до уточнения)';
COMMENT ON COLUMN public.bazis_projects.doweling_order_id IS
  'Карточка Базис-проекта, к которой прикреплён XML-проект';

-- Клиент «нд» — для карточек без заказа. Ровно один активный, иначе ошибка.
CREATE OR REPLACE FUNCTION public.bazis_nd_client_id()
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_ids bigint[];
BEGIN
  SELECT array_agg(client_id ORDER BY client_id) INTO v_ids
  FROM public.clients
  WHERE lower(btrim(client_name)) = 'нд' AND is_active;
  IF coalesce(array_length(v_ids, 1), 0) <> 1 THEN
    RAISE EXCEPTION 'Клиент «нд» должен быть ровно один активный, найдено: %', coalesce(array_length(v_ids, 1), 0)
      USING ERRCODE = 'P0001';
  END IF;
  RETURN v_ids[1];
END;
$$;

-- ---------------------------------------------------------------- backfill: клиент карточки

-- Клиенты активных связей карточки: по живым заказам и (если живых нет) по удалённым.
DROP TABLE IF EXISTS tmp_card_clients;
CREATE TEMP TABLE tmp_card_clients ON COMMIT DROP AS
SELECT d.doweling_order_id,
       array_agg(DISTINCT o.client_id) FILTER (WHERE NOT o.delete_flag) AS live_clients,
       array_agg(DISTINCT o.client_id) FILTER (WHERE o.delete_flag) AS dead_clients
FROM public.doweling_orders d
LEFT JOIN public.order_doweling_links l
       ON l.doweling_order_id = d.doweling_order_id AND NOT l.delete_flag
LEFT JOIN public.orders o ON o.order_id = l.order_id
WHERE d.client_id IS NULL
GROUP BY d.doweling_order_id;

-- Решение пользователя 27.10: «1289» (заказы 2269 и 2290 разных клиентов) — клиент заказа 2269,
-- связь с 2290 снимается. Применяется, только если картина ровно такая.
DROP TABLE IF EXISTS tmp_split_resolution;
CREATE TEMP TABLE tmp_split_resolution ON COMMIT DROP AS
SELECT d.doweling_order_id, keep.order_id AS keep_order_id, keep.client_id AS keep_client_id,
       drop_l.order_doweling_link_id AS drop_link_id, drop_l.order_id AS drop_order_id
FROM public.doweling_orders d
JOIN public.order_doweling_links keep_l ON keep_l.doweling_order_id = d.doweling_order_id AND NOT keep_l.delete_flag
JOIN public.orders keep ON keep.order_id = keep_l.order_id AND NOT keep.delete_flag AND keep.order_name = '2269'
JOIN public.order_doweling_links drop_l ON drop_l.doweling_order_id = d.doweling_order_id AND NOT drop_l.delete_flag
JOIN public.orders dropo ON dropo.order_id = drop_l.order_id AND NOT dropo.delete_flag AND dropo.order_name = '2290'
WHERE d.doweling_order_name = '1289' AND d.client_id IS NULL
  AND keep.client_id <> dropo.client_id
  AND (SELECT count(*) FROM public.order_doweling_links x
        JOIN public.orders xo ON xo.order_id = x.order_id AND NOT xo.delete_flag
        WHERE x.doweling_order_id = d.doweling_order_id AND NOT x.delete_flag) = 2;

-- Предпроверка: карточки с заказами разных клиентов (кроме разрешённой «1289») — STOP со списком.
DO $$
DECLARE
  v_conflicts text;
BEGIN
  SELECT string_agg(format('«%s» (id %s): клиенты %s', d.doweling_order_name, c.doweling_order_id,
           coalesce(c.live_clients, c.dead_clients)::text), '; ' ORDER BY c.doweling_order_id)
    INTO v_conflicts
  FROM tmp_card_clients c
  JOIN public.doweling_orders d USING (doweling_order_id)
  WHERE (coalesce(array_length(c.live_clients, 1), 0) > 1
         OR (c.live_clients IS NULL AND coalesce(array_length(c.dead_clients, 1), 0) > 1))
    AND NOT EXISTS (SELECT 1 FROM tmp_split_resolution r WHERE r.doweling_order_id = c.doweling_order_id);
  IF v_conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'STOP 279: присадки с заказами разных клиентов, нужно решение пользователя: %', v_conflicts
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.bazis_nd_client_id();
END $$;

-- «1289»: снять связь с 2290 (как снятие в UI; триггер версии 256 сработает).
UPDATE public.order_doweling_links l
SET delete_flag = true
FROM tmp_split_resolution r
WHERE l.order_doweling_link_id = r.drop_link_id;

UPDATE public.doweling_orders d
SET order_id = NULL
FROM tmp_split_resolution r
WHERE d.doweling_order_id = r.doweling_order_id AND d.order_id = r.drop_order_id;

INSERT INTO public.audit_log (event, entity_type, entity_id, user_id, username, request_id,
                              before_json, after_json, metadata_json, source, related_order_id)
SELECT 'doweling.link_removed_by_migration', 'doweling_order', r.doweling_order_id::text, NULL, 'system',
       'migration-279',
       jsonb_build_object('orderDowelingLinkId', r.drop_link_id, 'orderId', r.drop_order_id, 'deleteFlag', false),
       jsonb_build_object('orderDowelingLinkId', r.drop_link_id, 'orderId', r.drop_order_id, 'deleteFlag', true),
       jsonb_build_object('origin', 'migration_279', 'reason', 'user_decision_2026_10_27',
                          'dowelingOrderId', r.doweling_order_id, 'keptOrderId', r.keep_order_id),
       'migration_279', r.drop_order_id
FROM tmp_split_resolution r;

-- Клиент: живые заказы → удалённые заказы → «нд».
DROP TABLE IF EXISTS tmp_client_backfill;
CREATE TEMP TABLE tmp_client_backfill ON COMMIT DROP AS
SELECT c.doweling_order_id,
       coalesce(r.keep_client_id, c.live_clients[1], c.dead_clients[1], public.bazis_nd_client_id()) AS client_id,
       CASE
         WHEN r.doweling_order_id IS NOT NULL THEN 'split_resolution'
         WHEN c.live_clients IS NOT NULL THEN 'live_orders'
         WHEN c.dead_clients IS NOT NULL THEN 'deleted_orders'
         ELSE 'nd'
       END AS basis
FROM tmp_card_clients c
LEFT JOIN tmp_split_resolution r USING (doweling_order_id);

UPDATE public.doweling_orders d
SET client_id = b.client_id,
    client_source = 'migration'
FROM tmp_client_backfill b
WHERE d.doweling_order_id = b.doweling_order_id AND d.client_id IS NULL;

INSERT INTO public.audit_log (event, entity_type, entity_id, user_id, username, request_id,
                              before_json, after_json, diff_json, metadata_json, source, related_client_id)
SELECT 'doweling.client_backfilled', 'doweling_order', b.doweling_order_id::text, NULL, 'system', 'migration-279',
       jsonb_build_object('clientId', NULL),
       jsonb_build_object('clientId', b.client_id, 'clientSource', 'migration'),
       jsonb_build_object('clientId', jsonb_build_object('before', NULL, 'after', b.client_id)),
       jsonb_build_object('origin', 'migration_279', 'basis', b.basis, 'dowelingOrderId', b.doweling_order_id),
       'migration_279', b.client_id
FROM tmp_client_backfill b;

-- ---------------------------------------------------------------- backfill: XML-проект → карточка

-- Кандидаты: активные карточки с активными связями на заказы из bazis_order_links проекта.
DROP TABLE IF EXISTS tmp_xml_candidates;
CREATE TEMP TABLE tmp_xml_candidates ON COMMIT DROP AS
SELECT bp.bazis_project_id, p.client_id AS group_client_id,
       array_agg(DISTINCT d.doweling_order_id) FILTER (WHERE d.doweling_order_id IS NOT NULL) AS card_ids,
       array_agg(DISTINCT d.client_id) FILTER (WHERE d.doweling_order_id IS NOT NULL) AS card_clients
FROM public.bazis_projects bp
JOIN public.projects p ON p.project_id = bp.project_id
LEFT JOIN public.bazis_order_links bl ON bl.bazis_project_id = bp.bazis_project_id
LEFT JOIN public.order_doweling_links l ON l.order_id = bl.order_id AND NOT l.delete_flag
LEFT JOIN public.doweling_orders d ON d.doweling_order_id = l.doweling_order_id AND NOT d.delete_flag
WHERE bp.doweling_order_id IS NULL
GROUP BY bp.bazis_project_id, p.client_id;

DO $$
DECLARE
  v_conflicts text;
BEGIN
  SELECT string_agg(format('XML-проект %s: карточки %s, клиенты карточек %s, клиент группы %s',
           bazis_project_id, card_ids::text, card_clients::text, group_client_id), '; ' ORDER BY bazis_project_id)
    INTO v_conflicts
  FROM tmp_xml_candidates
  WHERE coalesce(array_length(card_ids, 1), 0) > 1;
  IF v_conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'STOP 279: XML-проекты с неоднозначной карточкой: %', v_conflicts USING ERRCODE = 'P0001';
  END IF;
END $$;

-- Решение пользователя 27.10: XML-проект, чья единственная карточка другого клиента, чем группа XML (детали
-- добавляли в заказ другого клиента), остаётся без карточки — разбор вручную. Новую карточку ему не создаём.
DO $$
DECLARE
  v_skipped text;
BEGIN
  SELECT string_agg(format('XML-проект %s: карточка %s клиента %s, клиент группы %s',
           bazis_project_id, card_ids[1], card_clients[1], group_client_id), '; ' ORDER BY bazis_project_id)
    INTO v_skipped
  FROM tmp_xml_candidates
  WHERE array_length(card_ids, 1) = 1 AND card_clients[1] IS DISTINCT FROM group_client_id;
  IF v_skipped IS NOT NULL THEN
    RAISE NOTICE '279: оставлены без карточки (клиент группы ≠ клиент карточки): %', v_skipped;
  END IF;
END $$;

UPDATE public.bazis_projects bp
SET doweling_order_id = c.card_ids[1]
FROM tmp_xml_candidates c
WHERE bp.bazis_project_id = c.bazis_project_id
  AND array_length(c.card_ids, 1) = 1
  AND c.card_clients[1] = c.group_client_id
  AND bp.doweling_order_id IS NULL;

INSERT INTO public.audit_log (event, entity_type, entity_id, user_id, username, request_id,
                              before_json, after_json, metadata_json, source, related_client_id)
SELECT 'bazis.project_card_linked', 'bazis_project', c.bazis_project_id::text, NULL, 'system', 'migration-279',
       jsonb_build_object('dowelingOrderId', NULL),
       jsonb_build_object('dowelingOrderId', c.card_ids[1]),
       jsonb_build_object('origin', 'migration_279', 'basis', 'single_candidate',
                          'bazisProjectId', c.bazis_project_id, 'dowelingOrderId', c.card_ids[1]),
       'migration_279', c.group_client_id
FROM tmp_xml_candidates c
WHERE array_length(c.card_ids, 1) = 1 AND c.card_clients[1] = c.group_client_id;

-- XML-проекты без кандидатов и с конструктором → новая карточка. Без конструктора — без карточки
-- (карточка появится при назначении конструктора).
DO $$
DECLARE
  r record;
  v_card_id bigint;
  v_unpaid smallint;
BEGIN
  SELECT payment_status_id INTO v_unpaid FROM public.payment_statuses WHERE payment_status_code = 'unpaid';
  IF v_unpaid IS NULL THEN
    RAISE EXCEPTION 'STOP 279: нет статуса оплаты unpaid' USING ERRCODE = 'P0001';
  END IF;

  FOR r IN
    SELECT bp.bazis_project_id, bp.name, bp.design_engineer_id, bp.created_by, bp.created_at, c.group_client_id
    FROM tmp_xml_candidates c
    JOIN public.bazis_projects bp ON bp.bazis_project_id = c.bazis_project_id
    WHERE c.card_ids IS NULL
      AND bp.doweling_order_id IS NULL
      AND bp.design_engineer_id IS NOT NULL
    ORDER BY bp.bazis_project_id
  LOOP
    IF r.created_by IS NULL THEN
      RAISE EXCEPTION 'STOP 279: у XML-проекта % нет автора (created_by)', r.bazis_project_id USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.doweling_orders (
      doweling_order_name, doweling_order_date, payment_status_id, design_engineer_id, operator_id,
      client_id, client_source, created_by, created_at, updated_at
    ) VALUES (
      left(r.name, 200), (r.created_at AT TIME ZONE 'Asia/Almaty')::date, v_unpaid, r.design_engineer_id,
      r.design_engineer_id, r.group_client_id, 'migration', r.created_by,
      (r.created_at AT TIME ZONE 'Asia/Almaty'), (r.created_at AT TIME ZONE 'Asia/Almaty')
    )
    RETURNING doweling_order_id INTO v_card_id;

    UPDATE public.bazis_projects SET doweling_order_id = v_card_id WHERE bazis_project_id = r.bazis_project_id;

    INSERT INTO public.audit_log (event, entity_type, entity_id, user_id, username, request_id,
                                  after_json, metadata_json, source, related_client_id)
    VALUES
      ('doweling.created', 'doweling_order', v_card_id::text, NULL, 'system', 'migration-279',
       jsonb_build_object('dowelingOrderId', v_card_id, 'dowelingOrderName', left(r.name, 200),
                          'clientId', r.group_client_id, 'designEngineerId', r.design_engineer_id),
       jsonb_build_object('origin', 'bazis_project_backfill', 'bazisProjectId', r.bazis_project_id),
       'migration_279', r.group_client_id),
      ('bazis.project_card_linked', 'bazis_project', r.bazis_project_id::text, NULL, 'system', 'migration-279',
       jsonb_build_object('dowelingOrderId', v_card_id),
       jsonb_build_object('origin', 'migration_279', 'basis', 'created_card', 'bazisProjectId', r.bazis_project_id,
                          'dowelingOrderId', v_card_id),
       'migration_279', r.group_client_id);
  END LOOP;
END $$;

ALTER TABLE public.doweling_orders ALTER COLUMN client_id SET NOT NULL;

-- Нормализованные связи аудита переноса (поиск аудита по карточке, XML-проекту, клиенту, заказу).
INSERT INTO public.audit_log_related_entity (audit_id, entity_type, entity_id)
SELECT a.audit_id, x.entity_type, x.entity_id
FROM public.audit_log a
CROSS JOIN LATERAL (VALUES
  ('doweling_order', CASE WHEN a.entity_type = 'doweling_order' THEN a.entity_id::bigint
                          ELSE (a.metadata_json->>'dowelingOrderId')::bigint END),
  ('bazis_project', CASE WHEN a.entity_type = 'bazis_project' THEN a.entity_id::bigint
                         ELSE (a.metadata_json->>'bazisProjectId')::bigint END),
  ('client', a.related_client_id),
  ('order', a.related_order_id)
) AS x(entity_type, entity_id)
WHERE a.request_id = 'migration-279' AND x.entity_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- инвариант клиента

-- Нарушения инварианта для карточки (NULL — нарушений нет). Карточки 'default' не проверяются.
CREATE OR REPLACE FUNCTION public.bazis_card_client_violation(p_doweling_order_id bigint)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    (SELECT format('заказ %s клиента %s', o.order_name, o.client_id)
       FROM public.order_doweling_links l
       JOIN public.orders o ON o.order_id = l.order_id AND NOT o.delete_flag
      WHERE l.doweling_order_id = d.doweling_order_id AND NOT l.delete_flag
        AND o.client_id IS DISTINCT FROM d.client_id
      ORDER BY o.order_id LIMIT 1),
    (SELECT format('XML-проект %s группы клиента %s', bp.bazis_project_id, p.client_id)
       FROM public.bazis_projects bp
       JOIN public.projects p ON p.project_id = bp.project_id
      WHERE bp.doweling_order_id = d.doweling_order_id
        AND p.client_id IS DISTINCT FROM d.client_id
      ORDER BY bp.bazis_project_id LIMIT 1))
  FROM public.doweling_orders d
  WHERE d.doweling_order_id = p_doweling_order_id
    AND d.client_source <> 'default'
$$;

CREATE OR REPLACE FUNCTION public.raise_bazis_card_client_violation(p_doweling_order_id bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_violation text := public.bazis_card_client_violation(p_doweling_order_id);
BEGIN
  IF v_violation IS NOT NULL THEN
    RAISE EXCEPTION 'Клиент Базис-проекта % не совпадает: %', p_doweling_order_id, v_violation
      USING ERRCODE = '23514', CONSTRAINT = 'chk_bazis_project_client',
            DETAIL = format('dowelingOrderId=%s', p_doweling_order_id);
  END IF;
END;
$$;

-- Итоговая проверка переноса (до COMMIT): нарушения → откат всей миграции.
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(format('%s: %s', doweling_order_id, v), '; ') INTO v_bad
  FROM (SELECT doweling_order_id, public.bazis_card_client_violation(doweling_order_id) AS v
        FROM public.doweling_orders) x
  WHERE v IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'STOP 279: инвариант клиента нарушен после переноса: %', v_bad USING ERRCODE = 'P0001';
  END IF;
END $$;

-- Проверочные триггеры: только читают, ничего не пишут; отложены до COMMIT.
CREATE OR REPLACE FUNCTION public.trg_bazis_client_check_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT NEW.delete_flag THEN
    PERFORM public.raise_bazis_card_client_violation(NEW.doweling_order_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_bazis_client_check_card()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.raise_bazis_card_client_violation(NEW.doweling_order_id);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_bazis_client_check_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_card bigint;
BEGIN
  IF NEW.delete_flag THEN
    RETURN NULL;
  END IF;
  FOR v_card IN
    SELECT DISTINCT l.doweling_order_id FROM public.order_doweling_links l
    WHERE l.order_id = NEW.order_id AND NOT l.delete_flag ORDER BY 1
  LOOP
    PERFORM public.raise_bazis_card_client_violation(v_card);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_bazis_client_check_xml()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.doweling_order_id IS NOT NULL THEN
    PERFORM public.raise_bazis_card_client_violation(NEW.doweling_order_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_bazis_client_check_group()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_card bigint;
BEGIN
  FOR v_card IN
    SELECT DISTINCT bp.doweling_order_id FROM public.bazis_projects bp
    WHERE bp.project_id = NEW.project_id AND bp.doweling_order_id IS NOT NULL ORDER BY 1
  LOOP
    PERFORM public.raise_bazis_card_client_violation(v_card);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ctrg_odl_bazis_client ON public.order_doweling_links;
CREATE CONSTRAINT TRIGGER ctrg_odl_bazis_client
  AFTER INSERT OR UPDATE ON public.order_doweling_links
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_bazis_client_check_link();

DROP TRIGGER IF EXISTS ctrg_doweling_orders_bazis_client ON public.doweling_orders;
CREATE CONSTRAINT TRIGGER ctrg_doweling_orders_bazis_client
  AFTER UPDATE OF client_id, client_source ON public.doweling_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_bazis_client_check_card();

-- Смена клиента заказа и восстановление заказа из корзины.
DROP TRIGGER IF EXISTS ctrg_orders_bazis_client ON public.orders;
CREATE CONSTRAINT TRIGGER ctrg_orders_bazis_client
  AFTER UPDATE OF client_id, delete_flag ON public.orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.client_id IS DISTINCT FROM OLD.client_id OR (OLD.delete_flag AND NOT NEW.delete_flag))
  EXECUTE FUNCTION public.trg_bazis_client_check_order();

DROP TRIGGER IF EXISTS ctrg_bazis_projects_client ON public.bazis_projects;
CREATE CONSTRAINT TRIGGER ctrg_bazis_projects_client
  AFTER INSERT OR UPDATE OF doweling_order_id, project_id ON public.bazis_projects
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.trg_bazis_client_check_xml();

DROP TRIGGER IF EXISTS ctrg_projects_bazis_client ON public.projects;
CREATE CONSTRAINT TRIGGER ctrg_projects_bazis_client
  AFTER UPDATE OF client_id ON public.projects
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.client_id IS DISTINCT FROM OLD.client_id)
  EXECUTE FUNCTION public.trg_bazis_client_check_group();

-- Вставка без клиента (прежний backend, импорт снимка): клиент заказа order_id (client_source = 'order', под
-- инвариантом), иначе «нд» с client_source = 'default' (клиент неизвестен до уточнения).
CREATE OR REPLACE FUNCTION public.doweling_orders_default_client()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.client_id IS NULL THEN
    IF NEW.order_id IS NOT NULL THEN
      SELECT o.client_id INTO NEW.client_id FROM public.orders o WHERE o.order_id = NEW.order_id;
    END IF;
    IF NEW.client_id IS NOT NULL THEN
      NEW.client_source := 'order';
    ELSE
      NEW.client_id := public.bazis_nd_client_id();
      NEW.client_source := 'default';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_doweling_orders_default_client ON public.doweling_orders;
CREATE TRIGGER trg_doweling_orders_default_client
  BEFORE INSERT ON public.doweling_orders
  FOR EACH ROW EXECUTE FUNCTION public.doweling_orders_default_client();

-- Объединение клиентов (268, если применена): карточки следуют за клиентом и пишутся в журнал видом 'bazis_card'.
DO $$
BEGIN
  IF to_regclass('public.client_merge_items') IS NOT NULL THEN
    ALTER TABLE public.client_merge_items DROP CONSTRAINT IF EXISTS client_merge_items_item_kind_check;
    ALTER TABLE public.client_merge_items ADD CONSTRAINT client_merge_items_item_kind_check CHECK (item_kind IN (
      'project', 'order', 'phone_moved', 'phone_deleted', 'phone_key_moved', 'phone_primary',
      'contact_moved', 'contact_deleted', 'contact_primary', 'onec_link', 'redirect_repointed', 'bazis_card'));
  END IF;
END $$;

-- Карточка не пишется на объединённого клиента (защита 268 для doweling_orders; R2 #3). Имя после триггера клиента
-- по умолчанию: проверяется уже подставленный клиент.
DO $$
BEGIN
  IF to_regprocedure('public.client_merge_guard()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_doweling_orders_zz_client_merge_guard ON public.doweling_orders;
    CREATE TRIGGER trg_doweling_orders_zz_client_merge_guard
      BEFORE INSERT OR UPDATE OF client_id ON public.doweling_orders
      FOR EACH ROW EXECUTE FUNCTION public.client_merge_guard();
  END IF;
END $$;

-- ---------------------------------------------------------------- представления

-- Клиент — клиент карточки (раньше — клиент связанного заказа; при инварианте это одно и то же).
CREATE OR REPLACE VIEW public.doweling_orders_view AS
SELECT
    d.doweling_order_id,
    d.doweling_order_name,
    ord.order_id,
    ord.order_name,
    d.client_id,
    c.client_name,
    d.doweling_order_date,
    ps.payment_status_name,
    pr.production_status_name,
    d.issue_date,
    d.total_amount,
    d.final_amount,
    d.discount,
    d.surcharge,
    d.paid_amount,
    d.payment_date,
    d.parts_count,
    mt.milling_type_name,
    et.edge_type_name,
    smt.name AS material_name,
    d.design_engineer_id,
    emd.full_name AS design_engineer,
    d.operator_id,
    emo.full_name AS operator,
    d.link_cad_file,
    d.link_pdf_file,
    d.version,
    d.ref_key_1c AS order_ref_key_1c,
    c.ref_key_1c AS client_ref_key_1c,
    d.created_by,
    d.edited_by,
    d.created_at,
    d.updated_at,
    d.delete_flag,
    d.client_source,
    (SELECT count(*) FROM public.bazis_projects bp WHERE bp.doweling_order_id = d.doweling_order_id)::integer AS bazis_xml_count
FROM public.doweling_orders d
LEFT JOIN public.order_doweling_links odl
       ON d.doweling_order_id = odl.doweling_order_id
      AND odl.delete_flag = false
LEFT JOIN public.orders ord
       ON odl.order_id = ord.order_id
      AND ord.delete_flag = false
LEFT JOIN public.clients c ON d.client_id = c.client_id
LEFT JOIN public.payment_statuses ps ON d.payment_status_id = ps.payment_status_id
LEFT JOIN public.production_statuses pr ON d.production_status_id = pr.production_status_id
LEFT JOIN public.milling_types mt ON ord.milling_type_id = mt.milling_type_id
LEFT JOIN public.edge_types et ON ord.edge_type_id = et.edge_type_id
LEFT JOIN public.sheet_material_types smt ON ord.sheet_material_type_id = smt.sheet_material_type_id
LEFT JOIN public.employees emd ON d.design_engineer_id = emd.employee_id
LEFT JOIN public.employees emo ON d.operator_id = emo.employee_id
ORDER BY d.doweling_order_id DESC;

COMMENT ON VIEW public.doweling_orders_view IS
  'Базис-проекты (карточки, бывшие присадки): клиент карточки, только активные связи с живыми заказами';

-- orders_view: Базис-проект заказа — по последней активной связи (как календарь), а не по legacy
-- doweling_orders.order_id (у быстро созданных карточек он пуст). Текущее определение берётся из каталога
-- (как в 155), заменяется только соединение с doweling_orders; столбцы и их порядок не меняются.
DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_viewdef('public.orders_view'::regclass, true) INTO v_def;
  IF position('order_doweling_links' IN v_def) > 0 THEN
    RETURN; -- уже заменено (повторный запуск)
  END IF;
  v_new := regexp_replace(
    v_def,
    'LEFT JOIN doweling_orders d ON ord\.order_id = d\.order_id',
    'LEFT JOIN LATERAL ( SELECT dl.doweling_order_id, dl.doweling_order_name, dl.design_engineer_id '
      || 'FROM order_doweling_links l JOIN doweling_orders dl ON dl.doweling_order_id = l.doweling_order_id '
      || 'WHERE l.order_id = ord.order_id AND l.delete_flag = false '
      || 'ORDER BY l.order_doweling_link_id DESC LIMIT 1) d ON true');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'STOP 279: в orders_view не найдено соединение с doweling_orders по order_id'
      USING ERRCODE = 'P0001';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.orders_view AS ' || rtrim(v_new, E';\n ');
END $$;

COMMIT;
