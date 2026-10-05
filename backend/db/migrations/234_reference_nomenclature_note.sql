-- Листовые материалы и «Товары и услуги»: те же поля, что у плёнок (202, 212) — тип и категория номенклатуры 1С и
-- примечание. Только новые NULL-колонки и ограничения длины; данные не меняются. Пишет только backend
-- (листовые материалы — PUT /sheet-material-types, товары — /catalog-items); Hasura читает листовые материалы через select «*».
ALTER TABLE public.sheet_material_types
  ADD COLUMN IF NOT EXISTS nomenclature_type VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS nomenclature_category VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS note TEXT NULL;

ALTER TABLE public.catalog_items
  ADD COLUMN IF NOT EXISTS nomenclature_type VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS nomenclature_category VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS note TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sheet_material_types'::regclass AND conname = 'chk_sheet_material_types_note_length'
  ) THEN
    ALTER TABLE public.sheet_material_types ADD CONSTRAINT chk_sheet_material_types_note_length CHECK (note IS NULL OR length(note) <= 2000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.catalog_items'::regclass AND conname = 'chk_catalog_items_note_length'
  ) THEN
    ALTER TABLE public.catalog_items ADD CONSTRAINT chk_catalog_items_note_length CHECK (note IS NULL OR length(note) <= 2000);
  END IF;
END $$;

COMMENT ON COLUMN public.sheet_material_types.nomenclature_type IS 'Тип номенклатуры 1С (Запас, Услуга…)';
COMMENT ON COLUMN public.sheet_material_types.nomenclature_category IS 'Категория номенклатуры 1С';
COMMENT ON COLUMN public.sheet_material_types.note IS 'Примечание (до 2000 символов)';
COMMENT ON COLUMN public.catalog_items.nomenclature_type IS 'Тип номенклатуры 1С (Запас, Услуга…)';
COMMENT ON COLUMN public.catalog_items.nomenclature_category IS 'Категория номенклатуры 1С';
COMMENT ON COLUMN public.catalog_items.note IS 'Примечание (до 2000 символов)';
