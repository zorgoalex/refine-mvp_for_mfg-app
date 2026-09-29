-- Откат миграции 221 («Переделка», миграция B). Одна транзакция.
-- Применять вручную (psql -v ON_ERROR_STOP=1 -f …) только если:
--   * кругов > 1 нет (guard ниже отказывает иначе — вернуть старые индексы
--     «этап один раз» без потери истории кругов невозможно);
--   * backend после отката остаётся не ниже миграции A (его ON CONFLICT
--     работают и со старыми, и с новыми индексами);
--   * команды переделки выключены (BACKEND_ORDER_REWORK=false) — новые круги
--     не создаются; активные записи этапов не блокируют откат навсегда:
--     при конфликте блокировок откат отказывает (NOWAIT), повторить.
-- Hasura: права записи на production_status_events не возвращаются
-- (frontend пишет этапы через backend); при необходимости legacy-пути —
-- отдельным изменением metadata.json.
-- Ledger: строка 221 удаляется, повторный apply снова применит миграцию.
BEGIN;

-- Запись кругов/событий этапов блокируется до проверки и до конца отката.
-- NOWAIT: занято активной командой — откат сразу отказывает (повторить позже),
-- без ожидания и без риска взаимной блокировки с командами (они берут
-- orders → details → эти таблицы).
-- production_status_events сразу в ACCESS EXCLUSIVE: этого режима требует
-- последующий DROP TRIGGER, и позднее повышение ждало бы команду этапа,
-- уже держащую ROW SHARE (SELECT … FOR UPDATE), — взаимная блокировка.
LOCK TABLE public.production_status_events IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.order_production_rounds IN SHARE ROW EXCLUSIVE MODE NOWAIT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.production_status_events WHERE round_no > 1)
     OR EXISTS (SELECT 1 FROM public.order_production_rounds) THEN
    RAISE EXCEPTION 'REWORK_221_ROLLBACK_BLOCKED: production rounds > 1 exist';
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_production_status_events_command_boundary ON public.production_status_events;
DROP FUNCTION IF EXISTS public.trg_production_status_events_command_boundary();

CREATE UNIQUE INDEX IF NOT EXISTS uq_pse_detail_status_once
  ON public.production_status_events (detail_id, production_status_id)
  WHERE detail_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pse_order_status_once
  ON public.production_status_events (order_id, production_status_id)
  WHERE order_id IS NOT NULL;

DELETE FROM public.schema_migrations WHERE filename = '221_order_rework_rounds_stage_boundary.sql';

COMMIT;
