-- 028 Fix crm_sync_enqueue(): client writes must not reference NEW/OLD.order_id
--
-- Migration 025 used an inline `CASE v_entity WHEN 'client' THEN NEW.client_id
-- ELSE NEW.order_id END` to derive the aggregate id. PL/pgSQL resolves every
-- record-field reference in the expression at execution time, regardless of the
-- untaken CASE branch. When the trigger fires on `clients` (which has no
-- `order_id` column) this raises:
--   ERROR: record "new" has no field "order_id"
-- so ALL client INSERT/UPDATE/DELETE break once the trigger is enabled. Orders
-- writes were unaffected (the orders row has both columns).
--
-- Fix: branch with IF/ELSIF so each field is referenced ONLY inside the branch
-- that runs for the matching table (PL/pgSQL compiles a statement lazily on its
-- first execution, so the never-run branch is never resolved). This mirrors the
-- already-correct guarded clientId access. Payload/idempotency/coalesce
-- semantics are byte-for-byte identical to 025: client events still carry a
-- NULL clientId; order events still carry the order's client_id.
--
-- Idempotent: CREATE OR REPLACE only; no schema/table/trigger changes. The 025
-- triggers already point at this function, so replacing the body is sufficient.

CREATE OR REPLACE FUNCTION crm_sync_enqueue() RETURNS trigger AS $$
DECLARE
  v_entity TEXT := TG_ARGV[0];
  v_op TEXT;
  v_id TEXT;
  v_key TEXT;
  v_client_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_op := 'delete';
    IF v_entity = 'client' THEN
      v_id := OLD.client_id::text;
    ELSE
      v_id := OLD.order_id::text;
      -- carry clientId so the consumer can populate relatedClientId on hard-delete
      v_client_id := OLD.client_id::text;
    END IF;
  ELSE
    v_op := 'upsert';
    IF v_entity = 'client' THEN
      v_id := NEW.client_id::text;
    ELSE
      v_id := NEW.order_id::text;
      v_client_id := NEW.client_id::text;
    END IF;
  END IF;
  v_key := v_entity || ':' || v_id;
  -- coalesce: drop any still-pending event for this entity, then enqueue the latest.
  DELETE FROM crm_sync_outbox WHERE idempotency_key = v_key AND status = 'pending';
  INSERT INTO crm_sync_outbox (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
  VALUES ('crm.sync.' || v_entity || '.' || v_op, 'crm_sync', v_id,
          jsonb_build_object('entity', v_entity, 'id', v_id, 'op', v_op, 'clientId', v_client_id), v_key);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
