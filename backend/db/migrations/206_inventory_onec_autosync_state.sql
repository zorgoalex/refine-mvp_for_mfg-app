-- Состояние автосинхронизации складов 1С → ERP (план 2026-09-29-onec-warehouse-autosync-plan.md).
-- last_seq — номер последнего начатого запуска (выделяется отдельной транзакцией до синхронизации),
-- finished_seq — номер запуска, чей итог записан последним: итог и алерт пишет только запуск с
-- номером больше finished_seq (запоздавший запуск не перезаписывает более свежий итог).
-- Таблица служебная, только аддитивная; строк при миграции нет.
CREATE TABLE IF NOT EXISTS public.inventory_onec_autosync_state (
  source_id BIGINT PRIMARY KEY REFERENCES public.onec_sources(source_id),
  last_seq BIGINT NOT NULL DEFAULT 0,
  finished_seq BIGINT NOT NULL DEFAULT 0,
  last_outcome TEXT NULL,
  last_error_code TEXT NULL,
  last_result JSONB NULL,
  finished_at TIMESTAMPTZ NULL,
  CONSTRAINT chk_inventory_onec_autosync_seq CHECK (finished_seq >= 0 AND finished_seq <= last_seq),
  CONSTRAINT chk_inventory_onec_autosync_outcome CHECK (last_outcome IS NULL OR last_outcome IN ('succeeded', 'failed'))
);

COMMENT ON TABLE public.inventory_onec_autosync_state IS
  'Автосинхронизация складов 1С → ERP: номера запусков и последний итог по источнику 1С';
