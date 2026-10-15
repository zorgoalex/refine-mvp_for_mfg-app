-- 255: durable operations for changing or deleting an ERP payment that Bitrix24 holds as «Оплачено».
--
-- ERP creates its payments in Bitrix24 with paid=Y. Bitrix24 refuses to change the amount of a paid
-- payment and to delete it. ERP is authoritative for payments, so the sync removes the paid flag,
-- applies the change (or deletes the payment) and sets the flag back. Every phase is committed here
-- BEFORE the next Bitrix24 call, so a crash, a lost response or a lost lease never leaves a payment
-- without its flag: recovery continues from the observed Bitrix24 state.
--
-- Additive: a new table only; the running backend does not read it. Rollback of the backend keeps it.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.crm_sync_paid_payment_operation (
  operation_id           uuid PRIMARY KEY,
  erp_payment_id         bigint NOT NULL CHECK (erp_payment_id > 0),
  erp_order_id           bigint NOT NULL CHECK (erp_order_id > 0),
  bitrix_payment_id      text NOT NULL CHECK (bitrix_payment_id ~ '^[1-9][0-9]*$'),
  bitrix_deal_id         text CHECK (bitrix_deal_id IS NULL OR bitrix_deal_id ~ '^[1-9][0-9]*$'),
  action                 text NOT NULL CHECK (action IN ('update', 'delete')),
  phase                  text NOT NULL DEFAULT 'requested'
                           CHECK (phase IN ('requested', 'unpaid', 'completed')),
  remote_outcome         text CHECK (remote_outcome IN ('applied', 'deleted', 'remote_missing')),
  bitrix_sum_before      numeric(18,2),
  bitrix_currency        text,
  target_sum             numeric(18,2),
  origin_outbox_event_id uuid,
  attempts               integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error             text,
  next_attempt_at        timestamptz NOT NULL DEFAULT now(),
  stuck_at               timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,
  CONSTRAINT chk_crm_sync_paid_payment_operation_completed
    CHECK ((phase = 'completed') = (completed_at IS NOT NULL AND remote_outcome IS NOT NULL)),
  CONSTRAINT chk_crm_sync_paid_payment_operation_stuck
    CHECK (stuck_at IS NULL OR phase <> 'completed')
);

-- One open operation per ERP payment.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_sync_paid_payment_operation_open
  ON public.crm_sync_paid_payment_operation (erp_payment_id)
  WHERE phase <> 'completed';

CREATE INDEX IF NOT EXISTS idx_crm_sync_paid_payment_operation_due
  ON public.crm_sync_paid_payment_operation (next_attempt_at)
  WHERE phase <> 'completed';

CREATE INDEX IF NOT EXISTS idx_crm_sync_paid_payment_operation_order
  ON public.crm_sync_paid_payment_operation (erp_order_id, created_at);

COMMIT;
