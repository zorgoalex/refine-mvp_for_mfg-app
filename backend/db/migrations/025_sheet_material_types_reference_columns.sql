-- 025_sheet_material_types_reference_columns.sql
-- Additive: extend sheet_material_types into a full reference catalog (SP1).
-- Table is empty in all environments -> SET NOT NULL on unit_id is safe.
-- Rollback: ALTER TABLE ... DROP COLUMN for each column below + DROP the FK constraints.

ALTER TABLE sheet_material_types
  ADD COLUMN IF NOT EXISTS unit_id          SMALLINT,
  ADD COLUMN IF NOT EXISTS supplier_id      SMALLINT,
  ADD COLUMN IF NOT EXISTS vendor_id        SMALLINT,
  ADD COLUMN IF NOT EXISTS supplier_article VARCHAR(200),
  ADD COLUMN IF NOT EXISTS texture          BOOLEAN,
  ADD COLUMN IF NOT EXISTS color            VARCHAR(100);

-- unit_id is mandatory; table empty -> enforce NOT NULL in the same migration.
ALTER TABLE sheet_material_types ALTER COLUMN unit_id SET NOT NULL;

ALTER TABLE sheet_material_types
  ADD CONSTRAINT fk_sheet_material_types_unit
    FOREIGN KEY (unit_id) REFERENCES units(unit_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT fk_sheet_material_types_supplier
    FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  ADD CONSTRAINT fk_sheet_material_types_vendor
    FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id)
    ON UPDATE CASCADE ON DELETE SET NULL;
