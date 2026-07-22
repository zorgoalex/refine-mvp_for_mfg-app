-- 074 Close the remaining Bitrix24 delivery gaps.
--
-- 1. Every payment mutation enqueues its owning order, including both sides of
--    a payment move.
-- 2. A durable pre-create snapshot prevents retrying an ambiguous native
--    Bitrix payment create.
-- 3. A global lease serializes live relay/backfill writers across processes.

CREATE TABLE IF NOT EXISTS crm_sync_payment_create_guard (
  erp_payment_id TEXT PRIMARY KEY,
  erp_order_id   TEXT NOT NULL,
  bitrix_deal_id TEXT NOT NULL,
  before_ids     JSONB NOT NULL CHECK (jsonb_typeof(before_ids) = 'array'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_sync_writer_lock (
  lock_name   TEXT PRIMARY KEY,
  lock_token  TEXT NOT NULL,
  locked_at   TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION crm_sync_enqueue_order_id(p_order_id BIGINT) RETURNS void AS $$
DECLARE
  v_order_id TEXT := p_order_id::text;
  v_client_id TEXT;
  v_key TEXT := 'order:' || p_order_id::text;
BEGIN
  SELECT client_id::text
    INTO v_client_id
    FROM orders
   WHERE order_id = p_order_id;

  -- An order hard-delete already has its own OLD-row trigger event.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  DELETE FROM crm_sync_outbox
   WHERE idempotency_key = v_key
     AND status = 'pending';

  INSERT INTO crm_sync_outbox (
    event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
  )
  VALUES (
    'crm.sync.order.upsert',
    'crm_sync',
    v_order_id,
    jsonb_build_object(
      'entity', 'order',
      'id', v_order_id,
      'op', 'upsert',
      'clientId', v_client_id
    ),
    v_key
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION crm_sync_enqueue_payment_order() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM crm_sync_enqueue_order_id(OLD.order_id);
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.order_id IS DISTINCT FROM NEW.order_id THEN
    PERFORM crm_sync_enqueue_order_id(OLD.order_id);
  END IF;

  PERFORM crm_sync_enqueue_order_id(NEW.order_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_crm_sync_payments ON payments;
CREATE TRIGGER trg_crm_sync_payments
AFTER INSERT OR UPDATE OR DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION crm_sync_enqueue_payment_order();
