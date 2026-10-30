-- Объединение клиентов (268) и карточки Базис-проекта (279): журнал объединений (client_merges) пишут только
-- объединение и отмена, которые переносят и возвращают карточки (флаг сессии erp.client_merge_cards). Прежний backend
-- (откат на версию без 279) не знает о карточках: его объединение оставило бы карточку у объединённого клиента, а отмена
-- пометила бы объединение отменённым, не вернув карточку. Такой backend получает понятный отказ.
-- Не затрагивает обслуживание журнала (journal_purged_at) и счётчики (counts): триггер — на INSERT и смену status.
-- Повторный запуск — no-op.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.trg_client_merges_cards_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('erp.client_merge_cards', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'CLIENT_MERGE_REQUIRES_CARDS: Объединение клиентов: эта версия backend не учитывает карточки Базис-проекта — обновите backend'
    USING ERRCODE = 'P0001';
END $$;

DROP TRIGGER IF EXISTS trg_client_merges_cards_guard ON public.client_merges;
CREATE TRIGGER trg_client_merges_cards_guard
  BEFORE INSERT OR UPDATE OF status ON public.client_merges
  FOR EACH ROW EXECUTE FUNCTION public.trg_client_merges_cards_guard();

COMMIT;
