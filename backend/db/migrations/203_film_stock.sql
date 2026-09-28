-- Film stock MVP: stock documents (receipt / write-off / inventory), their lines,
-- the movement ledger, current balances per warehouse and film, and import aliases.
-- Balances are keyed by the canonical film (films.canonical_film_id IS NULL) — the
-- backend command checks canonicality under FOR SHARE before every write (plan §7.2).
-- Negative balances are allowed (user decision Q5); the post command requires an
-- explicit allowNegative confirmation. The legacy material stock table is not used.
-- Only reference seed: the «Склад плёнки» warehouse.

INSERT INTO public.warehouses (warehouse_name, is_active)
VALUES ('Склад плёнки', true)
ON CONFLICT (warehouse_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.stock_documents (
  document_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_type TEXT NOT NULL,
  status TEXT NOT NULL,
  warehouse_id SMALLINT NOT NULL REFERENCES public.warehouses(warehouse_id),
  doc_date DATE NOT NULL,
  source TEXT NOT NULL,
  order_id BIGINT NULL REFERENCES public.orders(order_id),
  file_name TEXT NULL,
  file_sha256 TEXT NULL,
  sheet_name TEXT NULL,
  comment TEXT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by BIGINT NOT NULL REFERENCES public.users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_by BIGINT NULL REFERENCES public.users(user_id),
  posted_at TIMESTAMPTZ NULL,
  cancelled_by BIGINT NULL REFERENCES public.users(user_id),
  cancelled_at TIMESTAMPTZ NULL,
  request_id TEXT NOT NULL,
  correlation_id TEXT NULL,
  CONSTRAINT chk_stock_documents_doc_type CHECK (doc_type IN ('receipt', 'writeoff', 'inventory')),
  CONSTRAINT chk_stock_documents_status CHECK (status IN ('draft', 'posted', 'cancelled')),
  CONSTRAINT chk_stock_documents_source CHECK (source IN ('manual', 'import')),
  CONSTRAINT chk_stock_documents_order_writeoff CHECK (order_id IS NULL OR doc_type = 'writeoff'),
  CONSTRAINT chk_stock_documents_comment CHECK (comment IS NULL OR char_length(comment) <= 2000),
  CONSTRAINT chk_stock_documents_version CHECK (version >= 1),
  CONSTRAINT chk_stock_documents_file CHECK (
    source <> 'import' OR (file_name IS NOT NULL AND file_sha256 IS NOT NULL)
  ),
  CONSTRAINT chk_stock_documents_file_sha CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_stock_documents_posted CHECK (status <> 'posted' OR (posted_by IS NOT NULL AND posted_at IS NOT NULL)),
  CONSTRAINT chk_stock_documents_cancelled CHECK (status <> 'cancelled' OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_stock_documents_status_created
  ON public.stock_documents (status, created_at DESC, document_id DESC);
CREATE INDEX IF NOT EXISTS idx_stock_documents_order
  ON public.stock_documents (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_documents_file_sha
  ON public.stock_documents (file_sha256) WHERE file_sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.stock_document_lines (
  line_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES public.stock_documents(document_id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  raw_name TEXT NULL,
  raw_supplier TEXT NULL,
  raw_quantity TEXT NULL,
  film_id BIGINT NULL REFERENCES public.films(film_id),
  quantity NUMERIC(12,2) NULL,
  match_status TEXT NOT NULL,
  quantity_status TEXT NOT NULL,
  suggestions JSONB NULL,
  issue TEXT NULL,
  CONSTRAINT uq_stock_document_lines_no UNIQUE (document_id, line_no),
  CONSTRAINT chk_stock_document_lines_quantity CHECK (quantity IS NULL OR quantity >= 0),
  CONSTRAINT chk_stock_document_lines_match CHECK (
    match_status IN ('alias', 'exact', 'suggested', 'confirmed', 'manual', 'unmatched', 'skipped')
  ),
  CONSTRAINT chk_stock_document_lines_quantity_status CHECK (
    quantity_status IN ('ok', 'needs_review', 'missing', 'confirmed')
  ),
  CONSTRAINT chk_stock_document_lines_line_no CHECK (line_no >= 1)
);

CREATE INDEX IF NOT EXISTS idx_stock_document_lines_film
  ON public.stock_document_lines (film_id) WHERE film_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.stock_balances (
  warehouse_id SMALLINT NOT NULL REFERENCES public.warehouses(warehouse_id),
  film_id BIGINT NOT NULL REFERENCES public.films(film_id),
  quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
  last_movement_at TIMESTAMPTZ NULL,
  CONSTRAINT pk_stock_balances PRIMARY KEY (warehouse_id, film_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_balances_film ON public.stock_balances (film_id);

CREATE TABLE IF NOT EXISTS public.stock_movements (
  movement_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES public.stock_documents(document_id),
  warehouse_id SMALLINT NOT NULL REFERENCES public.warehouses(warehouse_id),
  film_id BIGINT NOT NULL REFERENCES public.films(film_id),
  movement_type TEXT NOT NULL,
  delta NUMERIC(12,2) NOT NULL,
  balance_before NUMERIC(12,2) NOT NULL,
  balance_after NUMERIC(12,2) NOT NULL,
  order_id BIGINT NULL REFERENCES public.orders(order_id),
  created_by BIGINT NOT NULL REFERENCES public.users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_stock_movements_document_film UNIQUE (document_id, film_id),
  CONSTRAINT chk_stock_movements_type CHECK (movement_type IN ('receipt', 'writeoff', 'inventory_adjustment')),
  CONSTRAINT chk_stock_movements_balance CHECK (balance_after = balance_before + delta)
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_film_created
  ON public.stock_movements (film_id, created_at DESC, movement_id DESC);

CREATE TABLE IF NOT EXISTS public.stock_import_aliases (
  alias_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_name_norm TEXT NOT NULL,
  source_supplier_norm TEXT NOT NULL,
  film_id BIGINT NOT NULL REFERENCES public.films(film_id),
  created_by BIGINT NOT NULL REFERENCES public.users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NULL,
  CONSTRAINT uq_stock_import_aliases_source UNIQUE (source_name_norm, source_supplier_norm),
  CONSTRAINT chk_stock_import_aliases_name CHECK (length(source_name_norm) > 0)
);

COMMENT ON TABLE public.stock_documents IS 'Складские документы плёнки: приход, списание, инвентаризация (черновик → проведён/отменён)';
COMMENT ON TABLE public.stock_balances IS 'Текущий остаток плёнки (пог. м) по складу и канонической плёнке; минус допускается с подтверждением';
COMMENT ON TABLE public.stock_movements IS 'Журнал движений: одна строка на плёнку проведённого документа';
COMMENT ON TABLE public.stock_import_aliases IS 'Подтверждённые сопоставления строк файлов остатков с плёнками';
