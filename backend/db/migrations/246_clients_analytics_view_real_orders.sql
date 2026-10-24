-- «+Клиенты (аналитика)»: clients_analytics_view counts real orders only and tells «в работе» by the order status.
--
-- Before: every non-deleted row of `orders` was counted — CRM requests and drafts included — and an order was
-- «в работе» while completion_date was NULL. That date is not filled (5037 of 5042 orders on the reference data),
-- so nearly every order of every client was «в работе» and none was «завершён».
-- Now: only order_kind = 'production_order' rows are counted (orders, payments of orders, the last order), and an
-- order is «завершён» when its status is «Выдан» or «Завершен» (order_status_code legacy_7 / legacy_8), otherwise
-- «в работе». The backend clients analytics (dashboard, client card, list facts) uses the same rules.
-- The column list and types are unchanged (CREATE OR REPLACE VIEW), so grants and the Hasura tracking stay.
-- Rollback: 246_clients_analytics_view_real_orders_rollback.sql (manual).
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regclass('public.clients_analytics_view') IS NULL THEN
    RAISE EXCEPTION 'migration 246: public.clients_analytics_view does not exist';
  END IF;
  IF (SELECT count(*) FROM public.order_statuses WHERE order_status_code IN ('legacy_7', 'legacy_8')) <> 2 THEN
    RAISE EXCEPTION 'migration 246: order statuses legacy_7 («Выдан») and legacy_8 («Завершен») are required';
  END IF;
END $$;

CREATE OR REPLACE VIEW public.clients_analytics_view AS
 WITH ord_agg AS (
         SELECT o.client_id,
            count(*) AS orders_total_count,
            count(*) FILTER (WHERE os.order_status_code IS NULL OR (os.order_status_code::text <> ALL (ARRAY['legacy_7'::text, 'legacy_8'::text]))) AS orders_in_progress_count,
            count(*) FILTER (WHERE os.order_status_code::text = ANY (ARRAY['legacy_7'::text, 'legacy_8'::text])) AS orders_completed_count,
            min(o.order_date) AS first_order_date,
            max(o.order_date) AS last_order_date,
            sum(COALESCE(o.total_amount, 0::numeric)) AS total_amount_sum,
            sum(COALESCE(o.final_amount, COALESCE(o.total_amount, 0::numeric))) AS final_amount_sum,
            sum(COALESCE(o.discount, 0::numeric)) AS discount_sum,
            sum(COALESCE(o.surcharge, 0::numeric)) AS surcharge_sum,
            sum(COALESCE(o.paid_amount, 0::numeric)) AS paid_amount_sum,
            sum(COALESCE(o.final_amount, COALESCE(o.total_amount, 0::numeric)) - COALESCE(o.paid_amount, 0::numeric)) AS debt_sum,
            sum(COALESCE(o.parts_count, 0)) AS parts_count_sum,
            sum(COALESCE(o.total_area, 0::numeric)) AS total_area_sum
           FROM orders o
             LEFT JOIN order_statuses os ON os.order_status_id = o.order_status_id
          WHERE o.delete_flag = false AND o.order_kind = 'production_order'::text
          GROUP BY o.client_id
        ), pay_agg AS (
         SELECT o.client_id,
            count(*) AS payments_count,
            sum(p.amount) AS payments_total,
            max(p.payment_date) AS last_payment_date
           FROM payments p
             JOIN orders o ON p.order_id = o.order_id
          WHERE p.delete_flag = false AND o.delete_flag = false AND o.order_kind = 'production_order'::text
          GROUP BY o.client_id
        ), last_order AS (
         SELECT DISTINCT ON (o.client_id) o.client_id,
            o.order_id AS last_order_id,
            o.order_name AS last_order_name,
            o.order_date AS last_order_date_exact,
            os.order_status_name AS last_order_status_name,
            ps.payment_status_name AS last_payment_status_name,
            o.total_amount AS last_order_total_amount,
            o.final_amount AS last_order_final_amount,
            o.paid_amount AS last_order_paid_amount
           FROM orders o
             LEFT JOIN order_statuses os ON o.order_status_id = os.order_status_id
             LEFT JOIN payment_statuses ps ON o.payment_status_id = ps.payment_status_id
          WHERE o.delete_flag = false AND o.order_kind = 'production_order'::text
          ORDER BY o.client_id, o.order_date DESC, o.order_id DESC
        ), phone_agg AS (
         SELECT cp.client_id,
            max(cp.phone_number::text) FILTER (WHERE cp.is_primary) AS primary_phone,
            string_agg(cp.phone_number::text, ', '::text ORDER BY cp.is_primary DESC, cp.phone_id) AS all_phones
           FROM client_phones cp
          GROUP BY cp.client_id
        )
 SELECT c.client_id,
    c.client_name,
    pa.primary_phone,
    pa.all_phones,
    c.is_active,
    c.notes,
    COALESCE(oa.orders_total_count, 0::bigint) AS orders_total_count,
    COALESCE(oa.orders_in_progress_count, 0::bigint) AS orders_in_progress_count,
    COALESCE(oa.orders_completed_count, 0::bigint) AS orders_completed_count,
    oa.first_order_date,
    oa.last_order_date,
    COALESCE(oa.total_amount_sum, 0::numeric) AS total_amount_sum,
    COALESCE(oa.final_amount_sum, 0::numeric) AS final_amount_sum,
    COALESCE(oa.discount_sum, 0::numeric) AS discount_sum,
    COALESCE(oa.surcharge_sum, 0::numeric) AS surcharge_sum,
    COALESCE(oa.paid_amount_sum, 0::numeric) AS paid_amount_sum,
    COALESCE(oa.debt_sum, 0::numeric) AS debt_sum,
    COALESCE(oa.parts_count_sum, 0::bigint) AS parts_count_sum,
    COALESCE(oa.total_area_sum, 0::numeric) AS total_area_sum,
    COALESCE(pa2.payments_count, 0::bigint) AS payments_count,
    COALESCE(pa2.payments_total, 0::numeric) AS payments_total,
    pa2.last_payment_date,
    lo.last_order_id,
    lo.last_order_name,
    lo.last_order_date_exact,
    lo.last_order_status_name,
    lo.last_payment_status_name,
    lo.last_order_total_amount,
    lo.last_order_final_amount,
    lo.last_order_paid_amount,
        CASE
            WHEN COALESCE(oa.debt_sum, 0::numeric) > 0::numeric THEN true
            ELSE false
        END AS has_debt,
        CASE
            WHEN oa.last_order_date IS NOT NULL THEN CURRENT_DATE - oa.last_order_date
            ELSE NULL::integer
        END AS days_since_last_order,
    c.created_at,
    c.updated_at,
    c.ref_key_1c,
    c.created_by,
    c.edited_by
   FROM clients c
     LEFT JOIN ord_agg oa ON oa.client_id = c.client_id
     LEFT JOIN pay_agg pa2 ON pa2.client_id = c.client_id
     LEFT JOIN last_order lo ON lo.client_id = c.client_id
     LEFT JOIN phone_agg pa ON pa.client_id = c.client_id;

COMMIT;
