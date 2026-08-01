-- 095 Bitrix24 -> ERP reverse synchronization foundation.
--
-- Additive only. Reverse workers remain disabled by default. Existing
-- ERP -> Bitrix24 mappings keep source_system='erp'.

ALTER TABLE crm_sync_mapping
  ADD COLUMN IF NOT EXISTS source_system TEXT NOT NULL DEFAULT 'erp',
  ADD COLUMN IF NOT EXISTS last_bitrix_hash TEXT,
  ADD COLUMN IF NOT EXISTS last_bitrix_updated_at TIMESTAMPTZ;

ALTER TABLE crm_sync_mapping
  DROP CONSTRAINT IF EXISTS chk_crm_sync_mapping_source_system;

ALTER TABLE crm_sync_mapping
  ADD CONSTRAINT chk_crm_sync_mapping_source_system
  CHECK (source_system IN ('erp', 'bitrix24'));

CREATE TABLE IF NOT EXISTS bitrix24_app_installation (
  member_id                 TEXT PRIMARY KEY,
  domain                    TEXT NOT NULL,
  access_token_ciphertext   TEXT NOT NULL,
  refresh_token_ciphertext  TEXT NOT NULL,
  access_token_expires_at   TIMESTAMPTZ NOT NULL,
  application_token_hash    TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'refresh_failed', 'revoked')),
  installed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  refreshed_at              TIMESTAMPTZ,
  refresh_next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  refresh_locked_at         TIMESTAMPTZ,
  refresh_lock_token        UUID,
  last_error                TEXT,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bitrix24_installation_domain
    CHECK (domain = lower(domain) AND domain !~ '[/[:space:]]'),
  CONSTRAINT chk_bitrix24_installation_app_token_hash
    CHECK (application_token_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS bitrix24_inbound_event (
  inbound_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        TEXT NOT NULL REFERENCES bitrix24_app_installation(member_id),
  event_name       TEXT NOT NULL,
  object_type      TEXT NOT NULL
                     CHECK (object_type IN ('contact', 'company', 'deal')),
  bitrix_id        TEXT NOT NULL CHECK (bitrix_id ~ '^[1-9][0-9]*$'),
  event_ts         TIMESTAMPTZ NOT NULL,
  payload_json     JSONB NOT NULL,
  fingerprint      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at        TIMESTAMPTZ,
  locked_by        TEXT,
  lock_token       TEXT,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,
  CONSTRAINT uq_bitrix24_inbound_event_fingerprint UNIQUE (member_id, fingerprint),
  CONSTRAINT chk_bitrix24_inbound_event_payload_size
    CHECK (octet_length(payload_json::text) <= 262144)
);

CREATE INDEX IF NOT EXISTS idx_bitrix24_inbound_event_pending
  ON bitrix24_inbound_event (next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE UNIQUE INDEX IF NOT EXISTS uq_bitrix24_inbound_event_open_object
  ON bitrix24_inbound_event (member_id, object_type, bitrix_id)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_bitrix24_inbound_event_object
  ON bitrix24_inbound_event (member_id, object_type, bitrix_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bitrix24_reconcile_cursor (
  scope               TEXT PRIMARY KEY CHECK (scope IN ('deal_payments')),
  last_bitrix_id      BIGINT NOT NULL DEFAULT 0 CHECK (last_bitrix_id >= 0),
  cycle_id            UUID NOT NULL DEFAULT gen_random_uuid(),
  next_cycle_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_cycle_at       TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO bitrix24_reconcile_cursor (scope)
VALUES ('deal_payments')
ON CONFLICT (scope) DO NOTHING;

CREATE TABLE IF NOT EXISTS bitrix24_remote_state (
  object_type       TEXT NOT NULL
                      CHECK (object_type IN ('contact', 'company', 'deal')),
  bitrix_id         TEXT NOT NULL CHECK (bitrix_id ~ '^[1-9][0-9]*$'),
  erp_entity_type   TEXT CHECK (erp_entity_type IN ('client', 'order')),
  erp_id            TEXT,
  normalized_hash   TEXT NOT NULL,
  title             TEXT,
  crm_amount        NUMERIC(18,2),
  currency_id       TEXT,
  stage_id          TEXT,
  assigned_by_id    TEXT,
  begin_date        DATE,
  close_date        DATE,
  comments          TEXT,
  bitrix_created_at TIMESTAMPTZ,
  bitrix_updated_at TIMESTAMPTZ,
  raw_snapshot      JSONB NOT NULL,
  last_fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_applied_at   TIMESTAMPTZ,
  PRIMARY KEY (object_type, bitrix_id),
  CONSTRAINT chk_bitrix24_remote_state_erp_pair
    CHECK ((erp_entity_type IS NULL) = (erp_id IS NULL)),
  CONSTRAINT chk_bitrix24_remote_state_snapshot_size
    CHECK (octet_length(raw_snapshot::text) <= 262144)
);

CREATE INDEX IF NOT EXISTS idx_bitrix24_remote_state_erp
  ON bitrix24_remote_state (erp_entity_type, erp_id)
  WHERE erp_entity_type IS NOT NULL;

CREATE TABLE IF NOT EXISTS bitrix24_incoming_request (
  request_id         BIGSERIAL PRIMARY KEY,
  bitrix_deal_id     TEXT NOT NULL UNIQUE CHECK (bitrix_deal_id ~ '^[1-9][0-9]*$'),
  client_id          INTEGER REFERENCES clients(client_id),
  title              TEXT NOT NULL,
  crm_amount         NUMERIC(18,2),
  currency_id        TEXT,
  stage_id           TEXT,
  stage_name         TEXT,
  assigned_by_id     TEXT,
  assigned_by_name   TEXT,
  begin_date         DATE,
  close_date         DATE,
  comments           TEXT,
  bitrix_url         TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'new'
                       CHECK (state IN ('new', 'converted', 'archived')),
  linked_order_id    BIGINT REFERENCES orders(order_id),
  bitrix_created_at  TIMESTAMPTZ,
  bitrix_updated_at  TIMESTAMPTZ,
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bitrix24_incoming_request_conversion
    CHECK (
      (state = 'converted' AND linked_order_id IS NOT NULL)
      OR (state = 'new' AND linked_order_id IS NULL)
      OR state = 'archived'
    )
);

CREATE INDEX IF NOT EXISTS idx_bitrix24_incoming_request_state
  ON bitrix24_incoming_request (state, bitrix_updated_at DESC, request_id DESC);

CREATE TABLE IF NOT EXISTS bitrix24_incoming_request_payment (
  bitrix_payment_id TEXT PRIMARY KEY CHECK (bitrix_payment_id ~ '^[1-9][0-9]*$'),
  request_id        BIGINT
                      REFERENCES bitrix24_incoming_request(request_id) ON DELETE RESTRICT,
  erp_order_id      BIGINT REFERENCES orders(order_id) ON DELETE RESTRICT,
  pay_system_id     INTEGER,
  pay_system_name   TEXT,
  amount            NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  currency_id       TEXT,
  paid              BOOLEAN NOT NULL,
  payment_date      TIMESTAMPTZ,
  normalized_hash   TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'active'
                      CHECK (state IN ('active', 'deleted', 'materialized')),
  erp_payment_id    BIGINT REFERENCES payments(payment_id),
  bitrix_created_at TIMESTAMPTZ,
  bitrix_updated_at TIMESTAMPTZ,
  last_fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bitrix24_request_payment_materialized
    CHECK (
      (state = 'materialized' AND erp_payment_id IS NOT NULL)
      OR (state = 'active' AND erp_payment_id IS NULL)
      OR state = 'deleted'
    ),
  CONSTRAINT chk_bitrix24_request_payment_owner
    CHECK ((request_id IS NULL) <> (erp_order_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_bitrix24_request_payment_request
  ON bitrix24_incoming_request_payment (request_id, state, bitrix_payment_id);

CREATE INDEX IF NOT EXISTS idx_bitrix24_request_payment_order
  ON bitrix24_incoming_request_payment (erp_order_id, state, bitrix_payment_id)
  WHERE erp_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bitrix24_payment_type_mapping (
  pay_system_id INTEGER PRIMARY KEY CHECK (pay_system_id > 0),
  type_paid_id  INTEGER NOT NULL REFERENCES payment_types(type_paid_id),
  active        BOOLEAN NOT NULL DEFAULT true,
  created_by    BIGINT REFERENCES users(user_id),
  updated_by    BIGINT REFERENCES users(user_id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bitrix24_outbound_operation (
  operation_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type     TEXT NOT NULL
                    CHECK (object_type IN ('contact', 'company', 'deal', 'payment')),
  bitrix_id       TEXT NOT NULL CHECK (bitrix_id ~ '^[1-9][0-9]*$'),
  operation       TEXT NOT NULL CHECK (operation IN ('update', 'delete')),
  expected_hash   TEXT,
  status          TEXT NOT NULL DEFAULT 'prepared'
                    CHECK (status IN ('prepared', 'completed', 'observed', 'expired')),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  observed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bitrix24_outbound_operation_match
  ON bitrix24_outbound_operation (object_type, bitrix_id, operation, expires_at DESC)
  WHERE status IN ('prepared', 'completed');

-- Every reverse-sync transaction sets this local GUC. All existing CRM
-- enqueue functions must fail closed against echo writes.
CREATE OR REPLACE FUNCTION crm_sync_is_bitrix_inbound() RETURNS boolean AS $$
BEGIN
  RETURN COALESCE(current_setting('app.crm_sync_origin', true), '') = 'bitrix24';
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION crm_sync_enqueue() RETURNS trigger AS $$
DECLARE
  v_entity TEXT := TG_ARGV[0];
  v_op TEXT;
  v_id TEXT;
  v_key TEXT;
  v_client_id TEXT;
BEGIN
  IF crm_sync_is_bitrix_inbound() THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_op := 'delete';
    v_id := CASE v_entity
      WHEN 'client' THEN to_jsonb(OLD)->>'client_id'
      ELSE to_jsonb(OLD)->>'order_id'
    END;
  ELSE
    v_op := 'upsert';
    v_id := CASE v_entity
      WHEN 'client' THEN to_jsonb(NEW)->>'client_id'
      ELSE to_jsonb(NEW)->>'order_id'
    END;
  END IF;

  IF v_entity = 'order' THEN
    v_client_id := CASE
      WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)->>'client_id'
      ELSE to_jsonb(NEW)->>'client_id'
    END;
  END IF;

  v_key := v_entity || ':' || v_id;
  DELETE FROM crm_sync_outbox
   WHERE idempotency_key = v_key
     AND status = 'pending';

  INSERT INTO crm_sync_outbox (
    event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
  )
  VALUES (
    'crm.sync.' || v_entity || '.' || v_op,
    'crm_sync',
    v_id,
    jsonb_build_object(
      'entity', v_entity,
      'id', v_id,
      'op', v_op,
      'clientId', v_client_id
    ),
    v_key
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION crm_sync_enqueue_client_phone() RETURNS trigger AS $$
DECLARE
  v_client_id TEXT;
  v_key TEXT;
BEGIN
  IF crm_sync_is_bitrix_inbound() THEN
    RETURN NULL;
  END IF;

  v_client_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.client_id::text
    ELSE NEW.client_id::text
  END;
  v_key := 'client:' || v_client_id;

  DELETE FROM crm_sync_outbox
   WHERE idempotency_key = v_key
     AND status = 'pending';

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

CREATE OR REPLACE FUNCTION crm_sync_enqueue_client_orders() RETURNS trigger AS $$
BEGIN
  IF crm_sync_is_bitrix_inbound()
     OR OLD.person_type IS NOT DISTINCT FROM NEW.person_type THEN
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

CREATE OR REPLACE FUNCTION crm_sync_enqueue_payment_order() RETURNS trigger AS $$
BEGIN
  IF crm_sync_is_bitrix_inbound() THEN
    RETURN NULL;
  END IF;

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
