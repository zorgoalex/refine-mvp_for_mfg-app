-- Production actions/calendar moves additive contracts.
--
-- Adds command idempotency, outbox idempotency, queryable audit dimensions,
-- and exposes orders.version in orders_view for stale-safe calendar commands.

BEGIN;

CREATE TABLE IF NOT EXISTS command_idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  command_name TEXT NOT NULL,
  actor_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json JSONB,
  status TEXT NOT NULL DEFAULT 'processing',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT chk_command_idempotency_status
    CHECK (status IN ('processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_command_idempotency_command_entity_created_at
  ON command_idempotency_keys(command_name, entity_type, entity_id, created_at DESC);

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_events_idempotency_key
  ON outbox_events(idempotency_key);

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS related_order_id BIGINT,
  ADD COLUMN IF NOT EXISTS related_client_id BIGINT,
  ADD COLUMN IF NOT EXISTS related_production_event_id BIGINT,
  ADD COLUMN IF NOT EXISTS status_field TEXT,
  ADD COLUMN IF NOT EXISTS status_id BIGINT,
  ADD COLUMN IF NOT EXISTS status_name TEXT,
  ADD COLUMN IF NOT EXISTS status_code TEXT,
  ADD COLUMN IF NOT EXISTS stage_code TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_log_source_created_at
  ON audit_log(source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_related_order_created_at
  ON audit_log(related_order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_related_client_created_at
  ON audit_log(related_client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_related_production_event_created_at
  ON audit_log(related_production_event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_status_field_id_created_at
  ON audit_log(status_field, status_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_status_field_name_created_at
  ON audit_log(status_field, status_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_stage_code_created_at
  ON audit_log(stage_code, created_at DESC);

CREATE OR REPLACE VIEW orders_view AS
SELECT
    ord.order_id,
    ord.order_name,
    CASE
        WHEN order_name_digits.value = '' THEN NULL
        WHEN length(order_name_digits.value) > 10 THEN NULL
        WHEN order_name_digits.value::BIGINT > 2147483647 THEN NULL
        ELSE order_name_digits.value::INTEGER
    END AS order_name_numeric,
    ord.client_id,
    c.client_name,
    ord.order_date,
    ord.priority,
    d.doweling_order_id,
    d.doweling_order_name,
    emd.full_name AS design_engineer,
    ord.completion_date,
    ord.planned_completion_date,
    os.order_status_name,
    ps.payment_status_name,
    pr.production_status_name,
    ord.issue_date,
    ord.total_amount,
    ord.final_amount,
    ord.discount,
    ord.surcharge,
    ord.paid_amount,
    ord.payment_date,
    ord.parts_count,
    ord.total_area,
    mt.milling_type_name,
    et.edge_type_name,
    f.film_name,
    m.material_name,
    ord.notes,
    ord.link_cutting_file,
    ord.link_cutting_image_file,
    ord.ref_key_1c AS order_ref_key_1c,
    c.ref_key_1c AS client_ref_key_1c,
    ord.manager_id,
    ord.created_by,
    ord.edited_by,
    ord.created_at,
    ord.updated_at,
    ord.version
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
LEFT JOIN materials m ON ord.material_id = m.material_id
WHERE ord.delete_flag = false
ORDER BY ord.order_id DESC;

COMMENT ON VIEW orders_view IS 'Агрегированное представление заказов с audit-полями для UI';

COMMIT;
