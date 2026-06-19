-- 025 Twenty CRM one-way sync (additive)

CREATE TABLE IF NOT EXISTS crm_sync_mapping (
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('client','order')),
  erp_id        TEXT NOT NULL,
  twenty_object TEXT NOT NULL,
  twenty_id     TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_hash     TEXT,
  last_error    TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_crm_sync_mapping PRIMARY KEY (entity_type, erp_id),
  CONSTRAINT uq_crm_sync_mapping_twenty UNIQUE (entity_type, twenty_id)
);

CREATE TABLE IF NOT EXISTS crm_sync_outbox (
  outbox_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      TEXT NOT NULL,
  aggregate_type  TEXT NOT NULL,
  aggregate_id    TEXT NOT NULL,
  payload_json    JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at       TIMESTAMPTZ,
  locked_by       TEXT,
  lock_token      TEXT,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  CONSTRAINT chk_crm_sync_outbox_status CHECK (status IN ('pending','processing','processed','failed'))
);
-- pending-claim index mirrors the live outbox shape
CREATE INDEX IF NOT EXISTS idx_crm_sync_outbox_pending
  ON crm_sync_outbox (next_attempt_at, created_at) WHERE status = 'pending';
-- non-unique index supporting the coalesce DELETE below (NOT unique: a unique
-- pending index would make markRetry's processing->pending transition collide
-- with a newer pending row for the same key)
CREATE INDEX IF NOT EXISTS idx_crm_sync_outbox_key_pending
  ON crm_sync_outbox (idempotency_key) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION crm_sync_enqueue() RETURNS trigger AS $$
DECLARE
  v_entity TEXT := TG_ARGV[0];
  v_op TEXT;
  v_id TEXT;
  v_key TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_op := 'delete'; v_id := (CASE v_entity WHEN 'client' THEN OLD.client_id ELSE OLD.order_id END)::text;
  ELSE
    v_op := 'upsert'; v_id := (CASE v_entity WHEN 'client' THEN NEW.client_id ELSE NEW.order_id END)::text;
  END IF;
  v_key := v_entity || ':' || v_id;
  -- coalesce: drop any still-pending event for this entity, then enqueue the latest.
  -- No unique constraint, so a concurrent markRetry (processing->pending) never conflicts;
  -- a transient second pending row is harmless because the consumer re-reads current
  -- state and the change-hash makes the redundant one a no-op.
  DELETE FROM crm_sync_outbox WHERE idempotency_key = v_key AND status = 'pending';
  INSERT INTO crm_sync_outbox (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
  VALUES ('crm.sync.' || v_entity || '.' || v_op, 'crm_sync', v_id,
          jsonb_build_object('entity', v_entity, 'id', v_id, 'op', v_op), v_key);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_crm_sync_clients ON clients;
CREATE TRIGGER trg_crm_sync_clients AFTER INSERT OR UPDATE OR DELETE ON clients
  FOR EACH ROW EXECUTE FUNCTION crm_sync_enqueue('client');
DROP TRIGGER IF EXISTS trg_crm_sync_orders ON orders;
CREATE TRIGGER trg_crm_sync_orders AFTER INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION crm_sync_enqueue('order');
