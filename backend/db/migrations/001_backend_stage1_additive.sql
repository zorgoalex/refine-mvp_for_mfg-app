-- Backend ERP stage 1 additive migration draft.
--
-- This migration intentionally contains only additive or low-risk hardening changes.
-- It does not fix destructive/type-changing blockers such as:
-- - production_statuses UNIQUE(sort_order) vs duplicate seed values;
-- - material_unit_conversions.material_id INT vs materials.material_id BIGINT;
-- - order_resource_requirements.edge_type_id BIGINT vs edge_types.edge_type_id SMALLINT;
-- - order_resource_requirements.supplier_id BIGINT vs suppliers.supplier_id SMALLINT.
--
-- Those require an explicit pre-cutover data/schema decision.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Auth sessions are recommended by 02-auth-sessions.md. They let refresh token
-- rotation/reuse detection operate on a stable session id instead of loose rows.
CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  token_family_id UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  ip_address INET,
  user_agent TEXT,
  CONSTRAINT chk_auth_sessions_status
    CHECK (status IN ('active', 'revoked', 'expired', 'reuse_detected'))
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id
  ON auth_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_status
  ON auth_sessions(status);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_family_id
  ON auth_sessions(token_family_id);

-- Audit log for auth/orders/users/export/vlm. `event` is the canonical column
-- from 09-error-handling-logging-audit.md; generated `action` keeps compatibility
-- with 05-db-schema-mapping.md wording.
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event TEXT NOT NULL,
  action TEXT GENERATED ALWAYS AS (event) STORED,
  entity_type TEXT,
  entity_id TEXT,
  user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  username TEXT,
  role_code TEXT,
  role TEXT,
  request_id TEXT NOT NULL,
  ip_address INET,
  user_agent TEXT,
  before_json JSONB,
  after_json JSONB,
  diff_json JSONB,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
  ON audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity
  ON audit_log(entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_user
  ON audit_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_event
  ON audit_log(event, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_action
  ON audit_log(action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_request_id
  ON audit_log(request_id);

-- Upload records for VLM upload/analyze split.
CREATE TABLE IF NOT EXISTS file_uploads (
  upload_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  public_url TEXT,
  signed_url TEXT,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  width INTEGER,
  height INTEGER,
  purpose TEXT NOT NULL DEFAULT 'vlm',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_file_uploads_user_id_created_at
  ON file_uploads(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_file_uploads_purpose_created_at
  ON file_uploads(purpose, created_at DESC);

-- Optional now, useful once export/VLM moves to asynchronous execution.
CREATE TABLE IF NOT EXISTS integration_jobs (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  entity_type TEXT,
  entity_id TEXT,
  payload_json JSONB,
  result_json JSONB,
  error_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_integration_jobs_status
  ON integration_jobs(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_integration_jobs_entity
  ON integration_jobs(entity_type, entity_id, created_at DESC);

-- Refresh token hardening for rotation and reuse detection.
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS session_id UUID,
  ADD COLUMN IF NOT EXISTS token_family_id UUID,
  ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS replaced_by_token_id UUID,
  ADD COLUMN IF NOT EXISTS reuse_detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_refresh_tokens_session_id'
  ) THEN
    ALTER TABLE refresh_tokens
      ADD CONSTRAINT fk_refresh_tokens_session_id
      FOREIGN KEY (session_id) REFERENCES auth_sessions(session_id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_refresh_tokens_replaced_by_token_id'
  ) THEN
    ALTER TABLE refresh_tokens
      ADD CONSTRAINT fk_refresh_tokens_replaced_by_token_id
      FOREIGN KEY (replaced_by_token_id) REFERENCES refresh_tokens(token_id)
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session_id
  ON refresh_tokens(session_id);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_family_id
  ON refresh_tokens(token_family_id);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_reuse_detected_at
  ON refresh_tokens(reuse_detected_at)
  WHERE reuse_detected_at IS NOT NULL;

-- Stable role and payment status codes for backend policies/calculations.
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_code
  ON roles(role_code);

ALTER TABLE payment_statuses
  ADD COLUMN IF NOT EXISTS payment_status_code VARCHAR(64);

UPDATE payment_statuses
SET payment_status_code = CASE payment_status_name
  WHEN 'Не оплачен' THEN 'unpaid'
  WHEN 'Частично оплачен' THEN 'partial'
  WHEN 'Оплачен' THEN 'paid'
  WHEN 'В долг' THEN 'debt'
  WHEN 'За счет фирмы' THEN 'company_expense'
  WHEN 'Взаимозачет' THEN 'offset'
  ELSE payment_status_code
END
WHERE payment_status_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_statuses_code
  ON payment_statuses(payment_status_code)
  WHERE payment_status_code IS NOT NULL;

-- If the broken CREATE TABLE orders block was not applied as a valid constraint,
-- add the intended invariant safely as NOT VALID. Validation can run separately
-- after data cleanup.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_orders_final_amount_consistent'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT chk_orders_final_amount_consistent
      CHECK (
        final_amount IS NULL
        OR final_amount = ROUND(
          COALESCE(total_amount, 0)
          - COALESCE(discount, 0)
          + COALESCE(surcharge, 0),
          2
        )
      ) NOT VALID;
  END IF;
END
$$;

-- The existing uq_orr_order_resource constraint does not prevent duplicates
-- when nullable resource columns are NULL. These partial indexes are additive,
-- but they may fail if duplicate active rows already exist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_orr_active_material
  ON order_resource_requirements(order_id, material_id)
  WHERE is_active = true
    AND resource_type = 'material'
    AND material_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_orr_active_film
  ON order_resource_requirements(order_id, film_id)
  WHERE is_active = true
    AND resource_type = 'film'
    AND film_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_orr_active_edge
  ON order_resource_requirements(order_id, edge_type_id)
  WHERE is_active = true
    AND resource_type = 'edge'
    AND edge_type_id IS NOT NULL;

COMMIT;
