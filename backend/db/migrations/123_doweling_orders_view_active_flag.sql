BEGIN;

CREATE OR REPLACE VIEW doweling_orders_view AS
SELECT
    d.doweling_order_id,
    d.doweling_order_name,
    ord.order_id,
    ord.order_name,
    ord.client_id,
    c.client_name,
    d.doweling_order_date,
    ps.payment_status_name,
    pr.production_status_name,
    d.issue_date,
    d.total_amount,
    d.final_amount,
    d.discount,
    d.surcharge,
    d.paid_amount,
    d.payment_date,
    d.parts_count,
    mt.milling_type_name,
    et.edge_type_name,
    smt.name AS material_name,
    d.design_engineer_id,
    emd.full_name AS design_engineer,
    d.operator_id,
    emo.full_name AS operator,
    d.link_cad_file,
    d.link_pdf_file,
    d.version,
    d.ref_key_1c AS order_ref_key_1c,
    c.ref_key_1c AS client_ref_key_1c,
    d.created_by,
    d.edited_by,
    d.created_at,
    d.updated_at,
    d.delete_flag
FROM doweling_orders d
LEFT JOIN order_doweling_links odl
       ON d.doweling_order_id = odl.doweling_order_id
      AND odl.delete_flag = false
LEFT JOIN orders ord
       ON odl.order_id = ord.order_id
      AND ord.delete_flag = false
LEFT JOIN clients c ON ord.client_id = c.client_id
LEFT JOIN payment_statuses ps ON d.payment_status_id = ps.payment_status_id
LEFT JOIN production_statuses pr ON d.production_status_id = pr.production_status_id
LEFT JOIN milling_types mt ON ord.milling_type_id = mt.milling_type_id
LEFT JOIN edge_types et ON ord.edge_type_id = et.edge_type_id
LEFT JOIN sheet_material_types smt ON ord.sheet_material_type_id = smt.sheet_material_type_id
LEFT JOIN employees emd ON d.design_engineer_id = emd.employee_id
LEFT JOIN employees emo ON d.operator_id = emo.employee_id
ORDER BY d.doweling_order_id DESC;

COMMENT ON VIEW doweling_orders_view IS
  'Агрегированное представление присадок с активностью записи и только активными связями с заказами для UI';

COMMIT;
