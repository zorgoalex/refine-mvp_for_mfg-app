-- «Переделка» — миграция B: круги включаются на уровне схемы.
-- План: spec_erp/plans/2026-09-27-order-rework-status-plan.md v18 (§4.3, §4.4, §7.1).
--
-- ПРЕДУСЛОВИЯ (runbook): применять только после того, как backend A (коммит
-- «round-aware stage events») работает на всех инстансах, и при
-- runtime-config backendProductionActions=true (frontend пишет этапы через
-- backend, не через Hasura). Откат кода ниже backend A после этой миграции
-- запрещён: старые ON CONFLICT (detail|order, status) не найдут индекса.
--
-- 1. Удаляются старые unique-индексы «этап один раз на деталь/заказ»:
--    повтор этапа в следующем круге становится возможен (уникальность —
--    (detail|order, status, round_no) из миграции 220).
-- 2. DB command boundary на production_status_events: INSERT/UPDATE/DELETE
--    только в транзакции backend-писателя (erp.pse_writer='backend') или
--    backend-импорта snapshot ('historical_import'); для 'backend' запись
--    допускается только в текущем круге детали/заказа, удаление — только
--    событий текущего круга; UPDATE не меняет принадлежность события
--    (заказ/деталь/этап/круг) и допустим только для текущего круга.
--    Без маркера допускаются только ссылочные действия PostgreSQL: каскадное
--    удаление вместе с заказом/деталью (родителя уже нет) и обнуление автора
--    (fk_pse_event_by ON DELETE SET NULL).
-- Вся миграция — одна транзакция (нет окна без триггера при повторе).

BEGIN;

DROP INDEX IF EXISTS public.uq_pse_detail_status_once;
DROP INDEX IF EXISTS public.uq_pse_order_status_once;

CREATE OR REPLACE FUNCTION public.trg_production_status_events_command_boundary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_writer TEXT := COALESCE(current_setting('erp.pse_writer', true), '');
  v_row public.production_status_events%ROWTYPE;
  v_round SMALLINT;
  v_parent_found BOOLEAN;
BEGIN
  -- Ссылочное действие fk_pse_event_by (ON DELETE SET NULL): меняется только
  -- автор, и только когда пользователь-автор действительно удалён (прямое
  -- «обнуление автора» без удаления пользователя идёт по общим правилам ниже).
  IF TG_OP = 'UPDATE'
     AND OLD.event_by IS NOT NULL AND NEW.event_by IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.users WHERE user_id = OLD.event_by)
     AND (NEW.event_id, NEW.order_id, NEW.detail_id, NEW.production_status_id, NEW.round_no,
          NEW.event_at, NEW.note, NEW.payload)
         IS NOT DISTINCT FROM
         (OLD.event_id, OLD.order_id, OLD.detail_id, OLD.production_status_id, OLD.round_no,
          OLD.event_at, OLD.note, OLD.payload) THEN
    RETURN NEW;
  END IF;

  -- Строка, принадлежность которой проверяется: существующая для UPDATE/DELETE.
  IF TG_OP = 'INSERT' THEN
    v_row := NEW;
  ELSE
    v_row := OLD;
  END IF;

  IF v_row.detail_id IS NOT NULL THEN
    SELECT production_round INTO v_round FROM public.order_details WHERE detail_id = v_row.detail_id;
  ELSE
    SELECT production_round INTO v_round FROM public.orders WHERE order_id = v_row.order_id;
  END IF;
  v_parent_found := FOUND;

  -- Каскад удаления заказа/детали: родитель уже удалён этой же командой.
  IF TG_OP = 'DELETE' AND NOT v_parent_found THEN
    RETURN OLD;
  END IF;

  IF v_writer NOT IN ('backend', 'historical_import') THEN
    RAISE EXCEPTION 'STAGE_EVENT_WRITE_REQUIRES_BACKEND' USING ERRCODE = 'P0001';
  END IF;

  -- Принадлежность события неизменна (в т.ч. для импорта).
  IF TG_OP = 'UPDATE'
     AND (NEW.order_id, NEW.detail_id, NEW.production_status_id, NEW.round_no)
         IS DISTINCT FROM (OLD.order_id, OLD.detail_id, OLD.production_status_id, OLD.round_no) THEN
    RAISE EXCEPTION 'STAGE_EVENT_IDENTITY_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;

  IF v_writer = 'historical_import' OR NOT v_parent_found THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_row.round_no IS DISTINCT FROM v_round THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'STAGE_EVENT_PAST_ROUND_DELETE' USING ERRCODE = 'P0001';
    ELSIF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'STAGE_EVENT_PAST_ROUND_UPDATE' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'STAGE_EVENT_ROUND_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_production_status_events_command_boundary ON public.production_status_events;
CREATE TRIGGER trg_production_status_events_command_boundary
BEFORE INSERT OR UPDATE OR DELETE ON public.production_status_events
FOR EACH ROW EXECUTE FUNCTION public.trg_production_status_events_command_boundary();

COMMIT;
