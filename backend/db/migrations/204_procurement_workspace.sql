-- Procurement workspace, phase 1 (plan spec_erp/plans/order_resource_req/
-- 2026-09-28-procurement-workspace-plan.md §4.1, §4.3, §5.2, §5.9).
--
-- 1. procurement_settings — singleton, edited on the «Конфигурация» screen:
--    «нужно к» lead days, urgency thresholds, trim allowance, digest settings.
-- 2. resource_suppliers — every supplier a material was received from. Rows
--    are only ever inserted (ON CONFLICT DO NOTHING): the first recorded
--    supplier stays first, later suppliers are added, never overwrite.
-- 3. user_preferences.procurement_saved_views — per-user saved worklist views.
-- 4. One-time fix of order_resource_procurement.origin: a mark set by a 1C
--    receipt allocation was written as 'manual'; it is 'onec' from now on. The
--    source of the CURRENT mark is taken from the audit event that set it.
--    Rollout boundary (plan §4.1): BACKEND_RESOURCE_PROCUREMENT_ENABLED is off
--    while this runs, so no old writer can add another 'manual' receipt mark.

CREATE TABLE IF NOT EXISTS public.procurement_settings (
  config_id SMALLINT PRIMARY KEY DEFAULT 1,
  lead_days INTEGER NOT NULL DEFAULT 2,
  critical_days INTEGER NOT NULL DEFAULT 3,
  soon_days INTEGER NOT NULL DEFAULT 7,
  waste_percent NUMERIC(5,2) NOT NULL DEFAULT 5,
  digest_time TIME NOT NULL DEFAULT '08:30',
  unallocated_alert_days INTEGER NOT NULL DEFAULT 2,
  -- Рабочий список: просроченные заказы не старше N дней (старые незакрытые — через поиск / «нужно к: с»).
  overdue_window_days INTEGER NOT NULL DEFAULT 30,
  version BIGINT NOT NULL DEFAULT 1,
  updated_by_user_id BIGINT NULL REFERENCES public.users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_procurement_settings_singleton CHECK (config_id = 1),
  CONSTRAINT chk_procurement_settings_lead_days CHECK (lead_days BETWEEN 0 AND 60),
  CONSTRAINT chk_procurement_settings_urgency CHECK (critical_days >= 0 AND critical_days <= soon_days AND soon_days <= 60),
  CONSTRAINT chk_procurement_settings_waste CHECK (waste_percent >= 0 AND waste_percent <= 50),
  CONSTRAINT chk_procurement_settings_unallocated CHECK (unallocated_alert_days BETWEEN 1 AND 30),
  CONSTRAINT chk_procurement_settings_overdue_window CHECK (overdue_window_days BETWEEN 1 AND 365),
  CONSTRAINT chk_procurement_settings_version CHECK (version > 0)
);

INSERT INTO public.procurement_settings (config_id) VALUES (1)
ON CONFLICT (config_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.resource_suppliers (
  resource_supplier_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_kind VARCHAR(32) NOT NULL,
  sheet_material_type_id BIGINT NULL REFERENCES public.sheet_material_types(sheet_material_type_id),
  film_id BIGINT NULL REFERENCES public.films(film_id),
  supplier_key TEXT NOT NULL,
  supplier_id BIGINT NULL REFERENCES public.suppliers(supplier_id),
  counterparty_name TEXT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_onec_document_id BIGINT NULL REFERENCES public.onec_documents(onec_document_id),
  source VARCHAR(16) NOT NULL,
  CONSTRAINT chk_resource_suppliers_kind CHECK (resource_kind IN ('sheet_material', 'film')),
  CONSTRAINT chk_resource_suppliers_one_ref CHECK (
    (resource_kind = 'sheet_material' AND sheet_material_type_id IS NOT NULL AND film_id IS NULL)
    OR (resource_kind = 'film' AND film_id IS NOT NULL AND sheet_material_type_id IS NULL)
  ),
  -- s:<suppliers.supplier_id> | c:<1C counterparty ref key> | n:<md5(lower(btrim(counterparty name)))>
  -- (fixed-length: any counterparty name from 1C fits, the same key in backfill and runtime)
  CONSTRAINT chk_resource_suppliers_key CHECK (supplier_key ~ '^[scn]:.+$' AND length(supplier_key) <= 300),
  CONSTRAINT chk_resource_suppliers_source CHECK (source IN ('onec_receipt', 'manual'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_suppliers_sheet_material
  ON public.resource_suppliers(sheet_material_type_id, supplier_key)
  WHERE resource_kind = 'sheet_material';

CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_suppliers_film
  ON public.resource_suppliers(film_id, supplier_key)
  WHERE resource_kind = 'film';

-- Backfill from receipts already allocated (active or removed: the supplier did
-- deliver this material). Earliest document first; conflicts keep the first row.
INSERT INTO public.resource_suppliers (
  resource_kind, sheet_material_type_id, film_id, supplier_key, supplier_id,
  counterparty_name, first_seen_at, first_onec_document_id, source
)
SELECT kind, sheet_material_type_id, film_id, supplier_key, supplier_id,
       counterparty_name, first_seen_at, onec_document_id, 'onec_receipt'
  FROM (
    SELECT DISTINCT ON (orp.resource_kind, orp.sheet_material_type_id, orp.film_id, k.supplier_key)
           orp.resource_kind AS kind, orp.sheet_material_type_id, orp.film_id, k.supplier_key,
           d.supplier_id, NULLIF(btrim(d.counterparty_name), '') AS counterparty_name,
           a.created_at AS first_seen_at, d.onec_document_id
      FROM public.order_resource_onec_allocations a
      JOIN public.order_resource_procurement orp
        ON orp.order_resource_procurement_id = a.order_resource_procurement_id
      JOIN public.onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
      JOIN public.onec_documents d ON d.onec_document_id = l.onec_document_id
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN d.supplier_id IS NOT NULL THEN 's:' || d.supplier_id
                 WHEN d.counterparty_ref_key IS NOT NULL THEN 'c:' || d.counterparty_ref_key
                 WHEN NULLIF(btrim(d.counterparty_name), '') IS NOT NULL THEN 'n:' || md5(lower(btrim(d.counterparty_name)))
               END AS supplier_key
      ) k
     WHERE a.role = 'receipt'
       AND k.supplier_key IS NOT NULL
     ORDER BY orp.resource_kind, orp.sheet_material_type_id, orp.film_id, k.supplier_key,
              a.created_at, a.allocation_id
  ) first_receipts
 ORDER BY first_seen_at
ON CONFLICT DO NOTHING;

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS procurement_saved_views JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.user_preferences'::regclass
       AND conname = 'chk_user_preferences_procurement_saved_views'
  ) THEN
    ALTER TABLE public.user_preferences
      ADD CONSTRAINT chk_user_preferences_procurement_saved_views CHECK (
        jsonb_typeof(procurement_saved_views) = 'array'
        AND jsonb_array_length(procurement_saved_views) <= 20
      );
  END IF;
END $$;

-- The mark-setting event: purchased false -> true. before_json is NULL when the
-- first receipt itself creates the procurement row. Manual commands carry
-- metadata_json.commandSource; receipt allocations carry procurementId + role.
-- The latest such event not after marked_at decides; payments never count.
UPDATE public.order_resource_procurement orp
   SET origin = 'onec'
 WHERE orp.purchased
   AND orp.origin = 'manual'
   AND (
     SELECT CASE WHEN ev.event = 'order_resource.onec_allocation_added' THEN 'onec' ELSE 'manual' END
       FROM public.audit_log ev
      WHERE ev.after_json->>'purchased' = 'true'
        AND (ev.before_json IS NULL OR ev.before_json->>'purchased' = 'false')
        AND ev.created_at <= orp.marked_at
        AND (
          (ev.event = 'order_resource.procurement_marked'
            AND ev.entity_type = 'order_resource_procurement'
            AND ev.entity_id = orp.order_resource_procurement_id::text
            AND ev.metadata_json->>'commandSource' IN ('erp_ui', 'erp_bulk'))
          OR (ev.event = 'order_resource.onec_allocation_added'
            AND ev.entity_type = 'order_resource_onec_allocation'
            AND ev.metadata_json->>'procurementId' = orp.order_resource_procurement_id::text
            AND ev.metadata_json->>'role' = 'receipt')
        )
      ORDER BY ev.created_at DESC, ev.audit_id DESC
      LIMIT 1
   ) = 'onec';

COMMENT ON TABLE public.procurement_settings IS
  'Настройки экрана снабжения (singleton): «нужно к» = плановая дата − lead_days рабочих дней, пороги срочности, запас на обрезки, сводка. Правка — экран «Конфигурация».';
COMMENT ON TABLE public.resource_suppliers IS
  'Поставщики, от которых приходил материал. Только вставка (ON CONFLICT DO NOTHING): первый записанный поставщик не затирается последующими.';
