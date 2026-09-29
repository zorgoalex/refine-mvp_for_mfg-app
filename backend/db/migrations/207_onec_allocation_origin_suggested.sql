-- Procurement workspace, phase 2 (plan spec_erp/plans/order_resource_req/2026-09-28-procurement-workspace-plan.md §5.4, R2-7):
-- a receipt allocation made from the «Подобрать заказы» suggestion is stored with origin 'suggested'.
-- 'suggested' has 9 characters: the column (VARCHAR(8) in 197) is widened together with the CHECK.
-- Idempotent; existing values ('auto', 'manual') stay valid.

ALTER TABLE public.order_resource_onec_allocations
  ALTER COLUMN origin TYPE VARCHAR(16);

ALTER TABLE public.order_resource_onec_allocations
  DROP CONSTRAINT IF EXISTS chk_orp_alloc_origin;

ALTER TABLE public.order_resource_onec_allocations
  ADD CONSTRAINT chk_orp_alloc_origin CHECK (origin IN ('auto', 'manual', 'suggested'));
