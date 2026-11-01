-- Поставщики (несколько) и производитель у плёнок, листовых материалов и доп. ресурсов.
-- 1) material_suppliers — список поставщиков позиции, выбранный человеком (журнал 1С resource_suppliers не меняется):
--    плёнки и доп. ресурсы — весь список (position 1 = основной); листовые — только ДОПОЛНИТЕЛЬНЫЕ,
--    основной листового остаётся в sheet_material_types.supplier_id (его же пишут прежние версии backend).
--    Пишет только backend; Hasura таблицу не видит.
-- 2) extra_resources.vendor_id — производитель доп. ресурса.
-- Аддитивная: прежний backend с этой схемой работает; откатывать не нужно.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.material_suppliers (
  material_supplier_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_kind VARCHAR(32) NOT NULL,
  film_id BIGINT NULL REFERENCES public.films(film_id) ON DELETE CASCADE,
  sheet_material_type_id BIGINT NULL REFERENCES public.sheet_material_types(sheet_material_type_id) ON DELETE CASCADE,
  extra_resource_id BIGINT NULL REFERENCES public.extra_resources(extra_resource_id) ON DELETE CASCADE,
  supplier_id SMALLINT NOT NULL REFERENCES public.suppliers(supplier_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  position SMALLINT NOT NULL,
  created_by BIGINT NULL REFERENCES public.users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_material_suppliers_kind CHECK (resource_kind IN ('film', 'sheet_material', 'extra_resource')),
  CONSTRAINT chk_material_suppliers_one_ref CHECK (
    (resource_kind = 'film' AND film_id IS NOT NULL AND sheet_material_type_id IS NULL AND extra_resource_id IS NULL)
    OR (resource_kind = 'sheet_material' AND sheet_material_type_id IS NOT NULL AND film_id IS NULL AND extra_resource_id IS NULL)
    OR (resource_kind = 'extra_resource' AND extra_resource_id IS NOT NULL AND film_id IS NULL AND sheet_material_type_id IS NULL)
  ),
  CONSTRAINT chk_material_suppliers_position CHECK (position BETWEEN 1 AND 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_material_suppliers_film_supplier
  ON public.material_suppliers(film_id, supplier_id) WHERE resource_kind = 'film';
CREATE UNIQUE INDEX IF NOT EXISTS uq_material_suppliers_film_position
  ON public.material_suppliers(film_id, position) WHERE resource_kind = 'film';
CREATE UNIQUE INDEX IF NOT EXISTS uq_material_suppliers_sheet_supplier
  ON public.material_suppliers(sheet_material_type_id, supplier_id) WHERE resource_kind = 'sheet_material';
CREATE UNIQUE INDEX IF NOT EXISTS uq_material_suppliers_sheet_position
  ON public.material_suppliers(sheet_material_type_id, position) WHERE resource_kind = 'sheet_material';
CREATE UNIQUE INDEX IF NOT EXISTS uq_material_suppliers_extra_supplier
  ON public.material_suppliers(extra_resource_id, supplier_id) WHERE resource_kind = 'extra_resource';
CREATE UNIQUE INDEX IF NOT EXISTS uq_material_suppliers_extra_position
  ON public.material_suppliers(extra_resource_id, position) WHERE resource_kind = 'extra_resource';
CREATE INDEX IF NOT EXISTS idx_material_suppliers_supplier ON public.material_suppliers(supplier_id);

COMMENT ON TABLE public.material_suppliers IS
  'Поставщики позиции, выбранные человеком. film/extra_resource — весь список (position 1 = основной); sheet_material — только дополнительные, основной в sheet_material_types.supplier_id. Пишет только backend.';

ALTER TABLE public.extra_resources
  ADD COLUMN IF NOT EXISTS vendor_id SMALLINT NULL REFERENCES public.vendors(vendor_id) ON UPDATE CASCADE ON DELETE RESTRICT;

COMMIT;
