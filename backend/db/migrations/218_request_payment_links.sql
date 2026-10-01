-- Procurement workspace, phase 3b-2 (plan spec_erp/plans/order_resource_req/2026-09-28-procurement-workspace-plan.md §5.5,
-- R2-4, R3-3): payment links «1C payment allocation → supplier request line order». The table is from 215; this
-- migration only extends its safety-net trigger for payments: the link currency equals the document currency, and
-- active payment links of an allocation do not exceed the allocated amount (serialized per allocation row; NO KEY
-- UPDATE does not conflict with the FK KEY SHARE that the link insert already holds). The commands check all of it
-- first, under their locks. Only the trigger function is replaced; no data changes.

CREATE OR REPLACE FUNCTION public.allocation_request_link_invariant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  link RECORD;
  over BOOLEAN;
BEGIN
  SELECT k.link_id, k.quantity, k.amount, k.currency, k.removed_at, k.allocation_id, a.role, a.amount AS allocated_amount,
         a.order_resource_procurement_id AS allocation_procurement, d.currency AS document_currency,
         lo.order_resource_procurement_id AS request_procurement, lo.supplier_request_line_order_id, lo.quantity AS ordered
    INTO link
    FROM public.order_resource_allocation_request_links k
    JOIN public.order_resource_onec_allocations a ON a.allocation_id = k.allocation_id
    JOIN public.onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
    JOIN public.onec_documents d ON d.onec_document_id = l.onec_document_id
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
  IF link.role = 'receipt' THEN
    -- Сериализация общего лимита строки заявки (215, CR2-1): NO KEY UPDATE не конфликтует с FK KEY SHARE вставки.
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
  ELSE
    IF link.currency IS DISTINCT FROM link.document_currency THEN
      RAISE EXCEPTION 'request link %: currency % differs from the document currency %', link.link_id, link.currency, link.document_currency
        USING ERRCODE = 'check_violation';
    END IF;
    -- Оплата делится между заявками не больше её самой (R2-4); сериализация по строке распределения.
    PERFORM 1 FROM public.order_resource_onec_allocations WHERE allocation_id = link.allocation_id FOR NO KEY UPDATE;
    SELECT COALESCE(sum(k.amount), 0) > COALESCE(link.allocated_amount, 0) INTO over
      FROM public.order_resource_allocation_request_links k
     WHERE k.allocation_id = link.allocation_id AND k.removed_at IS NULL AND k.amount IS NOT NULL;
    IF over THEN
      RAISE EXCEPTION 'allocation %: payment links exceed the allocated amount', link.allocation_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
