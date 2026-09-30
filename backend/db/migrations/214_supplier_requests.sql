-- Procurement workspace, phase 3a (plan spec_erp/plans/order_resource_req/2026-09-28-procurement-workspace-plan.md §5.5):
-- supplier requests built from the worklist selection.
-- 1. supplier_requests — a request to one supplier, number 'YY-XXXX' (В-5), status draft → sent → closed | cancelled.
--    supplier_key keeps the worklist supplier identity (s:<supplier_id> | c:<1C counterparty> | n:<md5 name> | none),
--    so a 1C-only supplier (no suppliers row yet) stays the same supplier later (phase 3b links receipts by it).
-- 2. supplier_request_lines — one material per line; quantity = Σ line_orders.quantity + stock_quantity (§5.5, R1-2).
-- 3. supplier_request_line_orders — «ordered for the order»: the quantity of the line meant for one order's
--    procurement row, in the unit of the line; one per (line, procurement).
-- 4. supplier_request_counters — the yearly number counter (Asia/Almaty year of creation); numbers are never reused.
-- 5. procurement_command_keys — idempotency of «create drafts» (R2-6): the key, all drafts and the result are
--    written in one transaction; a repeat with the same body returns the stored result.
-- Only additive. The line invariant is also checked by a deferred constraint trigger as a safety net.

CREATE TABLE IF NOT EXISTS public.supplier_requests (
  supplier_request_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_number TEXT NOT NULL,
  supplier_id SMALLINT NULL REFERENCES public.suppliers(supplier_id),
  supplier_key TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  comment TEXT NULL,
  expected_date DATE NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_by BIGINT NOT NULL REFERENCES public.users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NOT NULL REFERENCES public.users(user_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ NULL,
  sent_by BIGINT NULL REFERENCES public.users(user_id),
  closed_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  CONSTRAINT uq_supplier_requests_number UNIQUE (request_number),
  CONSTRAINT chk_supplier_requests_number CHECK (request_number ~ '^[0-9]{2}-[0-9]{4,}$'),
  CONSTRAINT chk_supplier_requests_status CHECK (status IN ('draft', 'sent', 'closed', 'cancelled')),
  CONSTRAINT chk_supplier_requests_key CHECK (supplier_key = 'none' OR supplier_key ~ '^[scn]:.+$'),
  CONSTRAINT chk_supplier_requests_supplier CHECK (
    (supplier_id IS NULL) = (supplier_key NOT LIKE 's:%')
    AND (supplier_id IS NULL OR supplier_key = 's:' || supplier_id::text)
  ),
  CONSTRAINT chk_supplier_requests_name CHECK (length(btrim(supplier_name)) BETWEEN 1 AND 300),
  CONSTRAINT chk_supplier_requests_comment CHECK (comment IS NULL OR length(comment) <= 2000),
  CONSTRAINT chk_supplier_requests_version CHECK (version >= 0),
  -- A cancelled request may have been sent before (sent_at kept) or cancelled as a draft.
  CONSTRAINT chk_supplier_requests_sent CHECK (
    (status = 'draft' AND sent_at IS NULL AND sent_by IS NULL)
    OR (status IN ('sent', 'closed') AND sent_at IS NOT NULL AND sent_by IS NOT NULL)
    OR status = 'cancelled'
  ),
  CONSTRAINT chk_supplier_requests_closed CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CONSTRAINT chk_supplier_requests_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_supplier_requests_status ON public.supplier_requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.supplier_request_lines (
  supplier_request_line_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_request_id BIGINT NOT NULL REFERENCES public.supplier_requests(supplier_request_id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  resource_kind VARCHAR(32) NOT NULL,
  sheet_material_type_id BIGINT NULL REFERENCES public.sheet_material_types(sheet_material_type_id),
  film_id BIGINT NULL REFERENCES public.films(film_id),
  quantity NUMERIC(14,3) NOT NULL,
  stock_quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
  unit_code VARCHAR(8) NOT NULL,
  CONSTRAINT uq_supplier_request_lines_no UNIQUE (supplier_request_id, line_no),
  CONSTRAINT chk_supplier_request_lines_no CHECK (line_no >= 1),
  CONSTRAINT chk_supplier_request_lines_kind CHECK (resource_kind IN ('sheet_material', 'film')),
  CONSTRAINT chk_supplier_request_lines_one_ref CHECK (
    (resource_kind = 'sheet_material' AND sheet_material_type_id IS NOT NULL AND film_id IS NULL)
    OR (resource_kind = 'film' AND film_id IS NOT NULL AND sheet_material_type_id IS NULL)
  ),
  CONSTRAINT chk_supplier_request_lines_quantity CHECK (quantity > 0),
  CONSTRAINT chk_supplier_request_lines_stock CHECK (stock_quantity >= 0 AND stock_quantity <= quantity),
  CONSTRAINT chk_supplier_request_lines_unit CHECK (unit_code IN ('sheet', 'm2', 'lm', 'pcs', 'set'))
);

-- One line per material in a request.
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_request_lines_sheet
  ON public.supplier_request_lines(supplier_request_id, sheet_material_type_id) WHERE resource_kind = 'sheet_material';
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_request_lines_film
  ON public.supplier_request_lines(supplier_request_id, film_id) WHERE resource_kind = 'film';

CREATE TABLE IF NOT EXISTS public.supplier_request_line_orders (
  supplier_request_line_order_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_request_line_id BIGINT NOT NULL REFERENCES public.supplier_request_lines(supplier_request_line_id) ON DELETE CASCADE,
  order_resource_procurement_id BIGINT NOT NULL REFERENCES public.order_resource_procurement(order_resource_procurement_id),
  quantity NUMERIC(14,3) NOT NULL,
  CONSTRAINT uq_supplier_request_line_orders UNIQUE (supplier_request_line_id, order_resource_procurement_id),
  CONSTRAINT chk_supplier_request_line_orders_quantity CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_supplier_request_line_orders_procurement
  ON public.supplier_request_line_orders(order_resource_procurement_id);

CREATE TABLE IF NOT EXISTS public.supplier_request_counters (
  year SMALLINT PRIMARY KEY,
  last_value INTEGER NOT NULL,
  CONSTRAINT chk_supplier_request_counters_year CHECK (year BETWEEN 2000 AND 2999),
  CONSTRAINT chk_supplier_request_counters_value CHECK (last_value >= 0)
);

CREATE TABLE IF NOT EXISTS public.procurement_command_keys (
  request_id UUID PRIMARY KEY,
  command VARCHAR(48) NOT NULL,
  user_id BIGINT NOT NULL REFERENCES public.users(user_id),
  body_hash CHAR(64) NOT NULL,
  result_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_procurement_command_keys_hash CHECK (body_hash ~ '^[0-9a-f]{64}$')
);

-- Safety net for §5.5 R1-2 (the commands check it first, under their locks): the procurement row of a line order
-- is the same material as the line, and Σ line_orders.quantity + stock_quantity = quantity.
CREATE OR REPLACE FUNCTION public.supplier_request_line_invariant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_line_id BIGINT;
  bad_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_line_id := OLD.supplier_request_line_id;
  ELSE
    target_line_id := NEW.supplier_request_line_id;
  END IF;
  -- The line may be gone (request or line deleted in the same transaction): nothing to check.
  IF NOT EXISTS (SELECT 1 FROM public.supplier_request_lines WHERE supplier_request_line_id = target_line_id) THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO bad_count
    FROM public.supplier_request_line_orders lo
    JOIN public.supplier_request_lines l ON l.supplier_request_line_id = lo.supplier_request_line_id
    JOIN public.order_resource_procurement orp ON orp.order_resource_procurement_id = lo.order_resource_procurement_id
   WHERE lo.supplier_request_line_id = target_line_id
     AND (orp.resource_kind <> l.resource_kind
       OR orp.sheet_material_type_id IS DISTINCT FROM l.sheet_material_type_id
       OR orp.film_id IS DISTINCT FROM l.film_id);
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'supplier request line % has an order of another material', target_line_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT l.quantity <> l.stock_quantity + COALESCE((SELECT sum(lo.quantity) FROM public.supplier_request_line_orders lo
                                                          WHERE lo.supplier_request_line_id = l.supplier_request_line_id), 0)
        FROM public.supplier_request_lines l WHERE l.supplier_request_line_id = target_line_id) THEN
    RAISE EXCEPTION 'supplier request line %: quantity <> orders + stock', target_line_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_supplier_request_lines_invariant ON public.supplier_request_lines;
CREATE CONSTRAINT TRIGGER trg_supplier_request_lines_invariant
  AFTER INSERT OR UPDATE ON public.supplier_request_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.supplier_request_line_invariant();

DROP TRIGGER IF EXISTS trg_supplier_request_line_orders_invariant ON public.supplier_request_line_orders;
CREATE CONSTRAINT TRIGGER trg_supplier_request_line_orders_invariant
  AFTER INSERT OR UPDATE OR DELETE ON public.supplier_request_line_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.supplier_request_line_invariant();

COMMENT ON TABLE public.supplier_requests IS 'Заявки поставщикам (экран снабжения, ф.3): черновик → отправлена → закрыта | отменена';
COMMENT ON TABLE public.supplier_request_line_orders IS 'Заказано в заявке для закупа заказа (в единице строки заявки)';
