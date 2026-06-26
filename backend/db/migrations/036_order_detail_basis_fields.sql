-- Add Basis import/provenance fields for order detail rows.
ALTER TABLE order_details
  ADD COLUMN IF NOT EXISTS basis_project TEXT NULL,
  ADD COLUMN IF NOT EXISTS basis_data TEXT NULL;

COMMENT ON COLUMN order_details.basis_project IS 'Basis project/source identifier for the detail row';
COMMENT ON COLUMN order_details.basis_data IS 'Basis source data for the detail row';

CREATE OR REPLACE VIEW order_details_view AS
SELECT
    od.detail_id,
    od.order_id,
    od.detail_number,
    od.detail_name,
    od.height,
    od.width,
    od.quantity,
    od.area,
    od.material_id,
    od.sheet_material_type_id,
    smt.name AS material_name,
    od.milling_type_id,
    od.edge_type_id,
    od.film_id,
    od.milling_cost_per_sqm,
    od.detail_cost,
    od.priority,
    od.production_status_id,
    od.joint_order_id,
    od.note,
    od.link_cutting_file,
    od.link_cutting_image_file,
    od.link_cad_file,
    od.link_pdf_file,
    od.ref_key_1c,
    od.basis_project,
    od.basis_data
FROM order_details od
JOIN orders ord
  ON ord.order_id = od.order_id AND ord.delete_flag = false
LEFT JOIN sheet_material_types smt
  ON smt.sheet_material_type_id = od.sheet_material_type_id
WHERE od.delete_flag = false;

COMMENT ON VIEW order_details_view IS 'Order details with material_name = sheet_material_types.name (Variant B, sheet-only)';
