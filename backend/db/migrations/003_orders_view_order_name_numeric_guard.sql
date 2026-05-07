-- Backend stage 1 restore hardening.
-- Keep orders_view.order_name_numeric within int4 range so Hasura GraphQL
-- integer fields do not fail when order_name contains long digit sequences.

CREATE OR REPLACE VIEW orders_view AS
SELECT
    ord.order_id,
    ord.order_name,
    CASE
        WHEN order_name_digits.value = '' THEN NULL
        WHEN length(order_name_digits.value) > 10 THEN NULL
        WHEN order_name_digits.value::BIGINT > 2147483647 THEN NULL
        ELSE order_name_digits.value::INTEGER
    END AS order_name_numeric,
    ord.client_id,
    c.client_name,
    ord.order_date,
    ord.priority,
    d.doweling_order_id,
    d.doweling_order_name,
    emd.full_name AS design_engineer,
    ord.completion_date,
    ord.planned_completion_date,
    os.order_status_name,
    ps.payment_status_name,
    pr.production_status_name,
    ord.issue_date,
    ord.total_amount,
    ord.final_amount,
    ord.discount,
    ord.surcharge,
    ord.paid_amount,
    ord.payment_date,
    ord.parts_count,
    ord.total_area,
    mt.milling_type_name,
    et.edge_type_name,
    f.film_name,
    m.material_name,
    ord.notes,
    ord.link_cutting_file,
    ord.link_cutting_image_file,
    ord.ref_key_1c AS order_ref_key_1c,
    c.ref_key_1c AS client_ref_key_1c,
    ord.manager_id,
    ord.created_by,
    ord.edited_by,
    ord.created_at,
    ord.updated_at
FROM orders ord
CROSS JOIN LATERAL (
    VALUES (regexp_replace(COALESCE(ord.order_name, ''), '\D', '', 'g'))
) AS order_name_digits(value)
LEFT JOIN clients c ON ord.client_id = c.client_id
LEFT JOIN doweling_orders d ON ord.order_id = d.order_id
LEFT JOIN employees emd ON d.design_engineer_id = emd.employee_id
LEFT JOIN order_statuses os ON ord.order_status_id = os.order_status_id
LEFT JOIN payment_statuses ps ON ord.payment_status_id = ps.payment_status_id
LEFT JOIN production_statuses pr ON ord.production_status_id = pr.production_status_id
LEFT JOIN milling_types mt ON ord.milling_type_id = mt.milling_type_id
LEFT JOIN edge_types et ON ord.edge_type_id = et.edge_type_id
LEFT JOIN films f ON ord.film_id = f.film_id
LEFT JOIN materials m ON ord.material_id = m.material_id
WHERE ord.delete_flag = false
ORDER BY ord.order_id DESC;

COMMENT ON VIEW orders_view IS 'Агрегированное представление заказов с audit-полями для UI';
