-- Статус «Базис» (миграция 282) в работе ЧПУ и при смене версий backend:
-- 1) сохранённая настройка «готовые к раскрою статусы» (cut_settings 'eligibility.statuses', миграция 023) получает
--    код saw рядом с drawn, если drawn в ней есть и saw ещё нет (пользовательские коды сохраняются): деталь «Базис» можно
--    добавить в задание ЧПУ — с предупреждением, как задумано (план §10.4);
-- 2) состав карточек «Базис раскрой» меняют только команды с синхронизацией статуса «Базис» (флаг сессии
--    erp.bazis_cut_saw_sync): прежний backend (окно миграция→переключение, откат) получает отказ, а не рассинхронизацию.
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
DROP FUNCTION IF EXISTS public.reconcile_saw_detail_statuses(timestamptz, text);

-- The composition of «Базис раскрой» cards is changed only by the commands that also keep the «Базис» status in step
-- (they set erp.bazis_cut_saw_sync in their transaction). A previous backend (between this migration and the switch,
-- or after a rollback) gets a clear error instead of leaving a detail «Базис» outside every card or «Новый» inside one.
-- Changes made by a foreign-key action (deleting an order detail) run inside another trigger and pass.
CREATE OR REPLACE FUNCTION public.trg_bazis_cut_set_details_saw_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('erp.bazis_cut_saw_sync', true) = 'on' OR pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'BAZIS_CUT_REQUIRES_SAW_SYNC: состав «Базис раскрой» меняет только backend с синхронизацией статуса «Базис» — обновите страницу'
    USING ERRCODE = 'P0001';
END $$;

DROP TRIGGER IF EXISTS trg_bazis_cut_set_details_saw_guard ON public.bazis_cut_set_details;
CREATE TRIGGER trg_bazis_cut_set_details_saw_guard
  BEFORE INSERT OR DELETE OR UPDATE OF source_order_detail_id ON public.bazis_cut_set_details
  FOR EACH ROW EXECUTE FUNCTION public.trg_bazis_cut_set_details_saw_guard();

COMMIT;
