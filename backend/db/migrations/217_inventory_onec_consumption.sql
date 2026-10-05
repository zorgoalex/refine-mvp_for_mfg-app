-- Расход склада ERP из документов 1С: проекция в учёт плёнки (план spec_erp/plans/1c-agent/
-- 2026-09-30-onec-consumption-documents-plan.md §4). Аддитивно: инварианты учёта (документ → движения,
-- UNIQUE(document_id, film_id), balance_after = balance_before + delta) не меняются — каждое применение
-- расхода 1С — новый проведённый документ-дельта source/doc_type = 'onec'. Данные не трогаются.

-- Момент начала расхода 1С по складу (NULL — склад не участвует).
ALTER TABLE public.warehouses ADD COLUMN IF NOT EXISTS onec_consumption_since TIMESTAMPTZ NULL;

-- Момент подсчёта инвентаризации (отсечка проекции) и ссылка документа-дельты на документ 1С.
-- Без FK на onec_documents: загрузчик 1С удаляет документ при смене вида, ссылка — для трассировки.
ALTER TABLE public.stock_documents
  ADD COLUMN IF NOT EXISTS counted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS onec_document_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS onec_source_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS onec_ref_key UUID NULL,
  ADD COLUMN IF NOT EXISTS onec_revision INTEGER NULL,
  ADD COLUMN IF NOT EXISTS projection_seq INTEGER NULL;

ALTER TABLE public.stock_documents DROP CONSTRAINT IF EXISTS chk_stock_documents_doc_type;
ALTER TABLE public.stock_documents ADD CONSTRAINT chk_stock_documents_doc_type
  CHECK (doc_type IN ('receipt', 'writeoff', 'inventory', 'onec'));
ALTER TABLE public.stock_documents DROP CONSTRAINT IF EXISTS chk_stock_documents_source;
ALTER TABLE public.stock_documents ADD CONSTRAINT chk_stock_documents_source
  CHECK (source IN ('manual', 'import', 'onec'));
ALTER TABLE public.stock_documents DROP CONSTRAINT IF EXISTS chk_stock_documents_counted_at;
ALTER TABLE public.stock_documents ADD CONSTRAINT chk_stock_documents_counted_at
  CHECK (counted_at IS NULL OR doc_type = 'inventory');
ALTER TABLE public.stock_documents DROP CONSTRAINT IF EXISTS chk_stock_documents_onec;
ALTER TABLE public.stock_documents ADD CONSTRAINT chk_stock_documents_onec CHECK (
  ((source = 'onec') = (doc_type = 'onec'))
  AND ((source = 'onec') = (onec_document_id IS NOT NULL AND onec_source_id IS NOT NULL AND projection_seq IS NOT NULL))
  AND (source <> 'onec' OR (status = 'posted' AND order_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_documents_onec_projection
  ON public.stock_documents (onec_document_id, warehouse_id, projection_seq) WHERE source = 'onec';

ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS chk_stock_movements_type;
ALTER TABLE public.stock_movements ADD CONSTRAINT chk_stock_movements_type
  CHECK (movement_type IN ('receipt', 'writeoff', 'inventory_adjustment', 'onec'));
-- Ворота проекции: последнее движение инвентаризации (w, f) по movement_id.
CREATE INDEX IF NOT EXISTS idx_stock_movements_inventory_last
  ON public.stock_movements (warehouse_id, film_id, movement_id DESC) WHERE movement_type = 'inventory_adjustment';

-- Состояние проекции документа 1С (точка сериализации прохода, FOR UPDATE).
CREATE TABLE IF NOT EXISTS public.inventory_onec_projection (
  onec_document_id BIGINT PRIMARY KEY,
  onec_source_id BIGINT NOT NULL,
  onec_ref_key UUID NOT NULL,
  applied_revision INTEGER NULL,
  inputs_hash TEXT NULL,
  gone BOOLEAN NOT NULL DEFAULT false,
  projected_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Применённый расход документа 1С по (склад, каноническая плёнка), со знаком, в шкале учёта.
CREATE TABLE IF NOT EXISTS public.inventory_onec_applied (
  onec_document_id BIGINT NOT NULL,
  warehouse_id SMALLINT NOT NULL REFERENCES public.warehouses(warehouse_id),
  film_id BIGINT NOT NULL REFERENCES public.films(film_id),
  quantity NUMERIC(12,2) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_inventory_onec_applied PRIMARY KEY (onec_document_id, warehouse_id, film_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_onec_applied_warehouse_film
  ON public.inventory_onec_applied (warehouse_id, film_id);

-- «Не учтено из 1С» на последний проход по документу (заменяется целиком).
CREATE TABLE IF NOT EXISTS public.inventory_onec_issues (
  issue_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  onec_document_id BIGINT NOT NULL,
  onec_line_id BIGINT NULL,
  code TEXT NOT NULL,
  warehouse_id SMALLINT NULL REFERENCES public.warehouses(warehouse_id),
  nomenclature_ref_key UUID NULL,
  quantity NUMERIC(14,3) NULL,
  details JSONB NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_inventory_onec_issues_code CHECK (code IN (
    'FILM_UNLINKED', 'UNIT_PACKAGE', 'UNIT_MISMATCH', 'WAREHOUSE_UNLINKED', 'NO_CUTOFF', 'NO_BASELINE',
    'BEFORE_CUTOFF', 'AMBIGUOUS_SOURCE', 'LINE_CONFLICT', 'MISSING_IN_SOURCE', 'NO_DOC_AT'
  ))
);
CREATE INDEX IF NOT EXISTS idx_inventory_onec_issues_document ON public.inventory_onec_issues (onec_document_id);
CREATE INDEX IF NOT EXISTS idx_inventory_onec_issues_warehouse ON public.inventory_onec_issues (warehouse_id, code);

-- Поколение и отсечка последней ПРОВЕДЁННОЙ инвентаризации (w, f); пишет только проведение инвентаризации,
-- под блокировкой stock_balances (w, f), атомарно с обнулением применённого расхода 1С.
CREATE TABLE IF NOT EXISTS public.inventory_onec_generation (
  warehouse_id SMALLINT NOT NULL REFERENCES public.warehouses(warehouse_id),
  film_id BIGINT NOT NULL REFERENCES public.films(film_id),
  gen BIGINT NOT NULL,
  counted_at TIMESTAMPTZ NOT NULL,
  inventory_document_id BIGINT NOT NULL REFERENCES public.stock_documents(document_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_inventory_onec_generation PRIMARY KEY (warehouse_id, film_id),
  CONSTRAINT chk_inventory_onec_generation_gen CHECK (gen >= 1)
);

COMMENT ON COLUMN public.warehouses.onec_consumption_since IS
  'Момент начала расхода из документов 1С по складу (NULL — не применяется); меняет команда склада с проверкой ворот';
COMMENT ON COLUMN public.stock_documents.counted_at IS
  'Момент подсчёта инвентаризации (отсечка расхода 1С); только doc_type = inventory, по умолчанию — момент проведения';
