-- Manual rollback of 246_clients_analytics_view_real_orders.sql: the previous definition of clients_analytics_view
-- (every non-deleted row of orders is counted; «в работе» = completion_date IS NULL). Run before switching the
-- backend image back; then remove the ledger row:
--   DELETE FROM schema_migrations WHERE filename = '246_clients_analytics_view_real_orders.sql';
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE VIEW public.clients_analytics_view AS
 WITH ord_agg AS (
         SELECT o.client_id,
            count(*) AS orders_total_count,
            count(*) FILTER (WHERE o.completion_date IS NULL) AS orders_in_progress_count,
            count(*) FILTER (WHERE o.completion_date IS NOT NULL) AS orders_completed_count,
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
          WHERE o.delete_flag = false
          GROUP BY o.client_id
        ), pay_agg AS (
         SELECT o.client_id,
            count(*) AS payments_count,
            sum(p.amount) AS payments_total,
            max(p.payment_date) AS last_payment_date
           FROM payments p
             JOIN orders o ON p.order_id = o.order_id
          WHERE p.delete_flag = false AND o.delete_flag = false
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
          WHERE o.delete_flag = false
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
