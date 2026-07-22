-- 073 Replace retired Twenty projection with Bitrix24 CRM sync.
--
-- Existing clients become individuals. New clients default to individuals.
-- Existing Twenty mapping IDs are invalid for Bitrix24 and are discarded once,
-- while the generic outbox is retained so pending ERP changes can converge.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS person_type TEXT NOT NULL DEFAULT 'individual';

UPDATE clients
SET person_type = 'individual'
WHERE person_type IS NULL OR person_type NOT IN ('individual', 'legal');

ALTER TABLE clients
  ALTER COLUMN person_type SET DEFAULT 'individual',
  ALTER COLUMN person_type SET NOT NULL;

ALTER TABLE clients
  DROP CONSTRAINT IF EXISTS chk_clients_person_type;

ALTER TABLE clients
  ADD CONSTRAINT chk_clients_person_type
  CHECK (person_type IN ('individual', 'legal'));

-- Rename the generic mapping columns and clear Twenty IDs only on the first
-- application. Re-running the migration does not erase valid Bitrix mappings.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'crm_sync_mapping'
      AND column_name = 'twenty_object'
  ) THEN
    DELETE FROM crm_sync_mapping;
    ALTER TABLE crm_sync_mapping RENAME COLUMN twenty_object TO bitrix_object;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'crm_sync_mapping'
      AND column_name = 'twenty_id'
  ) THEN
    ALTER TABLE crm_sync_mapping RENAME COLUMN twenty_id TO bitrix_id;
  END IF;
END;
$$;

ALTER TABLE crm_sync_mapping
  ADD COLUMN IF NOT EXISTS parent_erp_id TEXT;

ALTER TABLE crm_sync_mapping
  DROP CONSTRAINT IF EXISTS crm_sync_mapping_entity_type_check;

ALTER TABLE crm_sync_mapping
  ADD CONSTRAINT crm_sync_mapping_entity_type_check
  CHECK (entity_type IN ('client', 'order', 'payment'));

ALTER TABLE crm_sync_mapping
  DROP CONSTRAINT IF EXISTS uq_crm_sync_mapping_twenty;

ALTER TABLE crm_sync_mapping
  DROP CONSTRAINT IF EXISTS uq_crm_sync_mapping_bitrix;

ALTER TABLE crm_sync_mapping
  ADD CONSTRAINT uq_crm_sync_mapping_bitrix
  UNIQUE (entity_type, bitrix_object, bitrix_id);

CREATE INDEX IF NOT EXISTS idx_crm_sync_mapping_parent
  ON crm_sync_mapping (entity_type, parent_erp_id)
  WHERE parent_erp_id IS NOT NULL;

-- Phone mutations must refresh the owning Contact/Company.
CREATE OR REPLACE FUNCTION crm_sync_enqueue_client_phone() RETURNS trigger AS $$
DECLARE
  v_client_id TEXT;
  v_key TEXT;
BEGIN
  v_client_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.client_id::text
    ELSE NEW.client_id::text
  END;
  v_key := 'client:' || v_client_id;

  DELETE FROM crm_sync_outbox
  WHERE idempotency_key = v_key AND status = 'pending';

  INSERT INTO crm_sync_outbox (
    event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
  )
  VALUES (
    'crm.sync.client.upsert',
    'crm_sync',
    v_client_id,
    jsonb_build_object('entity', 'client', 'id', v_client_id, 'op', 'upsert'),
    v_key
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_crm_sync_client_phones ON client_phones;
CREATE TRIGGER trg_crm_sync_client_phones
AFTER INSERT OR UPDATE OR DELETE ON client_phones
FOR EACH ROW EXECUTE FUNCTION crm_sync_enqueue_client_phone();

-- A Contact↔Company type change also requires every deal to be relinked.
CREATE OR REPLACE FUNCTION crm_sync_enqueue_client_orders() RETURNS trigger AS $$
BEGIN
  IF OLD.person_type IS NOT DISTINCT FROM NEW.person_type THEN
    RETURN NULL;
  END IF;

  DELETE FROM crm_sync_outbox pending
  USING orders o
  WHERE o.client_id = NEW.client_id
    AND pending.idempotency_key = 'order:' || o.order_id::text
    AND pending.status = 'pending';

  INSERT INTO crm_sync_outbox (
    event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
  )
  SELECT
    'crm.sync.order.upsert',
    'crm_sync',
    o.order_id::text,
    jsonb_build_object(
      'entity', 'order',
      'id', o.order_id::text,
      'op', 'upsert',
      'clientId', o.client_id::text
    ),
    'order:' || o.order_id::text
  FROM orders o
  WHERE o.client_id = NEW.client_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_crm_sync_client_person_type_orders ON clients;
CREATE TRIGGER trg_crm_sync_client_person_type_orders
AFTER UPDATE OF person_type ON clients
FOR EACH ROW EXECUTE FUNCTION crm_sync_enqueue_client_orders();
