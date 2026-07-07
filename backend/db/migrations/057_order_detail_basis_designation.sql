-- Add the Basis "Обозн." (designation) provenance field for order detail rows.
-- Basis PDF import now stores the PDF "Обозн." column here and the PDF
-- "Наименование" column in detail_name (previously both were packed into
-- detail_name as "position~~designation~~name").
ALTER TABLE order_details
  ADD COLUMN IF NOT EXISTS basis_designation TEXT NULL;

COMMENT ON COLUMN order_details.basis_designation IS 'Basis "Обозн." (designation) for the detail row, imported from Basis PDF';

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
    od.basis_data,
    od.basis_designation
FROM order_details od
JOIN orders ord
  ON ord.order_id = od.order_id AND ord.delete_flag = false
LEFT JOIN sheet_material_types smt
  ON smt.sheet_material_type_id = od.sheet_material_type_id
WHERE od.delete_flag = false;

COMMENT ON VIEW order_details_view IS 'Order details with material_name = sheet_material_types.name (Variant B, sheet-only)';
