-- 260: notifications to the Bitrix24 deal owner about payment changes made in ERP
-- (plan 2026-10-19 erp-payment-notifications, R4).
--
-- The transaction that changes payments (order form, payment command, snapshot import) inserts one row per
-- affected order with a snapshot of safe fields (payload). The crm-sync worker delivers it as a deal timeline
-- comment and a system notification of the deal's responsible user. Both Bitrix24 calls create something and
-- are not idempotent, so the start of every attempt is committed before the HTTP call and an unknown outcome is
-- never repeated: the comment is looked up by its marker, the notification is given up.
--
-- The transaction's own order sync event is captured when it is enqueued: while the command's payment capture is
-- on (app.payment_audit_capture, migration 259) and the session table pg_temp.payment_notification_sync_event
-- exists (created by the backend that knows it), an AFTER INSERT trigger on crm_sync_outbox records the new
-- event id there. Without both it returns at once — the previous backend is unaffected.
--
-- Additive: a table, a function and a trigger. Rollback of the backend keeps them.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.crm_sync_payment_notification (
  notification_id            uuid PRIMARY KEY,
  erp_order_id               bigint NOT NULL CHECK (erp_order_id > 0),
  correlation_request_id     text,
  audit_ids                  uuid[] NOT NULL DEFAULT '{}',
  actor_user_id              bigint,
  -- The order's Bitrix24 sync event written by the same transaction (crm_sync_outbox), when it still was pending.
  sync_event_id              uuid,
  payload                    jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status                     text NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  skip_reason                text CHECK (skip_reason IN ('no_deal', 'expired_untouched')),
  -- The moment ERP decided the Bitrix24 payment sync is done (or gave up waiting: sync_incomplete).
  ready_at                   timestamptz,
  sync_incomplete            boolean NOT NULL DEFAULT false,
  bitrix_deal_id             text CHECK (bitrix_deal_id IS NULL OR bitrix_deal_id ~ '^[1-9][0-9]*$'),
  bitrix_user_id             text CHECK (bitrix_user_id IS NULL OR bitrix_user_id ~ '^[1-9][0-9]*$'),
  -- Timeline comment: 'attempting' = the call was started and its outcome is not recorded yet.
  comment_state              text NOT NULL DEFAULT 'none'
                               CHECK (comment_state IN ('none', 'attempting', 'created', 'unresolved', 'resolved', 'unknown', 'failed')),
  comment_attempt_started_at timestamptz,
  comment_attempts           integer NOT NULL DEFAULT 0 CHECK (comment_attempts >= 0),
  comment_next_at            timestamptz,
  comment_id                 text,
  -- System notification («колокольчик»).
  notify_state               text NOT NULL DEFAULT 'none'
                               CHECK (notify_state IN ('none', 'attempting', 'sent', 'unknown', 'no_scope', 'no_recipient', 'failed')),
  notify_attempt_started_at  timestamptz,
  notify_attempts            integer NOT NULL DEFAULT 0 CHECK (notify_attempts >= 0),
  notify_next_at             timestamptz,
  notified_at                timestamptz,
  -- Lease of one worker; every result write checks the token (fencing).
  lease_token                uuid,
  lease_until                timestamptz,
  attempts                   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error                 text,
  next_attempt_at            timestamptz NOT NULL DEFAULT now(),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  CONSTRAINT chk_crm_sync_payment_notification_completed
    CHECK ((status = 'pending') = (completed_at IS NULL)),
  CONSTRAINT chk_crm_sync_payment_notification_skip
    CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  CONSTRAINT chk_crm_sync_payment_notification_comment_id
    CHECK (comment_state NOT IN ('created', 'resolved') OR comment_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_crm_sync_payment_notification_due
  ON public.crm_sync_payment_notification (next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_crm_sync_payment_notification_order
  ON public.crm_sync_payment_notification (erp_order_id, created_at);

CREATE OR REPLACE FUNCTION public.payment_notification_capture_sync_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(current_setting('app.payment_audit_capture', true), '') <> 'on'
     OR to_regclass('pg_temp.payment_notification_sync_event') IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO pg_temp.payment_notification_sync_event (outbox_event_id, idempotency_key)
  VALUES (NEW.outbox_event_id, NEW.idempotency_key)
  ON CONFLICT (outbox_event_id) DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_sync_outbox_notification_capture ON public.crm_sync_outbox;
CREATE TRIGGER trg_crm_sync_outbox_notification_capture
  AFTER INSERT ON public.crm_sync_outbox
  FOR EACH ROW EXECUTE FUNCTION public.payment_notification_capture_sync_event();

COMMIT;
