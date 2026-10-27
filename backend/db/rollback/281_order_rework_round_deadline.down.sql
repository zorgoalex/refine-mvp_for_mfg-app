-- Откат миграции 281 («Переделка» 1.1 — срок готовности круга). Одна транзакция.
-- Только ДО первого использования: если хотя бы в одном круге заполнена любая из новых колонок, откат отказывает —
-- в колонках единственная копия прежних дат заказа (from_*), удалять их нельзя (план v7, §5.1). После использования
-- схему не откатывают: колонки аддитивны, backend 563a3db2 их игнорирует.
-- Ledger: строка 281 удаляется, повторный apply снова применит миграцию.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.order_production_rounds
    WHERE planned_completion_date IS NOT NULL
       OR planned_completion_source IS NOT NULL
       OR suggested_planned_completion_date IS NOT NULL
       OR from_planned_completion_date IS NOT NULL
       OR from_completion_date IS NOT NULL
       OR deadline_sync_requested_at IS NOT NULL
       OR deadline_sync_request_id IS NOT NULL
       OR deadline_sync_requested_by IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_281_REFUSED: round deadline columns already hold data (plan §5.1)';
  END IF;
END
$$;

DROP INDEX IF EXISTS public.idx_order_production_rounds_deadline_sync;
ALTER TABLE public.order_production_rounds DROP CONSTRAINT IF EXISTS chk_order_production_rounds_planned_source;
ALTER TABLE public.order_production_rounds
  DROP COLUMN IF EXISTS planned_completion_date,
  DROP COLUMN IF EXISTS planned_completion_source,
  DROP COLUMN IF EXISTS suggested_planned_completion_date,
  DROP COLUMN IF EXISTS from_planned_completion_date,
  DROP COLUMN IF EXISTS from_completion_date,
  DROP COLUMN IF EXISTS deadline_sync_requested_at,
  DROP COLUMN IF EXISTS deadline_sync_request_id,
  DROP COLUMN IF EXISTS deadline_sync_requested_by;

DELETE FROM public.schema_migrations WHERE filename = '281_order_rework_round_deadline.sql';

COMMIT;
