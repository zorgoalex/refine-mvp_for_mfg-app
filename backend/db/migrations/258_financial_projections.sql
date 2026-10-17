-- Access groups, stage «финансы» (plan spec 2026-10-17 §2): money of orders, order details and doweling orders is read
-- through Hasura only via these projections. Hasura gives a projection row only with orders.view_financials AND the
-- base row's own select filter (metadata step F1); step F2 then removes the money columns from orders_view,
-- order_details(_view) and doweling_orders(_view). The projections take the same values the source views show.
-- Also permissions_state.hasura_financials_state (open → closed by F2; reverting while a revert of F2 runs, during
-- which the backend refuses every authorization change) and hasura_financials_users (the users snapshot of F2).
-- Additive: the running backend and frontend ignore all of it.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- permissions_state first (same lock order as the roles matrix and migrations 249/251/252/253).
SELECT version FROM public.permissions_state WHERE id = true FOR UPDATE;

ALTER TABLE public.permissions_state
  ADD COLUMN IF NOT EXISTS hasura_financials_state text NOT NULL DEFAULT 'open';
-- Users holding orders.view_financials when F2 closed the columns (written in the same transaction as `closed`): a revert
-- refuses while one of them lost the right. NULL outside `closed`/`reverting`.
ALTER TABLE public.permissions_state
  ADD COLUMN IF NOT EXISTS hasura_financials_users jsonb;
-- The revert under way (`reverting`): who started it, the override and the users it reopens — written with the barrier,
-- so a lost answer cannot lose them. NULL outside `reverting`.
ALTER TABLE public.permissions_state
  ADD COLUMN IF NOT EXISTS hasura_financials_revert jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.permissions_state'::regclass AND conname = 'permissions_state_hasura_financials_state_check'
  ) THEN
    ALTER TABLE public.permissions_state ADD CONSTRAINT permissions_state_hasura_financials_state_check
      CHECK (hasura_financials_state IN ('open', 'closed', 'reverting'));
  END IF;
END $$;

-- orders_view takes these from orders and payment_statuses (migration 145).
CREATE OR REPLACE VIEW public.order_financials_view AS
SELECT ord.order_id,
       ord.payment_status_id,
       ps.payment_status_name,
       ord.total_amount,
       ord.final_amount,
       ord.discount,
       ord.surcharge,
       ord.paid_amount,
       ord.payment_date
  FROM public.orders ord
  LEFT JOIN public.payment_statuses ps ON ps.payment_status_id = ord.payment_status_id;

CREATE OR REPLACE VIEW public.order_detail_financials_view AS
SELECT od.detail_id,
       od.order_id,
       od.milling_cost_per_sqm,
       od.detail_cost
  FROM public.order_details od;

-- doweling_orders_view takes these from doweling_orders and payment_statuses (migration 123).
CREATE OR REPLACE VIEW public.doweling_order_financials_view AS
SELECT d.doweling_order_id,
       d.payment_status_id,
       ps.payment_status_name,
       d.total_amount,
       d.final_amount,
       d.discount,
       d.surcharge,
       d.paid_amount,
       d.payment_date
  FROM public.doweling_orders d
  LEFT JOIN public.payment_statuses ps ON ps.payment_status_id = d.payment_status_id;

COMMENT ON VIEW public.order_financials_view IS
  'Money of an order for Hasura (orders.view_financials + the order row''s own filter, metadata step F1).';
COMMENT ON VIEW public.order_detail_financials_view IS
  'Money of an order detail for Hasura (orders.view_financials + the detail row''s own filter, metadata step F1).';
COMMENT ON VIEW public.doweling_order_financials_view IS
  'Money of a doweling order for Hasura (orders.view_financials + the doweling row''s own filter, metadata step F1).';

COMMIT;
