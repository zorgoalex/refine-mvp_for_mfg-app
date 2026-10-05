-- Order resource procurement marks: «Закуплено» per order material.
-- Additive only: no backfill. Demand itself stays a live projection
-- (order details, HDF, ready cuts); this table stores only the purchase mark,
-- the demand snapshot seen at marking time, and an optimistic version.
-- Legacy order_resource_requirements is intentionally not reused.

CREATE TABLE IF NOT EXISTS public.order_resource_procurement (
  order_resource_procurement_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES public.orders(order_id),
  resource_kind VARCHAR(32) NOT NULL,
  sheet_material_type_id BIGINT NULL REFERENCES public.sheet_material_types(sheet_material_type_id),
  film_id BIGINT NULL REFERENCES public.films(film_id),
  purchased BOOLEAN NOT NULL DEFAULT false,
  origin VARCHAR(16) NULL,
  quantity_at_mark NUMERIC(14,3) NULL,
  unit_at_mark VARCHAR(8) NULL,
  demand_fingerprint_at_mark CHAR(64) NULL,
  marked_at TIMESTAMPTZ NULL,
  marked_by BIGINT NULL REFERENCES public.users(user_id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT NULL REFERENCES public.users(user_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT NULL REFERENCES public.users(user_id),
  CONSTRAINT chk_orp_resource_kind CHECK (resource_kind IN ('sheet_material', 'film')),
  CONSTRAINT chk_orp_one_ref CHECK (
    (resource_kind = 'sheet_material' AND sheet_material_type_id IS NOT NULL AND film_id IS NULL)
    OR (resource_kind = 'film' AND film_id IS NOT NULL AND sheet_material_type_id IS NULL)
  ),
  CONSTRAINT chk_orp_origin CHECK (origin IS NULL OR origin IN ('manual', 'onec')),
  CONSTRAINT chk_orp_unit CHECK (unit_at_mark IS NULL OR unit_at_mark IN ('m2', 'lm')),
  CONSTRAINT chk_orp_version CHECK (version >= 1),
  CONSTRAINT chk_orp_fingerprint CHECK (demand_fingerprint_at_mark IS NULL OR demand_fingerprint_at_mark ~ '^[0-9a-f]{64}$'),
  -- A purchased mark always carries who/when and the demand snapshot it confirmed.
  CONSTRAINT chk_orp_marked_snapshot CHECK (
    NOT purchased OR (marked_at IS NOT NULL AND origin IS NOT NULL AND demand_fingerprint_at_mark IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_orp_order_sheet_material
  ON public.order_resource_procurement(order_id, sheet_material_type_id)
  WHERE resource_kind = 'sheet_material';

CREATE UNIQUE INDEX IF NOT EXISTS uq_orp_order_film
  ON public.order_resource_procurement(order_id, film_id)
  WHERE resource_kind = 'film';

CREATE INDEX IF NOT EXISTS idx_orp_order
  ON public.order_resource_procurement(order_id);

COMMENT ON TABLE public.order_resource_procurement IS
  'Отметка «Закуплено» по материалу заказа. Потребность вычисляется на лету; здесь только отметка, снимок потребности при отметке и версия.';
COMMENT ON COLUMN public.order_resource_procurement.demand_fingerprint_at_mark IS
  'SHA-256 отпечаток потребности, которую пользователь видел при отметке; сравнивается с текущим для «потребность изменилась».';
