-- Procurement workspace, phase 3b (plan spec_erp/plans/order_resource_req/2026-09-28-procurement-workspace-plan.md §5.5,
-- R1-3, R2-1, R2-4, R3-2, R3-5): explicit quantitative links «1C allocation → supplier request line order».
-- A request is fulfilled ONLY by these links: fulfilled(line order) = Σ active receipt links.quantity; a receipt of the
-- same supplier without a link is only a «possible match». One allocation may be linked to several line orders (a
-- 10 m² receipt closes two 5 m² requests), each link with its own quantity.
-- Receipt link: quantity in the unit of the request line. Payment link (phase 3b-2): amount + the document currency.
-- History is kept: unlinking (or removing the allocation) sets removed_at; a new link is a new row. Only one ACTIVE
-- link per (allocation, line order). Only additive.

CREATE TABLE IF NOT EXISTS public.order_resource_allocation_request_links (
  link_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  allocation_id BIGINT NOT NULL REFERENCES public.order_resource_onec_allocations(allocation_id),
  supplier_request_line_order_id BIGINT NOT NULL REFERENCES public.supplier_request_line_orders(supplier_request_line_order_id),
  quantity NUMERIC(14,3) NULL,
  amount NUMERIC(14,2) NULL,
  currency CHAR(3) NULL,
  created_by BIGINT NOT NULL REFERENCES public.users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ NULL,
  removed_by BIGINT NULL REFERENCES public.users(user_id),
  CONSTRAINT chk_orarl_measure CHECK ((quantity IS NOT NULL) <> (amount IS NOT NULL)),
  CONSTRAINT chk_orarl_quantity CHECK (quantity IS NULL OR quantity > 0),
  CONSTRAINT chk_orarl_amount CHECK (amount IS NULL OR amount > 0),
  CONSTRAINT chk_orarl_currency CHECK ((amount IS NULL) = (currency IS NULL)),
  CONSTRAINT chk_orarl_removed CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_orarl_active
  ON public.order_resource_allocation_request_links(allocation_id, supplier_request_line_order_id)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_orarl_line_order_active
  ON public.order_resource_allocation_request_links(supplier_request_line_order_id)
  WHERE removed_at IS NULL;

-- Safety net for the cross-table invariants (§5.5 R1-2; the commands check them first, under their locks):
-- the measure matches the allocation role (receipt → quantity, payment → amount), the allocation belongs to the same
-- procurement row (order × material) as the request line order, and active receipt links of a line order do not exceed
-- what was ordered. The unit-converted limit «links of an allocation ≤ the allocation» needs the sheet geometry and is
-- checked by the commands only.
CREATE OR REPLACE FUNCTION public.allocation_request_link_invariant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  link RECORD;
  over BOOLEAN;
BEGIN
  SELECT k.link_id, k.quantity, k.amount, k.removed_at, a.role, a.order_resource_procurement_id AS allocation_procurement,
         lo.order_resource_procurement_id AS request_procurement, lo.supplier_request_line_order_id, lo.quantity AS ordered
    INTO link
    FROM public.order_resource_allocation_request_links k
    JOIN public.order_resource_onec_allocations a ON a.allocation_id = k.allocation_id
    JOIN public.supplier_request_line_orders lo ON lo.supplier_request_line_order_id = k.supplier_request_line_order_id
   WHERE k.link_id = NEW.link_id;
  IF NOT FOUND OR link.removed_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF (link.role = 'receipt') <> (link.quantity IS NOT NULL) THEN
    RAISE EXCEPTION 'request link %: the measure does not match the allocation role %', link.link_id, link.role
      USING ERRCODE = 'check_violation';
  END IF;
  IF link.allocation_procurement <> link.request_procurement THEN
    RAISE EXCEPTION 'request link %: the allocation and the request line belong to different orders/materials', link.link_id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Сериализация общего лимита (CR2-1): строка заказа заявки блокируется до подсчёта; параллельная транзакция ждёт
  -- её коммита и видит уже зафиксированные связи (READ COMMITTED: новый снимок на каждый оператор). Команды берут эту
  -- же блокировку раньше, после закупа, — порядок тот же.
  -- NO KEY UPDATE: не конфликтует с FK KEY SHARE, который уже держит вставка связи (иначе — взаимоблокировка).
  PERFORM 1 FROM public.supplier_request_line_orders
    WHERE supplier_request_line_order_id = link.supplier_request_line_order_id FOR NO KEY UPDATE;
  SELECT COALESCE(sum(k.quantity), 0) > link.ordered INTO over
    FROM public.order_resource_allocation_request_links k
   WHERE k.supplier_request_line_order_id = link.supplier_request_line_order_id
     AND k.removed_at IS NULL AND k.quantity IS NOT NULL;
  IF over THEN
    RAISE EXCEPTION 'request line order %: linked receipts exceed the ordered quantity', link.supplier_request_line_order_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_allocation_request_link_invariant ON public.order_resource_allocation_request_links;
CREATE CONSTRAINT TRIGGER trg_allocation_request_link_invariant
  AFTER INSERT OR UPDATE ON public.order_resource_allocation_request_links
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.allocation_request_link_invariant();

-- A request line order that has links (even removed ones) must not be deleted by a draft edit — history.
-- supplier_request_line_orders rows are deleted only in drafts, and drafts can not have links (links need 'sent').

COMMENT ON TABLE public.order_resource_allocation_request_links IS
  'Исполнение заявок поставщикам: связь распределения прихода/оплаты 1С с заказом строки заявки (количество/сумма)';
