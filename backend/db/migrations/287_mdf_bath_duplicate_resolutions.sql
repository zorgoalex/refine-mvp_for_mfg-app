-- МДФ-доска: решения окна «Разобрать дубль» (две активные ванны разных заданий раскроя с общими деталями).
-- Строка — решение пользователя по паре ванн: «Оставить обе» (keep_both) или «Пометить общие детали этой ванны как
-- переделку» (rework_mark, только метка, круг переделки не открывается). Решение действует, пока digest пары тот же:
-- пересчёт/архивация/изменение состава любой стороны меняет digest — дубль показывается снова, строка остаётся историей.
-- Данные раскроя не меняются. Пишет только backend (команда mdf-bath-duplicates/resolve, аудит + outbox в той же
-- транзакции); Hasura таблицу не видит.
-- Индекс cut_result_placement по заказу не нужен: поиск ванн заказов идёт по idx_cut_result_placement_order_candidates
-- (order_id, …) из миграции 081, ванны — по uq_cut_result_placement_instance (cut_result_id, …).
-- Аддитивная: прежний backend с этой схемой работает; откатывать не нужно (откат решений — удаление строк).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.mdf_bath_duplicate_resolutions (
  resolution_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Упорядоченная пара: 'cut-result:<id>', bath_a — с меньшим cut_result_id.
  bath_a TEXT NOT NULL,
  bath_b TEXT NOT NULL,
  -- Сторона действия; для rework_mark — помеченная ванна.
  target_bath TEXT NOT NULL,
  action TEXT NOT NULL,
  -- Серверный канонический digest пары на момент решения.
  digest TEXT NOT NULL,
  -- Снимок общих деталей: [{orderId, detailId, detailNumber, quantityA, quantityB}].
  shared_json JSONB NOT NULL,
  order_ids BIGINT[] NOT NULL,
  created_by BIGINT NULL REFERENCES public.users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id TEXT NOT NULL,
  -- '<user_id>:<Idempotency-Key>'; повтор с тем же ключом и телом возвращает это решение.
  command_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  audit_id UUID NULL,
  CONSTRAINT uq_mdf_bath_duplicate_resolutions_command_key UNIQUE (command_key),
  CONSTRAINT chk_mdf_bath_duplicate_resolutions_action CHECK (action IN ('keep_both', 'rework_mark')),
  CONSTRAINT chk_mdf_bath_duplicate_resolutions_bath_ids CHECK (
    bath_a ~ '^cut-result:[1-9][0-9]{0,18}$' AND bath_b ~ '^cut-result:[1-9][0-9]{0,18}$'
    AND substring(bath_a FROM 12)::bigint < substring(bath_b FROM 12)::bigint
  ),
  CONSTRAINT chk_mdf_bath_duplicate_resolutions_target CHECK (target_bath IN (bath_a, bath_b)),
  CONSTRAINT chk_mdf_bath_duplicate_resolutions_digest CHECK (digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_mdf_bath_duplicate_resolutions_request_digest CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT chk_mdf_bath_duplicate_resolutions_shared CHECK (jsonb_typeof(shared_json) = 'array'),
  CONSTRAINT chk_mdf_bath_duplicate_resolutions_command_key CHECK (length(command_key) BETWEEN 1 AND 240)
);

CREATE INDEX IF NOT EXISTS idx_mdf_bath_duplicate_resolutions_bath_a
  ON public.mdf_bath_duplicate_resolutions(bath_a, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mdf_bath_duplicate_resolutions_bath_b
  ON public.mdf_bath_duplicate_resolutions(bath_b, created_at DESC);

COMMENT ON TABLE public.mdf_bath_duplicate_resolutions IS
  'Решения «Разобрать дубль» МДФ-доски (keep_both / rework_mark) по паре ванн; действуют, пока digest пары тот же. Пишет только backend.';

COMMIT;
