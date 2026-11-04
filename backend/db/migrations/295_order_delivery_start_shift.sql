-- ERP → 1C business commands, phase 1, slice B (plan spec_erp/plans/1c-agent/2026-11-04-onec-business-commands-phase1-plan.md):
-- delivery of an order and the shift in which its production starts.
--   delivery_method  — 'courier' | 'pickup' (1C «СпособыДоставки»: Курьер / Самовывоз); NULL — not set.
--   delivery_address — free text (1C «АдресДоставки», a string), ≤ 500.
--   delivery_notes   — free text (1C «ДополнительнаяИнформацияПоДоставке»), ≤ 1000.
--   start_shift      — 1..3, the production start shift (1C state «N смена В производстве»); NULL — not set.
-- Nullable columns without defaults: the ADD is metadata-only; the CHECKs scan orders once (all rows NULL).
-- Written only by the backend save-order command (an absent key keeps the stored value); nothing else changes.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_method text,
  ADD COLUMN IF NOT EXISTS delivery_address text,
  ADD COLUMN IF NOT EXISTS delivery_notes text,
  ADD COLUMN IF NOT EXISTS start_shift smallint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orders'::regclass AND conname = 'chk_orders_delivery_method') THEN
    ALTER TABLE public.orders ADD CONSTRAINT chk_orders_delivery_method
      CHECK (delivery_method IS NULL OR delivery_method IN ('courier', 'pickup'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orders'::regclass AND conname = 'chk_orders_delivery_address_len') THEN
    ALTER TABLE public.orders ADD CONSTRAINT chk_orders_delivery_address_len
      CHECK (delivery_address IS NULL OR char_length(delivery_address) <= 500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orders'::regclass AND conname = 'chk_orders_delivery_notes_len') THEN
    ALTER TABLE public.orders ADD CONSTRAINT chk_orders_delivery_notes_len
      CHECK (delivery_notes IS NULL OR char_length(delivery_notes) <= 1000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.orders'::regclass AND conname = 'chk_orders_start_shift') THEN
    ALTER TABLE public.orders ADD CONSTRAINT chk_orders_start_shift
      CHECK (start_shift IS NULL OR start_shift BETWEEN 1 AND 3);
  END IF;
END $$;

COMMENT ON COLUMN public.orders.delivery_method IS 'courier | pickup (1C СпособыДоставки); written by the backend save-order command';
COMMENT ON COLUMN public.orders.start_shift IS 'Production start shift 1..3 (1C state «N смена В производстве»)';

COMMIT;
