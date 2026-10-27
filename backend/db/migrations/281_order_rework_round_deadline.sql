-- «Переделка» 1.1 — срок готовности круга (план 2026-10-27-order-rework-deadlines-plan v7, §5).
--
-- Аддитивно: колонки круга для срока, прежних значений заказа и надёжной отметки «итоговый дедлайн заказа нужно
-- сверить». Старый backend колонки не читает и не пишет. Hasura не трогается (таблица не в metadata).
--
--   planned_completion_date            — срок готовности круга, последний применённый командой круга;
--   planned_completion_source          — 'schedule' (по «Схеме этапов и сроки» без правки) / 'manual';
--   suggested_planned_completion_date  — что предложила схема (аудит, разбор расхождений);
--   from_planned_completion_date       — orders.planned_completion_date до старта круга;
--   from_completion_date               — orders.completion_date до старта круга (только «после готовности»);
--   deadline_sync_requested_at         — ставится командой круга, снимается сверкой итогового дедлайна
--                                        (после commit, фоновым проходом, сохранением заказа или ремонтом);
--   deadline_sync_request_id           — request id команды, поставившей отметку (корреляция фоновой сверки);
--   deadline_sync_requested_by         — пользователь этой команды (инициатор; исполнитель сверки — система).
--
-- Откат: backend/db/rollback/281_order_rework_round_deadline.down.sql — только пока колонки пустые.

BEGIN;

ALTER TABLE public.order_production_rounds
  ADD COLUMN IF NOT EXISTS planned_completion_date date,
  ADD COLUMN IF NOT EXISTS planned_completion_source text,
  ADD COLUMN IF NOT EXISTS suggested_planned_completion_date date,
  ADD COLUMN IF NOT EXISTS from_planned_completion_date date,
  ADD COLUMN IF NOT EXISTS from_completion_date date,
  ADD COLUMN IF NOT EXISTS deadline_sync_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS deadline_sync_request_id text,
  ADD COLUMN IF NOT EXISTS deadline_sync_requested_by bigint REFERENCES public.users(user_id) ON DELETE SET NULL;

ALTER TABLE public.order_production_rounds
  DROP CONSTRAINT IF EXISTS chk_order_production_rounds_planned_source;
ALTER TABLE public.order_production_rounds
  ADD CONSTRAINT chk_order_production_rounds_planned_source
  CHECK (
    planned_completion_source IS NULL
    OR (planned_completion_source IN ('schedule', 'manual') AND planned_completion_date IS NOT NULL)
  );

-- Фоновый проход берёт круги с отметкой: частичный индекс по непустым отметкам.
CREATE INDEX IF NOT EXISTS idx_order_production_rounds_deadline_sync
  ON public.order_production_rounds (deadline_sync_requested_at)
  WHERE deadline_sync_requested_at IS NOT NULL;

COMMIT;
