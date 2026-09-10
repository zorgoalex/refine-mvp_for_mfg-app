-- Standalone sales catalogue. No changes to manufacturing details or money.
CREATE TABLE IF NOT EXISTS public.catalog_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  name varchar(200) NOT NULL CHECK (name = btrim(name) AND length(name) > 0),
  sku varchar(80) CHECK (sku IS NULL OR (sku = btrim(sku) AND length(sku) > 0)),
  kind text NOT NULL CHECK (kind IN ('made_to_order', 'stock_item', 'service')),
  unit_id smallint NOT NULL REFERENCES public.units(unit_id) ON DELETE RESTRICT,
  base_price numeric(12,2) CHECK (base_price >= 0 AND base_price <> 'NaN'::numeric),
  currency text NOT NULL DEFAULT 'KZT' CHECK (currency = 'KZT'),
  description varchar(2000) NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by bigint NOT NULL REFERENCES public.users(user_id) ON DELETE RESTRICT,
  edited_by bigint NOT NULL REFERENCES public.users(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_sku_unique ON public.catalog_items (lower(sku)) WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS catalog_items_list_idx ON public.catalog_items (is_active, name, id);

CREATE TABLE IF NOT EXISTS public.catalog_item_commands (
  idempotency_key varchar(200) PRIMARY KEY CHECK (length(idempotency_key) >= 8),
  request_hash text NOT NULL,
  actor_user_id bigint NOT NULL REFERENCES public.users(user_id) ON DELETE RESTRICT,
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.catalog_items IS 'Sales goods/services reference; base price never recalculates existing orders';
COMMENT ON TABLE public.catalog_item_commands IS 'Committed command receipts; retained for idempotent retries, not exposed via API';
