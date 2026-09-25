-- Bitrix24 product-row import: explicit product mapping + per-request row
-- snapshots + request product readiness. Additive only: no backfill, no
-- automatic binding of existing data, no change to financial totals.

ALTER TABLE public.bitrix24_incoming_request
  ADD COLUMN IF NOT EXISTS product_sync_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS product_sync_error_code text,
  ADD COLUMN IF NOT EXISTS product_sync_blocked_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS product_rows_hash char(64),
  ADD COLUMN IF NOT EXISTS product_rows_total integer,
  ADD COLUMN IF NOT EXISTS product_order_fingerprint char(64),
  ADD COLUMN IF NOT EXISTS product_rows_synced_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_bitrix24_request_product_sync'
       AND conrelid = 'public.bitrix24_incoming_request'::regclass
  ) THEN
    ALTER TABLE public.bitrix24_incoming_request
      ADD CONSTRAINT chk_bitrix24_request_product_sync
      CHECK (
        product_sync_status IN ('pending', 'ready', 'blocked')
        AND (product_rows_hash IS NULL OR product_rows_hash ~ '^[0-9a-f]{64}$')
        AND (product_order_fingerprint IS NULL OR product_order_fingerprint ~ '^[0-9a-f]{64}$')
        AND (product_rows_total IS NULL OR product_rows_total >= 0)
        AND jsonb_typeof(product_sync_blocked_ids) = 'array'
      );
  END IF;
END $$;

-- Explicit Bitrix product ID -> ERP catalog item mapping. Names never bind;
-- mapping is created and changed only by an authorized administrator.
CREATE TABLE IF NOT EXISTS public.bitrix24_product_mapping (
  bitrix_product_id text PRIMARY KEY
    CHECK (bitrix_product_id ~ '^[1-9][0-9]*$'),
  catalog_item_id   bigint NOT NULL
    REFERENCES public.catalog_items(id) ON DELETE RESTRICT,
  active            boolean NOT NULL DEFAULT true,
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by        bigint REFERENCES public.users(user_id),
  updated_by        bigint REFERENCES public.users(user_id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per remote Bitrix product row ever seen on a CRM request. The remote
-- row identity is stable; a product may appear on several distinct rows.
-- unit_price stores the final Bitrix row price (already includes discounts and
-- taxes); discount/tax columns keep provenance only.
CREATE TABLE IF NOT EXISTS public.bitrix24_product_row_snapshot (
  request_id            bigint NOT NULL
    REFERENCES public.bitrix24_incoming_request(request_id) ON DELETE RESTRICT,
  bitrix_row_id         text NOT NULL CHECK (bitrix_row_id ~ '^[1-9][0-9]*$'),
  -- '0' marks a remote free-text custom row that can never be mapped.
  bitrix_product_id     text NOT NULL CHECK (bitrix_product_id ~ '^(0|[1-9][0-9]*)$'),
  product_name          text,
  sort                  integer,
  quantity              numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price            numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  line_total            numeric(14,2) NOT NULL CHECK (line_total >= 0),
  discount_type_id      integer,
  discount_rate         numeric(24,12),
  discount_sum          numeric(24,12),
  tax_rate              numeric(24,12),
  tax_included          text CHECK (tax_included IS NULL OR tax_included IN ('Y', 'N')),
  measure_code          integer,
  measure_name          text,
  raw_row               jsonb NOT NULL,
  normalized_hash       char(64) NOT NULL CHECK (normalized_hash ~ '^[0-9a-f]{64}$'),
  -- Observed remote membership: 'deleted' only mirrors the remote list.
  state                 text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleted')),
  -- Last applied ERP-side ownership state: which transitions the importer
  -- itself performed. Lets a reappearing remote row restore an importer-
  -- deleted line while a local user deletion of an applied line conflicts.
  applied_state         text NOT NULL DEFAULT 'pending'
    CHECK (applied_state IN ('pending', 'active', 'deleted')),
  catalog_item_id       bigint REFERENCES public.catalog_items(id) ON DELETE RESTRICT,
  catalog_version       integer CHECK (catalog_version IS NULL OR catalog_version > 0),
  order_line_id         bigint REFERENCES public.order_catalog_lines(id) ON DELETE RESTRICT,
  imported_fingerprint  char(64) CHECK (imported_fingerprint IS NULL OR imported_fingerprint ~ '^[0-9a-f]{64}$'),
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, bitrix_row_id)
);

CREATE INDEX IF NOT EXISTS idx_bitrix24_product_row_snapshot_product
  ON public.bitrix24_product_row_snapshot (bitrix_product_id)
  WHERE state = 'active';

-- One imported ERP catalog line is owned by at most one remote row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bitrix24_product_row_snapshot_line
  ON public.bitrix24_product_row_snapshot (order_line_id)
  WHERE order_line_id IS NOT NULL;

-- Payment-snapshot fetch fence: a reconcile reads the generation BEFORE the
-- remote payment list and applies only if the committed generation under the
-- Deal advisory lock still matches. Any snapshot mutation (replace, widget
-- snapshot save, materialization) bumps the generation so a delayed stale
-- fetch can never overwrite a newer state. Scope is the canonical Deal key.
CREATE TABLE IF NOT EXISTS public.bitrix24_payment_sync_gen (
  scope       text PRIMARY KEY CHECK (scope ~ '^deal:[1-9][0-9]*$'),
  gen         bigint NOT NULL DEFAULT 0 CHECK (gen >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
