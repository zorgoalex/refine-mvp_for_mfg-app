-- 145 Order kinds, Bitrix CRM-request orders, and hard aggregate boundaries.
-- Compatible first: all existing orders remain production_order/erp.

BEGIN;

-- Technical backfills must not enqueue thousands of unchanged ERP orders for
-- outbound Bitrix delivery. This transaction-local flag is consumed by the
-- CRM enqueue triggers installed by 144 and resets automatically on commit.
SELECT set_config('app.crm_sync_origin', 'bitrix24', true);

CREATE TEMP TABLE migration_096_state (
  first_apply BOOLEAN NOT NULL
) ON COMMIT DROP;

INSERT INTO migration_096_state(first_apply)
SELECT to_regclass('public.order_legacy_duplicate_name_registry') IS NULL;

CREATE OR REPLACE FUNCTION normalize_order_name(p_name TEXT) RETURNS TEXT AS $$
  SELECT lower(btrim(p_name));
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS order_kind TEXT NOT NULL DEFAULT 'production_order',
  ADD COLUMN IF NOT EXISTS source_system TEXT NOT NULL DEFAULT 'erp',
  ADD COLUMN IF NOT EXISTS legacy_zero_detail_exempt BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS legacy_duplicate_name_exempt BOOLEAN NOT NULL DEFAULT false;

-- Makes a direct replay safe: any prior version is restored automatically if
-- this transaction aborts, and the current definition is recreated below.
DROP TRIGGER IF EXISTS trg_orders_identity_transition ON orders;
DROP TRIGGER IF EXISTS ctrg_orders_kind_aggregate ON orders;

CREATE TABLE IF NOT EXISTS order_legacy_duplicate_name_registry (
  normalized_name TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_order_legacy_name_registry_normalized
    CHECK (normalized_name = normalize_order_name(normalized_name))
);

CREATE TABLE IF NOT EXISTS order_legacy_duplicate_name_ledger (
  order_id BIGINT PRIMARY KEY,
  normalized_name TEXT NOT NULL
    REFERENCES order_legacy_duplicate_name_registry(normalized_name) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE order_legacy_duplicate_name_ledger
  DROP CONSTRAINT IF EXISTS order_legacy_duplicate_name_ledger_order_id_fkey;

WITH duplicate_names AS (
  SELECT normalize_order_name(order_name) AS normalized_name
  FROM orders
  WHERE delete_flag = false
    AND order_kind = 'production_order'
    AND (SELECT first_apply FROM migration_096_state)
  GROUP BY normalize_order_name(order_name)
  HAVING count(*) > 1
)
INSERT INTO order_legacy_duplicate_name_registry(normalized_name)
SELECT normalized_name
FROM duplicate_names
ON CONFLICT (normalized_name) DO NOTHING;

INSERT INTO order_legacy_duplicate_name_ledger(order_id, normalized_name)
SELECT o.order_id, registry.normalized_name
FROM orders o
JOIN order_legacy_duplicate_name_registry registry
  ON registry.normalized_name = normalize_order_name(o.order_name)
WHERE o.delete_flag = false
  AND o.order_kind = 'production_order'
  AND (SELECT first_apply FROM migration_096_state)
ON CONFLICT (order_id) DO NOTHING;

UPDATE orders o
SET legacy_zero_detail_exempt = true
WHERE o.order_kind = 'production_order'
  AND (SELECT first_apply FROM migration_096_state)
  AND NOT EXISTS (
    SELECT 1
    FROM order_details od
    WHERE od.order_id = o.order_id
      AND od.delete_flag = false
  );

-- Historical ERP data allowed the same order_name for different clients.
-- Preserve every member of those groups. Registry keys stay reserved, so a
-- concurrent new order can never claim a legacy name while an exempt row is
-- deleted/restored. Ledger proves which rows received the one-time exemption.
UPDATE orders o
SET legacy_duplicate_name_exempt = true
FROM order_legacy_duplicate_name_ledger ledger
WHERE o.order_id = ledger.order_id
  AND (SELECT first_apply FROM migration_096_state);

-- On a replay, constraint triggers from a prior successful 145 already exist.
-- Flush their events before ALTER TABLE statements touch the same relations.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS chk_orders_order_kind,
  DROP CONSTRAINT IF EXISTS chk_orders_source_system,
  DROP CONSTRAINT IF EXISTS chk_orders_kind_source,
  DROP CONSTRAINT IF EXISTS chk_orders_kind_project,
  DROP CONSTRAINT IF EXISTS chk_orders_precursor_header;

ALTER TABLE orders
  ADD CONSTRAINT chk_orders_order_kind
    CHECK (order_kind IN ('draft', 'crm_request', 'production_order')),
  ADD CONSTRAINT chk_orders_source_system
    CHECK (source_system IN ('erp', 'bitrix24', 'customer_portal')),
  ADD CONSTRAINT chk_orders_kind_source
    CHECK (
      (order_kind = 'draft' AND source_system = 'customer_portal')
      OR (order_kind = 'crm_request' AND source_system = 'bitrix24')
      OR order_kind = 'production_order'
    ),
  ADD CONSTRAINT chk_orders_kind_project
    CHECK (order_kind <> 'production_order' OR project_id IS NOT NULL),
  ADD CONSTRAINT chk_orders_precursor_header
    CHECK (
      order_kind = 'production_order'
      OR (
        production_status_id IS NULL
        AND production_status_from_details_enabled = false
        AND COALESCE(paid_amount, 0) = 0
        AND payment_date IS NULL
      )
    );

ALTER TABLE orders ALTER COLUMN project_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION enforce_order_identity_transition() RETURNS trigger AS $$
DECLARE
  v_old_normalized TEXT;
  v_new_normalized TEXT := normalize_order_name(NEW.order_name);
  v_ledger_normalized TEXT;
  v_requires_name_claim BOOLEAN := TG_OP = 'INSERT';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.legacy_zero_detail_exempt = true THEN
      RAISE EXCEPTION 'legacy zero-detail exemption cannot be granted to new orders'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_orders_legacy_exemption_immutable';
    END IF;
    IF NEW.legacy_duplicate_name_exempt = true THEN
      RAISE EXCEPTION 'legacy duplicate-name exemption cannot be granted to new orders'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_orders_legacy_name_exemption_immutable';
    END IF;
  ELSE
    v_old_normalized := normalize_order_name(OLD.order_name);

    IF OLD.source_system IS DISTINCT FROM NEW.source_system THEN
      RAISE EXCEPTION 'orders.source_system is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_orders_source_system_immutable';
    END IF;

    IF OLD.order_kind IS DISTINCT FROM NEW.order_kind
       AND NOT (
         OLD.order_kind IN ('draft', 'crm_request')
         AND NEW.order_kind = 'production_order'
       ) THEN
      RAISE EXCEPTION 'invalid order_kind transition: % -> %', OLD.order_kind, NEW.order_kind
        USING ERRCODE = '23514', CONSTRAINT = 'chk_orders_order_kind_transition';
    END IF;

    IF OLD.legacy_zero_detail_exempt = false
       AND NEW.legacy_zero_detail_exempt = true THEN
      RAISE EXCEPTION 'legacy zero-detail exemption cannot be granted at runtime'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_orders_legacy_exemption_immutable';
    END IF;

    IF OLD.legacy_duplicate_name_exempt = false
       AND NEW.legacy_duplicate_name_exempt = true THEN
      RAISE EXCEPTION 'legacy duplicate-name exemption cannot be granted at runtime'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_orders_legacy_name_exemption_immutable';
    END IF;

    IF OLD.legacy_duplicate_name_exempt = true
       AND v_old_normalized IS DISTINCT FROM v_new_normalized THEN
      NEW.legacy_duplicate_name_exempt := false;
    END IF;

    v_requires_name_claim :=
      (OLD.delete_flag = true AND NEW.delete_flag = false)
      OR (OLD.order_kind <> 'production_order' AND NEW.order_kind = 'production_order')
      OR v_old_normalized IS DISTINCT FROM v_new_normalized
      OR (OLD.legacy_duplicate_name_exempt = true
          AND NEW.legacy_duplicate_name_exempt = false);
  END IF;

  IF NEW.legacy_duplicate_name_exempt = true THEN
    SELECT ledger.normalized_name
      INTO v_ledger_normalized
      FROM order_legacy_duplicate_name_ledger ledger
     WHERE ledger.order_id = NEW.order_id;

    IF v_ledger_normalized IS NULL OR v_ledger_normalized <> v_new_normalized THEN
      RAISE EXCEPTION 'legacy duplicate-name exemption provenance mismatch for order %', NEW.order_id
        USING ERRCODE = '23514', CONSTRAINT = 'chk_orders_legacy_name_exemption_provenance';
    END IF;
  END IF;

  IF v_requires_name_claim
     AND NEW.delete_flag = false
     AND NEW.order_kind = 'production_order'
     AND NEW.legacy_duplicate_name_exempt = false
     AND (
       EXISTS (
         SELECT 1
         FROM order_legacy_duplicate_name_registry registry
         WHERE registry.normalized_name = v_new_normalized
       )
       OR EXISTS (
         SELECT 1
         FROM orders existing
         WHERE existing.order_id IS DISTINCT FROM NEW.order_id
           AND existing.delete_flag = false
           AND existing.order_kind = 'production_order'
           AND normalize_order_name(existing.order_name) = v_new_normalized
       )
     ) THEN
    RAISE EXCEPTION 'active production order name already exists: %', NEW.order_name
      USING ERRCODE = '23505', CONSTRAINT = 'uq_orders_name_production_active';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orders_identity_transition
BEFORE INSERT OR UPDATE OF order_name, order_kind, source_system, delete_flag,
  legacy_zero_detail_exempt, legacy_duplicate_name_exempt ON orders
FOR EACH ROW EXECUTE FUNCTION enforce_order_identity_transition();

CREATE OR REPLACE FUNCTION prevent_order_legacy_name_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'legacy order-name history is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'chk_order_legacy_name_history_immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_legacy_name_registry_immutable
  ON order_legacy_duplicate_name_registry;
CREATE TRIGGER trg_order_legacy_name_registry_immutable
BEFORE INSERT OR UPDATE OR DELETE ON order_legacy_duplicate_name_registry
FOR EACH ROW EXECUTE FUNCTION prevent_order_legacy_name_history_mutation();

DROP TRIGGER IF EXISTS trg_order_legacy_name_ledger_immutable
  ON order_legacy_duplicate_name_ledger;
CREATE TRIGGER trg_order_legacy_name_ledger_immutable
BEFORE INSERT OR UPDATE OR DELETE ON order_legacy_duplicate_name_ledger
FOR EACH ROW EXECUTE FUNCTION prevent_order_legacy_name_history_mutation();

DROP INDEX IF EXISTS uq_orders_name_client_active;
DROP INDEX IF EXISTS uq_orders_name_production_active;
CREATE UNIQUE INDEX uq_orders_name_production_active
  ON orders (normalize_order_name(order_name))
  WHERE delete_flag = false
    AND order_kind = 'production_order'
    AND legacy_duplicate_name_exempt = false;

CREATE INDEX IF NOT EXISTS idx_orders_kind_active
  ON orders (order_kind, order_date DESC, order_id DESC)
  WHERE delete_flag = false;

ALTER TABLE order_statuses
  ADD COLUMN IF NOT EXISTS order_status_code VARCHAR(64);

UPDATE order_statuses
SET order_status_code = 'legacy_' || order_status_id::text
WHERE order_status_code IS NULL OR btrim(order_status_code) = '';

UPDATE order_statuses
SET order_status_code = 'crm_request',
    order_status_name = 'Заявка CRM',
    is_active = true,
    updated_at = now()
WHERE order_status_name = 'Заявка CRM';

CREATE UNIQUE INDEX IF NOT EXISTS uq_order_statuses_code
  ON order_statuses (order_status_code);

INSERT INTO order_statuses (
  order_status_code,
  order_status_name,
  sort_order,
  color,
  description,
  is_active
)
SELECT
  'crm_request',
  'Заявка CRM',
  5,
  '#607D8B',
  'Технический статус активной заявки Bitrix до преобразования в производственный заказ',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM order_statuses WHERE order_status_code = 'crm_request'
);

ALTER TABLE order_statuses ALTER COLUMN order_status_code SET NOT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_service_account BOOLEAN NOT NULL DEFAULT false;

INSERT INTO roles (
  role_id,
  role_code,
  role_description,
  permissions,
  is_active,
  role_name
)
VALUES (
  31,
  'integration_service',
  'Non-login machine identity for transactional integration audit/FK ownership',
  '{}'::jsonb,
  true,
  'Системная интеграция'
)
ON CONFLICT (role_id) DO UPDATE
SET role_code = EXCLUDED.role_code,
    role_description = EXCLUDED.role_description,
    permissions = '{}'::jsonb,
    is_active = true,
    role_name = EXCLUDED.role_name,
    updated_at = now();

CREATE TABLE IF NOT EXISTS bitrix24_user_mapping (
  mapping_id       BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  bitrix_user_id   TEXT NOT NULL CHECK (bitrix_user_id ~ '^[1-9][0-9]*$'),
  erp_user_id      BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_by       BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  updated_by       BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bitrix24_user_mapping_active
  ON bitrix24_user_mapping (bitrix_user_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_bitrix24_user_mapping_erp
  ON bitrix24_user_mapping (erp_user_id)
  WHERE is_active = true;

CREATE OR REPLACE FUNCTION validate_bitrix24_user_mapping_target() RETURNS trigger AS $$
DECLARE
  target users%ROWTYPE;
BEGIN
  IF NEW.is_active = false THEN
    RETURN NEW;
  END IF;
  SELECT * INTO target FROM users WHERE user_id=NEW.erp_user_id;
  IF NOT FOUND OR target.is_active=false OR target.is_service_account=true THEN
    RAISE EXCEPTION 'Bitrix user mapping target must be an active non-service ERP user'
      USING ERRCODE='23514', CONSTRAINT='chk_bitrix24_user_mapping_target';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bitrix24_user_mapping_target ON bitrix24_user_mapping;
CREATE TRIGGER trg_bitrix24_user_mapping_target
BEFORE INSERT OR UPDATE OF erp_user_id, is_active ON bitrix24_user_mapping
FOR EACH ROW EXECUTE FUNCTION validate_bitrix24_user_mapping_target();

CREATE OR REPLACE FUNCTION enqueue_bitrix24_responsible_reconcile(
  p_bitrix_user_id TEXT,
  p_reason TEXT
) RETURNS void AS $$
BEGIN
  INSERT INTO bitrix24_inbound_event (
    member_id, event_name, object_type, bitrix_id, event_ts,
    payload_json, fingerprint
  )
  SELECT installation.member_id, 'BITRIX24_RECONCILE_DEAL', 'deal',
         request.bitrix_deal_id, now(),
         jsonb_build_object(
           'source', 'responsible-mapping-change',
           'bitrixUserId', p_bitrix_user_id,
           'reason', p_reason
         ),
         'responsible-map:' || p_bitrix_user_id || ':' || txid_current()::text ||
           ':deal:' || request.bitrix_deal_id
    FROM bitrix24_incoming_request request
    CROSS JOIN LATERAL (
      SELECT member_id
        FROM bitrix24_app_installation
       WHERE status <> 'revoked'
       ORDER BY updated_at DESC
       LIMIT 1
    ) installation
   WHERE request.state = 'active'
     AND request.assigned_by_id = p_bitrix_user_id
  ON CONFLICT (member_id, fingerprint) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bitrix24_user_mapping_reconcile_trigger() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM enqueue_bitrix24_responsible_reconcile(NEW.bitrix_user_id, 'mapping_insert');
  ELSE
    IF OLD.bitrix_user_id IS DISTINCT FROM NEW.bitrix_user_id THEN
      PERFORM enqueue_bitrix24_responsible_reconcile(OLD.bitrix_user_id, 'mapping_identity_change');
    END IF;
    IF OLD.bitrix_user_id IS DISTINCT FROM NEW.bitrix_user_id
       OR OLD.erp_user_id IS DISTINCT FROM NEW.erp_user_id
       OR OLD.is_active IS DISTINCT FROM NEW.is_active THEN
      PERFORM enqueue_bitrix24_responsible_reconcile(NEW.bitrix_user_id, 'mapping_update');
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bitrix24_user_mapping_reconcile ON bitrix24_user_mapping;
CREATE TRIGGER trg_bitrix24_user_mapping_reconcile
AFTER INSERT OR UPDATE OF bitrix_user_id, erp_user_id, is_active ON bitrix24_user_mapping
FOR EACH ROW EXECUTE FUNCTION bitrix24_user_mapping_reconcile_trigger();

CREATE OR REPLACE FUNCTION bitrix24_mapped_user_reconcile_trigger() RETURNS trigger AS $$
DECLARE
  mapped RECORD;
BEGIN
  IF OLD.is_active IS NOT DISTINCT FROM NEW.is_active
     AND OLD.is_service_account IS NOT DISTINCT FROM NEW.is_service_account THEN
    RETURN NULL;
  END IF;
  FOR mapped IN
    SELECT DISTINCT bitrix_user_id
      FROM bitrix24_user_mapping
     WHERE erp_user_id = NEW.user_id
  LOOP
    PERFORM enqueue_bitrix24_responsible_reconcile(mapped.bitrix_user_id, 'erp_user_state_change');
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bitrix24_mapped_user_reconcile ON users;
CREATE TRIGGER trg_bitrix24_mapped_user_reconcile
AFTER UPDATE OF is_active, is_service_account ON users
FOR EACH ROW EXECUTE FUNCTION bitrix24_mapped_user_reconcile_trigger();

CREATE TABLE IF NOT EXISTS order_kind_conversion_command (
  idempotency_key TEXT PRIMARY KEY,
  order_id        BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE RESTRICT,
  request_hash    TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status          TEXT NOT NULL DEFAULT 'processing'
                    CHECK (status IN ('processing', 'completed', 'failed')),
  response_json   JSONB,
  error_code      TEXT,
  actor_user_id   BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  CONSTRAINT chk_order_kind_conversion_result
    CHECK (
      (status = 'completed' AND response_json IS NOT NULL AND completed_at IS NOT NULL)
      OR status <> 'completed'
    )
);

CREATE INDEX IF NOT EXISTS idx_order_kind_conversion_order
  ON order_kind_conversion_command (order_id, created_at DESC);

ALTER TABLE bitrix24_remote_state
  ADD COLUMN IF NOT EXISTS remote_revision TEXT,
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE crm_sync_mapping
  DROP CONSTRAINT IF EXISTS crm_sync_mapping_status_check;

ALTER TABLE crm_sync_mapping
  ADD CONSTRAINT crm_sync_mapping_status_check
    CHECK (status IN ('active', 'deleted', 'failed', 'remote_deleted'));

ALTER TABLE bitrix24_incoming_request
  DROP CONSTRAINT IF EXISTS chk_bitrix24_incoming_request_conversion,
  DROP CONSTRAINT IF EXISTS bitrix24_incoming_request_state_check,
  DROP CONSTRAINT IF EXISTS chk_bitrix24_request_counterparty,
  DROP CONSTRAINT IF EXISTS chk_bitrix24_request_sync,
  DROP CONSTRAINT IF EXISTS chk_bitrix24_request_state_link;

ALTER TABLE bitrix24_incoming_request
  ADD COLUMN IF NOT EXISTS counterparty_object_type TEXT,
  ADD COLUMN IF NOT EXISTS counterparty_bitrix_id TEXT,
  ADD COLUMN IF NOT EXISTS full_title TEXT,
  ADD COLUMN IF NOT EXISTS remote_revision TEXT,
  ADD COLUMN IF NOT EXISTS sync_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'ok',
  ADD COLUMN IF NOT EXISTS sync_error_code TEXT,
  ADD COLUMN IF NOT EXISTS sync_error_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by_source TEXT,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_order_version INTEGER;

ALTER TABLE bitrix24_incoming_request_payment
  ADD COLUMN IF NOT EXISTS sync_version BIGINT NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_bitrix24_request_payment_sync_version'
       AND conrelid = 'bitrix24_incoming_request_payment'::regclass
  ) THEN
    ALTER TABLE bitrix24_incoming_request_payment
      ADD CONSTRAINT chk_bitrix24_request_payment_sync_version
      CHECK (sync_version > 0);
  END IF;
END $$;

UPDATE bitrix24_incoming_request
SET state = CASE
  WHEN state = 'new' AND linked_order_id IS NULL THEN 'unresolved'
  WHEN state = 'new' AND linked_order_id IS NOT NULL THEN 'active'
  ELSE state
END,
full_title = COALESCE(full_title, title);

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

ALTER TABLE bitrix24_incoming_request ALTER COLUMN state SET DEFAULT 'unresolved';

ALTER TABLE bitrix24_incoming_request
  ADD CONSTRAINT bitrix24_incoming_request_state_check
    CHECK (state IN ('unresolved', 'active', 'converted', 'archived')),
  ADD CONSTRAINT chk_bitrix24_request_counterparty
    CHECK (
      (counterparty_object_type IS NULL AND counterparty_bitrix_id IS NULL)
      OR (
        counterparty_object_type IN ('contact', 'company')
        AND counterparty_bitrix_id ~ '^[1-9][0-9]*$'
      )
    ),
  ADD CONSTRAINT chk_bitrix24_request_sync
    CHECK (
      sync_version > 0
      AND sync_status IN ('ok', 'blocked')
      AND (
        archived_by_source IS NULL
        OR archived_by_source IN ('bitrix24', 'erp_user')
      )
    ),
  ADD CONSTRAINT chk_bitrix24_request_state_link
    CHECK (
      (state = 'unresolved' AND linked_order_id IS NULL)
      OR (state IN ('active', 'converted') AND linked_order_id IS NOT NULL)
      OR state = 'archived'
    );

DROP INDEX IF EXISTS uq_bitrix24_incoming_request_linked_order;
CREATE UNIQUE INDEX uq_bitrix24_incoming_request_linked_order
  ON bitrix24_incoming_request (linked_order_id)
  WHERE linked_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bitrix24_request_counterparty_unresolved
  ON bitrix24_incoming_request (
    counterparty_object_type,
    counterparty_bitrix_id,
    request_id
  )
  WHERE state = 'unresolved';

CREATE OR REPLACE FUNCTION validate_order_kind_aggregate_id(p_order_id BIGINT)
RETURNS void AS $$
DECLARE
  o orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM orders WHERE order_id = p_order_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF o.order_kind = 'production_order' THEN
    IF o.project_id IS NULL THEN
      RAISE EXCEPTION 'production order % requires project', p_order_id
        USING ERRCODE = '23514', CONSTRAINT = 'chk_orders_kind_project';
    END IF;

    IF o.delete_flag = false
       AND o.legacy_zero_detail_exempt = false
       AND NOT EXISTS (
         SELECT 1 FROM order_details od
         WHERE od.order_id = p_order_id AND od.delete_flag = false
       ) THEN
      RAISE EXCEPTION 'production order % requires active detail', p_order_id
        USING ERRCODE = '23514', CONSTRAINT = 'chk_orders_production_detail_required';
    END IF;

    IF o.legacy_zero_detail_exempt = true
       AND EXISTS (
         SELECT 1 FROM order_details od
         WHERE od.order_id = p_order_id AND od.delete_flag = false
       ) THEN
      UPDATE orders SET legacy_zero_detail_exempt = false
      WHERE order_id = p_order_id AND legacy_zero_detail_exempt = true;
    END IF;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM order_details od
    WHERE od.order_id = p_order_id
      AND od.delete_flag = false
      AND (od.production_status_id IS NOT NULL OR od.joint_order_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'precursor order % detail has production/joint state', p_order_id
      USING ERRCODE = '23514', CONSTRAINT = 'chk_order_details_precursor_state';
  END IF;

  IF EXISTS (SELECT 1 FROM payments p WHERE p.order_id = p_order_id AND p.delete_flag = false)
     OR EXISTS (SELECT 1 FROM order_workshops ow WHERE ow.order_id = p_order_id AND ow.delete_flag = false)
     OR EXISTS (SELECT 1 FROM order_resource_requirements r WHERE r.order_id = p_order_id AND r.is_active = true)
     OR EXISTS (SELECT 1 FROM order_doweling_links l WHERE l.order_id = p_order_id AND l.delete_flag = false)
     OR EXISTS (
       SELECT 1 FROM production_status_events e
       LEFT JOIN order_details od ON od.detail_id = e.detail_id
       WHERE e.order_id = p_order_id OR od.order_id = p_order_id
     )
     OR EXISTS (SELECT 1 FROM deadline_instances d WHERE d.order_id = p_order_id)
     OR EXISTS (SELECT 1 FROM deadline_events d WHERE d.order_id = p_order_id)
     OR EXISTS (SELECT 1 FROM cut_job_item c WHERE c.order_id = p_order_id AND c.is_active = true)
     OR EXISTS (SELECT 1 FROM bazis_order_links b WHERE b.order_id = p_order_id)
     OR EXISTS (SELECT 1 FROM bazis_node_order_detail_map b WHERE b.order_id = p_order_id)
     OR EXISTS (SELECT 1 FROM bazis_cut_set_details b WHERE b.source_order_id = p_order_id)
     OR EXISTS (
       SELECT 1 FROM bazis_cut_set_details b
       JOIN order_details od ON od.detail_id = b.source_order_detail_id
       WHERE od.order_id = p_order_id
     )
     OR EXISTS (SELECT 1 FROM movement_items m JOIN order_details od ON od.detail_id=m.order_detail_id WHERE od.order_id=p_order_id)
     OR EXISTS (SELECT 1 FROM cnc_telegram_packet_items c WHERE c.match_order_id=p_order_id)
     OR EXISTS (
       SELECT 1 FROM cnc_telegram_packet_items c
       JOIN order_details od ON od.detail_id=c.match_detail_id
       WHERE od.order_id=p_order_id
     )
     OR EXISTS (SELECT 1 FROM group_order_groups g WHERE g.order_id=p_order_id)
     OR EXISTS (SELECT 1 FROM order_label_detail_data l WHERE l.order_id = p_order_id)
     OR EXISTS (SELECT 1 FROM order_label_generations l WHERE l.order_id = p_order_id) THEN
    RAISE EXCEPTION 'precursor order % has prohibited production/finance children', p_order_id
      USING ERRCODE = '23514', CONSTRAINT = 'chk_orders_precursor_children';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_order_kind_aggregate() RETURNS trigger AS $$
DECLARE
  v_order_id BIGINT;
  v_old_order_id BIGINT;
  v_new_order_id BIGINT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_order_id := OLD.order_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new_order_id := NEW.order_id;
  END IF;

  FOR v_order_id IN
    SELECT DISTINCT candidate
      FROM unnest(ARRAY[v_old_order_id, v_new_order_id]) AS ids(candidate)
     WHERE candidate IS NOT NULL
     ORDER BY candidate
  LOOP
    PERFORM validate_order_kind_aggregate_id(v_order_id);
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ctrg_orders_kind_aggregate ON orders;
CREATE CONSTRAINT TRIGGER ctrg_orders_kind_aggregate
AFTER INSERT OR UPDATE ON orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_order_kind_aggregate();

DROP TRIGGER IF EXISTS ctrg_order_details_kind_aggregate ON order_details;
CREATE CONSTRAINT TRIGGER ctrg_order_details_kind_aggregate
AFTER INSERT OR UPDATE OR DELETE ON order_details
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_order_kind_aggregate();

CREATE OR REPLACE FUNCTION assert_production_order_child() RETURNS trigger AS $$
DECLARE
  row_json JSONB;
  v_order_id BIGINT;
  v_kind TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;

  row_json := to_jsonb(NEW);
  IF row_json ? 'delete_flag' AND COALESCE((row_json->>'delete_flag')::boolean, false) THEN
    RETURN NULL;
  END IF;
  IF row_json ? 'is_active' AND NOT COALESCE((row_json->>'is_active')::boolean, false) THEN
    RETURN NULL;
  END IF;

  IF TG_ARGV[0] = 'status_event' THEN
    v_order_id := NULLIF(row_json->>'order_id', '')::BIGINT;
    IF v_order_id IS NULL THEN
      SELECT order_id INTO v_order_id
      FROM order_details
      WHERE detail_id = NULLIF(row_json->>'detail_id', '')::BIGINT;
    END IF;
  ELSIF TG_ARGV[0] = 'detail' THEN
    SELECT order_id INTO v_order_id
    FROM order_details
    WHERE detail_id = NULLIF(row_json->>TG_ARGV[1], '')::BIGINT;
  ELSIF TG_ARGV[0] = 'order_or_detail' THEN
    v_order_id := NULLIF(row_json->>TG_ARGV[1], '')::BIGINT;
    IF v_order_id IS NULL THEN
      SELECT order_id INTO v_order_id
      FROM order_details
      WHERE detail_id = NULLIF(row_json->>TG_ARGV[2], '')::BIGINT;
    END IF;
  ELSE
    v_order_id := NULLIF(row_json->>TG_ARGV[0], '')::BIGINT;
  END IF;

  IF v_order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT order_kind INTO v_kind FROM orders WHERE order_id = v_order_id;
  IF v_kind IS DISTINCT FROM 'production_order' THEN
    RAISE EXCEPTION 'order % is not a production order', v_order_id
      USING ERRCODE = '23514', CONSTRAINT = 'chk_order_child_production_only';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ctrg_payments_production_only ON payments;
CREATE CONSTRAINT TRIGGER ctrg_payments_production_only
AFTER INSERT OR UPDATE ON payments DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child('order_id');

DROP TRIGGER IF EXISTS ctrg_order_workshops_production_only ON order_workshops;
CREATE CONSTRAINT TRIGGER ctrg_order_workshops_production_only
AFTER INSERT OR UPDATE ON order_workshops DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child('order_id');

DROP TRIGGER IF EXISTS ctrg_order_requirements_production_only ON order_resource_requirements;
CREATE CONSTRAINT TRIGGER ctrg_order_requirements_production_only
AFTER INSERT OR UPDATE ON order_resource_requirements DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child('order_id');

DROP TRIGGER IF EXISTS ctrg_order_doweling_production_only ON order_doweling_links;
CREATE CONSTRAINT TRIGGER ctrg_order_doweling_production_only
AFTER INSERT OR UPDATE ON order_doweling_links DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child('order_id');

DROP TRIGGER IF EXISTS ctrg_production_events_production_only ON production_status_events;
CREATE CONSTRAINT TRIGGER ctrg_production_events_production_only
AFTER INSERT OR UPDATE ON production_status_events DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child('status_event');

DROP TRIGGER IF EXISTS ctrg_deadline_instances_production_only ON deadline_instances;
CREATE CONSTRAINT TRIGGER ctrg_deadline_instances_production_only
AFTER INSERT OR UPDATE ON deadline_instances DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child('order_id');

DROP TRIGGER IF EXISTS ctrg_deadline_events_production_only ON deadline_events;
CREATE CONSTRAINT TRIGGER ctrg_deadline_events_production_only
AFTER INSERT OR UPDATE ON deadline_events DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child('order_id');

DROP TRIGGER IF EXISTS ctrg_cut_job_item_production_only ON cut_job_item;
CREATE CONSTRAINT TRIGGER ctrg_cut_job_item_production_only
AFTER INSERT OR UPDATE ON cut_job_item DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child('order_id');

DROP TRIGGER IF EXISTS ctrg_bazis_order_links_production_only ON bazis_order_links;
CREATE CONSTRAINT TRIGGER ctrg_bazis_order_links_production_only
AFTER INSERT OR UPDATE ON bazis_order_links DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child('order_id');

DROP TRIGGER IF EXISTS ctrg_bazis_node_map_production_only ON bazis_node_order_detail_map;
CREATE CONSTRAINT TRIGGER ctrg_bazis_node_map_production_only
AFTER INSERT OR UPDATE ON bazis_node_order_detail_map DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child('order_id');

DROP TRIGGER IF EXISTS ctrg_label_detail_data_production_only ON order_label_detail_data;
CREATE CONSTRAINT TRIGGER ctrg_label_detail_data_production_only
AFTER INSERT OR UPDATE ON order_label_detail_data DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child('order_id');

DROP TRIGGER IF EXISTS ctrg_label_generations_production_only ON order_label_generations;
CREATE CONSTRAINT TRIGGER ctrg_label_generations_production_only
AFTER INSERT OR UPDATE ON order_label_generations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child('order_id');

DROP TRIGGER IF EXISTS ctrg_bazis_cut_set_details_production_only ON bazis_cut_set_details;
CREATE CONSTRAINT TRIGGER ctrg_bazis_cut_set_details_production_only
AFTER INSERT OR UPDATE ON bazis_cut_set_details DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child(
  'order_or_detail', 'source_order_id', 'source_order_detail_id'
);

DROP TRIGGER IF EXISTS ctrg_movement_items_production_only ON movement_items;
CREATE CONSTRAINT TRIGGER ctrg_movement_items_production_only
AFTER INSERT OR UPDATE ON movement_items DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child('detail', 'order_detail_id');

DROP TRIGGER IF EXISTS ctrg_cnc_packet_items_production_only ON cnc_telegram_packet_items;
CREATE CONSTRAINT TRIGGER ctrg_cnc_packet_items_production_only
AFTER INSERT OR UPDATE ON cnc_telegram_packet_items DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child(
  'order_or_detail', 'match_order_id', 'match_detail_id'
);

DROP TRIGGER IF EXISTS ctrg_group_order_groups_production_only ON group_order_groups;
CREATE CONSTRAINT TRIGGER ctrg_group_order_groups_production_only
AFTER INSERT OR UPDATE ON group_order_groups DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_production_order_child('order_id');

CREATE OR REPLACE FUNCTION validate_bitrix24_incoming_request_link() RETURNS trigger AS $$
DECLARE
  r bitrix24_incoming_request%ROWTYPE;
  o orders%ROWTYPE;
  v_order_id BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    v_order_id := COALESCE(NEW.order_id, OLD.order_id);
    SELECT * INTO r
    FROM bitrix24_incoming_request
    WHERE linked_order_id = v_order_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSE
    r := NEW;
  END IF;

  IF r.state = 'unresolved' AND r.linked_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'unresolved Bitrix request cannot link order'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_bitrix24_request_state_link';
  END IF;

  IF r.linked_order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO o FROM orders WHERE order_id = r.linked_order_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF o.source_system <> 'bitrix24'
     OR r.client_id IS DISTINCT FROM o.client_id
     OR (r.state = 'active' AND o.order_kind <> 'crm_request')
     OR (r.state = 'converted' AND o.order_kind <> 'production_order') THEN
    RAISE EXCEPTION 'Bitrix request % does not match linked order %', r.request_id, o.order_id
      USING ERRCODE = '23514', CONSTRAINT = 'chk_bitrix24_request_linked_order';
  END IF;

  IF r.state IN ('active', 'converted') AND (
    r.counterparty_object_type IS NULL
    OR r.counterparty_bitrix_id IS NULL
    OR NOT EXISTS (
      SELECT 1
        FROM crm_sync_mapping mapping
       WHERE mapping.entity_type = 'client'
         AND mapping.erp_id = r.client_id::text
         AND mapping.bitrix_object = r.counterparty_object_type
         AND mapping.bitrix_id = r.counterparty_bitrix_id
         AND mapping.status = 'active'
    )
  ) THEN
    RAISE EXCEPTION 'Bitrix request % lacks exact active client mapping', r.request_id
      USING ERRCODE = '23514', CONSTRAINT = 'chk_bitrix24_request_client_mapping';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ctrg_bitrix24_request_link ON bitrix24_incoming_request;
CREATE CONSTRAINT TRIGGER ctrg_bitrix24_request_link
AFTER INSERT OR UPDATE ON bitrix24_incoming_request
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_bitrix24_incoming_request_link();

DROP TRIGGER IF EXISTS ctrg_orders_bitrix24_request_link ON orders;
CREATE CONSTRAINT TRIGGER ctrg_orders_bitrix24_request_link
AFTER UPDATE OF order_kind, source_system, client_id ON orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_bitrix24_incoming_request_link();

DO $$
DECLARE
  invalid_request_id BIGINT;
BEGIN
  SELECT request.request_id INTO invalid_request_id
    FROM bitrix24_incoming_request request
   WHERE request.state IN ('active', 'converted')
     AND NOT EXISTS (
       SELECT 1
         FROM crm_sync_mapping mapping
        WHERE mapping.entity_type = 'client'
          AND mapping.erp_id = request.client_id::text
          AND mapping.bitrix_object = request.counterparty_object_type
          AND mapping.bitrix_id = request.counterparty_bitrix_id
          AND mapping.status = 'active'
     )
   ORDER BY request.request_id
   LIMIT 1;
  IF invalid_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'Bitrix request % lacks exact active client mapping', invalid_request_id
      USING ERRCODE = '23514', CONSTRAINT = 'chk_bitrix24_request_client_mapping';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION validate_bitrix24_request_client_mappings() RETURNS trigger AS $$
DECLARE
  invalid_request_id BIGINT;
BEGIN
  SELECT request.request_id INTO invalid_request_id
    FROM bitrix24_incoming_request request
   WHERE request.state IN ('active', 'converted')
     AND NOT EXISTS (
       SELECT 1
         FROM crm_sync_mapping mapping
        WHERE mapping.entity_type = 'client'
          AND mapping.erp_id = request.client_id::text
          AND mapping.bitrix_object = request.counterparty_object_type
          AND mapping.bitrix_id = request.counterparty_bitrix_id
          AND mapping.status = 'active'
     )
   ORDER BY request.request_id
   LIMIT 1;
  IF invalid_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'Bitrix request % lacks exact active client mapping', invalid_request_id
      USING ERRCODE = '23514', CONSTRAINT = 'chk_bitrix24_request_client_mapping';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ctrg_bitrix24_request_client_mapping ON crm_sync_mapping;
CREATE CONSTRAINT TRIGGER ctrg_bitrix24_request_client_mapping
AFTER INSERT OR UPDATE OR DELETE ON crm_sync_mapping
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_bitrix24_request_client_mappings();

CREATE OR REPLACE VIEW projects_view AS
SELECT
  p.project_id,
  p.code,
  p.name,
  p.client_id,
  c.client_name,
  p.notes,
  p.delete_flag,
  p.version,
  p.created_by,
  p.edited_by,
  p.created_at,
  p.updated_at,
  COUNT(o.order_id) FILTER (
    WHERE o.delete_flag = false AND o.order_kind = 'production_order'
  ) AS orders_count,
  COALESCE(SUM(o.final_amount) FILTER (
    WHERE o.delete_flag = false AND o.order_kind = 'production_order'
  ), 0) AS total_final_amount,
  COALESCE(SUM(o.paid_amount) FILTER (
    WHERE o.delete_flag = false AND o.order_kind = 'production_order'
  ), 0) AS total_paid_amount,
  MIN(o.order_date) FILTER (
    WHERE o.delete_flag = false AND o.order_kind = 'production_order'
  ) AS first_order_date,
  MAX(o.planned_completion_date) FILTER (
    WHERE o.delete_flag = false AND o.order_kind = 'production_order'
  ) AS last_planned_completion_date,
  COUNT(o.order_id) FILTER (
    WHERE o.delete_flag = false AND o.order_kind = 'draft'
  ) AS drafts_count,
  COUNT(o.order_id) FILTER (
    WHERE o.delete_flag = false AND o.order_kind = 'crm_request'
  ) AS crm_requests_count
FROM projects p
JOIN clients c ON c.client_id = p.client_id
LEFT JOIN orders o ON o.project_id = p.project_id
GROUP BY
  p.project_id,
  p.code,
  p.name,
  p.client_id,
  c.client_name,
  p.notes,
  p.delete_flag,
  p.version,
  p.created_by,
  p.edited_by,
  p.created_at,
  p.updated_at;

CREATE OR REPLACE VIEW orders_view AS
SELECT
    ord.order_id, ord.order_name,
    CASE
        WHEN order_name_digits.value = '' THEN NULL
        WHEN length(order_name_digits.value) > 10 THEN NULL
        WHEN order_name_digits.value::BIGINT > 2147483647 THEN NULL
        ELSE order_name_digits.value::INTEGER
    END AS order_name_numeric,
    ord.client_id, c.client_name, ord.order_date, ord.priority,
    d.doweling_order_id, d.doweling_order_name, emd.full_name AS design_engineer,
    ord.completion_date, ord.planned_completion_date,
    os.order_status_name, ps.payment_status_name, pr.production_status_name,
    ord.issue_date, ord.total_amount, ord.final_amount, ord.discount, ord.surcharge,
    ord.paid_amount, ord.payment_date, ord.parts_count, ord.total_area,
    mt.milling_type_name, et.edge_type_name, f.film_name,
    smt.name AS material_name,
    ord.notes, ord.link_cutting_file, ord.link_cutting_image_file,
    ord.ref_key_1c AS order_ref_key_1c, c.ref_key_1c AS client_ref_key_1c,
    ord.manager_id, ord.created_by, ord.edited_by, ord.created_at, ord.updated_at,
    ord.version, ord.sheet_material_type_id,
    ord.project_id,
    mp.code AS project_code,
    CASE WHEN mp.code IS NULL THEN NULL ELSE mp.code || '-' || ord.order_name END AS order_full_number,
    ord.order_kind,
    ord.source_system
FROM orders ord
CROSS JOIN LATERAL (
    VALUES (regexp_replace(COALESCE(ord.order_name, ''), '\D', '', 'g'))
) AS order_name_digits(value)
LEFT JOIN clients c ON ord.client_id = c.client_id
LEFT JOIN doweling_orders d ON ord.order_id = d.order_id
LEFT JOIN employees emd ON d.design_engineer_id = emd.employee_id
LEFT JOIN order_statuses os ON ord.order_status_id = os.order_status_id
LEFT JOIN payment_statuses ps ON ord.payment_status_id = ps.payment_status_id
LEFT JOIN production_statuses pr ON ord.production_status_id = pr.production_status_id
LEFT JOIN milling_types mt ON ord.milling_type_id = mt.milling_type_id
LEFT JOIN edge_types et ON ord.edge_type_id = et.edge_type_id
LEFT JOIN films f ON ord.film_id = f.film_id
LEFT JOIN sheet_material_types smt ON ord.sheet_material_type_id = smt.sheet_material_type_id
LEFT JOIN projects mp ON ord.project_id = mp.project_id
WHERE ord.delete_flag = false
  AND ord.order_kind = 'production_order'
ORDER BY ord.order_id DESC;

COMMIT;
