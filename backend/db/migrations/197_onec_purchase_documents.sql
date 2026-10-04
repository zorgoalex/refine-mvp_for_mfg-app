-- 1C purchase and payment documents (normalized layer) and their allocation to
-- order material purchases. Additive only, created empty: rows arrive from the
-- 1C agent projector in a later phase; until then only test fixtures exist.
-- Documents are never deleted in ERP: deletion/unposting in 1C is a flag.

CREATE TABLE IF NOT EXISTS public.onec_documents (
  onec_document_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES public.onec_sources(source_id),
  doc_kind VARCHAR(24) NOT NULL,
  onec_ref_key UUID NOT NULL,
  number TEXT NOT NULL,
  doc_date DATE NOT NULL,
  posted BOOLEAN NOT NULL DEFAULT false,
  deleted_in_onec BOOLEAN NOT NULL DEFAULT false,
  counterparty_ref_key UUID NULL,
  counterparty_name TEXT NULL,
  supplier_id BIGINT NULL REFERENCES public.suppliers(supplier_id),
  amount NUMERIC(14,2) NULL,
  currency CHAR(3) NOT NULL DEFAULT 'KZT',
  comment TEXT NULL,
  source_updated_at TIMESTAMPTZ NULL,
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_onec_documents_kind CHECK (doc_kind IN ('purchase_receipt', 'cash_outflow', 'bank_outflow')),
  CONSTRAINT chk_onec_documents_number CHECK (length(btrim(number)) BETWEEN 1 AND 64),
  CONSTRAINT chk_onec_documents_amount CHECK (amount IS NULL OR amount >= 0),
  CONSTRAINT uq_onec_documents_ref UNIQUE (source_id, doc_kind, onec_ref_key)
);

CREATE INDEX IF NOT EXISTS idx_onec_documents_kind_date
  ON public.onec_documents(doc_kind, doc_date DESC, onec_document_id DESC);

CREATE TABLE IF NOT EXISTS public.onec_document_lines (
  onec_document_line_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  onec_document_id BIGINT NOT NULL REFERENCES public.onec_documents(onec_document_id),
  line_no INTEGER NOT NULL,
  nomenclature_ref_key UUID NULL,
  nomenclature_name TEXT NULL,
  quantity NUMERIC(14,3) NOT NULL,
  unit_name TEXT NULL,
  unit_code VARCHAR(8) NULL,
  price NUMERIC(14,2) NULL,
  amount NUMERIC(14,2) NULL,
  is_document_total BOOLEAN NOT NULL DEFAULT false,
  sheet_material_type_id BIGINT NULL REFERENCES public.sheet_material_types(sheet_material_type_id),
  film_id BIGINT NULL REFERENCES public.films(film_id),
  onec_order_ref_key UUID NULL,
  CONSTRAINT chk_onec_document_lines_no CHECK (line_no >= 1),
  CONSTRAINT chk_onec_document_lines_quantity CHECK (quantity >= 0),
  CONSTRAINT chk_onec_document_lines_amount CHECK (amount IS NULL OR amount >= 0),
  CONSTRAINT chk_onec_document_lines_unit CHECK (unit_code IS NULL OR unit_code IN ('sheet', 'm2', 'lm', 'pcs', 'set')),
  CONSTRAINT chk_onec_document_lines_one_material CHECK (sheet_material_type_id IS NULL OR film_id IS NULL),
  CONSTRAINT uq_onec_document_lines_no UNIQUE (onec_document_id, line_no)
);

-- Оплата без номенклатуры распределяется по единственной строке-итогу документа.
CREATE UNIQUE INDEX IF NOT EXISTS uq_onec_document_lines_total
  ON public.onec_document_lines(onec_document_id)
  WHERE is_document_total;

CREATE TABLE IF NOT EXISTS public.order_resource_onec_allocations (
  allocation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_resource_procurement_id BIGINT NOT NULL REFERENCES public.order_resource_procurement(order_resource_procurement_id),
  onec_document_line_id BIGINT NOT NULL REFERENCES public.onec_document_lines(onec_document_line_id),
  role VARCHAR(8) NOT NULL,
  quantity NUMERIC(14,3) NULL,
  unit_code VARCHAR(8) NULL,
  amount NUMERIC(14,2) NULL,
  origin VARCHAR(8) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NULL REFERENCES public.users(user_id),
  removed_at TIMESTAMPTZ NULL,
  removed_by BIGINT NULL REFERENCES public.users(user_id),
  CONSTRAINT chk_orp_alloc_role CHECK (role IN ('receipt', 'payment')),
  CONSTRAINT chk_orp_alloc_origin CHECK (origin IN ('auto', 'manual')),
  CONSTRAINT chk_orp_alloc_quantity CHECK (quantity IS NULL OR quantity > 0),
  CONSTRAINT chk_orp_alloc_amount CHECK (amount IS NULL OR amount > 0),
  -- Приход распределяется количеством, оплата — суммой.
  CONSTRAINT chk_orp_alloc_measure CHECK (
    (role = 'receipt' AND quantity IS NOT NULL AND amount IS NULL)
    OR (role = 'payment' AND amount IS NOT NULL AND quantity IS NULL)
  ),
  CONSTRAINT chk_orp_alloc_unit CHECK (unit_code IS NULL OR unit_code IN ('sheet', 'm2', 'lm', 'pcs', 'set'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_orp_alloc_active
  ON public.order_resource_onec_allocations(order_resource_procurement_id, onec_document_line_id, role)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_orp_alloc_line_active
  ON public.order_resource_onec_allocations(onec_document_line_id)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_orp_alloc_procurement
  ON public.order_resource_onec_allocations(order_resource_procurement_id);

COMMENT ON TABLE public.onec_documents IS
  'Документы 1С (поступления, расходные кассовые ордера, списания со счёта) — нормализованный слой; наполняется проектором агента 1С. В ERP не удаляются: удаление/распроведение в 1С — флаги.';
COMMENT ON TABLE public.order_resource_onec_allocations IS
  'Распределение строки документа 1С на закуп материала заказа: приход — количеством, оплата — суммой. Снятие — removed_at, запись не удаляется.';
