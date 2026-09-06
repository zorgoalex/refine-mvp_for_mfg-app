-- Bitrix24 Deal payment widget and durable ERP materialization command.
-- Additive only. Runtime remains disabled until the dedicated feature flag is on.

BEGIN;

ALTER TABLE bitrix24_app_installation
  ADD COLUMN IF NOT EXISTS executor_bitrix_user_id TEXT,
  ADD COLUMN IF NOT EXISTS executor_is_admin BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE bitrix24_app_installation
  DROP CONSTRAINT IF EXISTS chk_bitrix24_installation_executor_user;
ALTER TABLE bitrix24_app_installation
  ADD CONSTRAINT chk_bitrix24_installation_executor_user
  CHECK (
    executor_bitrix_user_id IS NULL
    OR executor_bitrix_user_id ~ '^[1-9][0-9]*$'
  );

CREATE TABLE IF NOT EXISTS bitrix24_app_install_attempt (
  attempt_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_token_hash           CHAR(64) NOT NULL UNIQUE
                               CHECK (state_token_hash ~ '^[0-9a-f]{64}$'),
  member_id                  TEXT NOT NULL,
  domain                     TEXT NOT NULL,
  access_token_ciphertext    TEXT NOT NULL,
  refresh_token_ciphertext   TEXT NOT NULL,
  access_token_expires_at    TIMESTAMPTZ NOT NULL,
  application_token_hash     CHAR(64) NOT NULL
                               CHECK (application_token_hash ~ '^[0-9a-f]{64}$'),
  executor_bitrix_user_id    TEXT NOT NULL
                               CHECK (executor_bitrix_user_id ~ '^[1-9][0-9]*$'),
  status                     TEXT NOT NULL DEFAULT 'installing'
                               CHECK (status IN ('installing','promoted','failed','expired')),
  last_error                 TEXT,
  expires_at                 TIMESTAMPTZ NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at                TIMESTAMPTZ,
  CONSTRAINT chk_bitrix24_install_attempt_domain
    CHECK (domain = lower(domain) AND domain !~ '[/[:space:]]'),
  CONSTRAINT chk_bitrix24_install_attempt_expiry
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour')
);

CREATE INDEX IF NOT EXISTS idx_bitrix24_install_attempt_open
  ON bitrix24_app_install_attempt (member_id, created_at DESC)
  WHERE status='installing';

CREATE TABLE IF NOT EXISTS bitrix24_widget_session (
  session_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash                 CHAR(64) NOT NULL UNIQUE
                               CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  member_id                  TEXT NOT NULL REFERENCES bitrix24_app_installation(member_id),
  domain                     TEXT NOT NULL,
  placement                  TEXT NOT NULL CHECK (placement='CRM_DEAL_DETAIL_TAB'),
  bitrix_deal_id             TEXT NOT NULL CHECK (bitrix_deal_id ~ '^[1-9][0-9]*$'),
  bitrix_user_id             TEXT NOT NULL CHECK (bitrix_user_id ~ '^[1-9][0-9]*$'),
  erp_user_id                BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  access_token_ciphertext    TEXT NOT NULL,
  refresh_token_ciphertext   TEXT NOT NULL,
  access_token_expires_at    TIMESTAMPTZ NOT NULL,
  expires_at                 TIMESTAMPTZ NOT NULL,
  last_used_at               TIMESTAMPTZ,
  revoked_at                 TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bitrix24_widget_session_domain
    CHECK (domain = lower(domain) AND domain !~ '[/[:space:]]'),
  CONSTRAINT chk_bitrix24_widget_session_expiry
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour')
);

CREATE INDEX IF NOT EXISTS idx_bitrix24_widget_session_expiry
  ON bitrix24_widget_session (expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bitrix24_widget_session_actor
  ON bitrix24_widget_session (bitrix_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bitrix24_manual_payment_command (
  command_id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key                    UUID NOT NULL,
  request_hash                       CHAR(64) NOT NULL
                                       CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  member_id                          TEXT NOT NULL REFERENCES bitrix24_app_installation(member_id),
  domain                             TEXT NOT NULL,
  bitrix_deal_id                     TEXT NOT NULL CHECK (bitrix_deal_id ~ '^[1-9][0-9]*$'),
  bitrix_actor_user_id               TEXT NOT NULL CHECK (bitrix_actor_user_id ~ '^[1-9][0-9]*$'),
  erp_actor_user_id                  BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  bitrix_executor_user_id            TEXT NOT NULL CHECK (bitrix_executor_user_id ~ '^[1-9][0-9]*$'),
  materialization_executor_user_id   BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  authorization_mode                TEXT NOT NULL DEFAULT 'actor_plus_admin_executor'
                                       CHECK (authorization_mode='actor_plus_admin_executor'),
  originating_request_id             TEXT NOT NULL,
  request_id                         BIGINT REFERENCES bitrix24_incoming_request(request_id) ON DELETE RESTRICT,
  erp_order_id                       BIGINT REFERENCES orders(order_id) ON DELETE RESTRICT,
  expected_order_version             INTEGER CHECK (expected_order_version IS NULL OR expected_order_version > 0),
  bitrix_payment_id                  TEXT UNIQUE CHECK (bitrix_payment_id ~ '^[1-9][0-9]*$'),
  erp_payment_id                     BIGINT REFERENCES payments(payment_id) ON DELETE RESTRICT,
  amount                             NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency_id                        CHAR(3) NOT NULL CHECK (currency_id=upper(currency_id)),
  payment_date                       DATE NOT NULL,
  pay_system_id                      INTEGER NOT NULL CHECK (pay_system_id > 0),
  type_paid_id                       INTEGER NOT NULL REFERENCES payment_types(type_paid_id),
  comment                            TEXT CHECK (char_length(comment) <= 1000),
  overpayment_confirmed              BOOLEAN NOT NULL DEFAULT false,
  overpayment_confirmed_by           BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  overpayment_confirmed_at           TIMESTAMPTZ,
  before_payment_ids                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  diagnostic_candidate_ids           JSONB NOT NULL DEFAULT '[]'::jsonb,
  caller_access_token_ciphertext     TEXT,
  caller_refresh_token_ciphertext    TEXT,
  caller_access_token_expires_at     TIMESTAMPTZ,
  token_user_id                      TEXT CHECK (token_user_id ~ '^[1-9][0-9]*$'),
  status                             TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN (
      'processing','pre_create_saved','remote_create_started',
      'remote_create_ambiguous','remote_created','snapshot_saved',
      'awaiting_order','awaiting_order_ready','awaiting_erp_retry',
      'awaiting_overpayment_confirmation','awaiting_actor_reauth',
      'completed','confirmed_not_created','failed_terminal'
    )),
  attempts                           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token                        UUID,
  lease_expires_at                   TIMESTAMPTZ,
  remote_create_started_at           TIMESTAMPTZ,
  remote_create_response_at          TIMESTAMPTZ,
  version                            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  resolution                         TEXT CHECK (resolution IN ('attach_existing','confirm_absent')),
  resolved_by                        BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  resolution_reason                  TEXT CHECK (char_length(resolution_reason) <= 2000),
  resolved_at                        TIMESTAMPTZ,
  error_code                         TEXT,
  error_message                      TEXT,
  response_json                      JSONB,
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at                       TIMESTAMPTZ,
  CONSTRAINT uq_bitrix24_manual_payment_idempotency
    UNIQUE (member_id, bitrix_actor_user_id, idempotency_key),
  CONSTRAINT chk_bitrix24_manual_payment_domain
    CHECK (domain = lower(domain) AND domain !~ '[/[:space:]]'),
  CONSTRAINT chk_bitrix24_manual_payment_owner
    CHECK (request_id IS NOT NULL OR erp_order_id IS NOT NULL),
  CONSTRAINT chk_bitrix24_manual_payment_token_pair
    CHECK (
      (caller_access_token_ciphertext IS NULL) =
      (caller_refresh_token_ciphertext IS NULL)
    ),
  CONSTRAINT chk_bitrix24_manual_payment_overpayment_confirmation
    CHECK (
      (overpayment_confirmed=false AND overpayment_confirmed_by IS NULL AND overpayment_confirmed_at IS NULL)
      OR
      (overpayment_confirmed=true AND overpayment_confirmed_by IS NOT NULL AND overpayment_confirmed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bitrix24_manual_payment_remote_create
  ON bitrix24_manual_payment_command (member_id, bitrix_deal_id)
  WHERE status IN (
    'processing','pre_create_saved','remote_create_started','remote_create_ambiguous'
  );

CREATE INDEX IF NOT EXISTS idx_bitrix24_manual_payment_status
  ON bitrix24_manual_payment_command (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_bitrix24_manual_payment_order
  ON bitrix24_manual_payment_command (erp_order_id, created_at DESC)
  WHERE erp_order_id IS NOT NULL;

ALTER TABLE bitrix24_incoming_request_payment
  ADD COLUMN IF NOT EXISTS payment_local_date DATE,
  ADD COLUMN IF NOT EXISTS manual_command_id UUID;

UPDATE bitrix24_incoming_request_payment
   SET payment_local_date=(payment_date AT TIME ZONE 'Asia/Almaty')::date
 WHERE payment_local_date IS NULL
   AND payment_date IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='fk_bitrix24_request_payment_manual_command'
  ) THEN
    ALTER TABLE bitrix24_incoming_request_payment
      ADD CONSTRAINT fk_bitrix24_request_payment_manual_command
      FOREIGN KEY (manual_command_id)
      REFERENCES bitrix24_manual_payment_command(command_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bitrix24_request_payment_manual_command
  ON bitrix24_incoming_request_payment (manual_command_id)
  WHERE manual_command_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bitrix24_pay_system_catalog (
  pay_system_id          INTEGER PRIMARY KEY CHECK (pay_system_id > 0),
  name                   TEXT NOT NULL,
  description            TEXT,
  xml_id                 TEXT,
  active                 BOOLEAN NOT NULL,
  is_cash                BOOLEAN NOT NULL,
  allow_edit_payment     BOOLEAN NOT NULL,
  have_payment           BOOLEAN NOT NULL,
  entity_registry_type   TEXT,
  person_type_id         INTEGER,
  raw_hash               CHAR(64) NOT NULL CHECK (raw_hash ~ '^[0-9a-f]{64}$'),
  last_fetched_at        TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE bitrix24_payment_type_mapping
  ADD COLUMN IF NOT EXISTS widget_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bitrix24_payment_type_mapping_widget_default
  ON bitrix24_payment_type_mapping ((1))
  WHERE widget_enabled=true AND is_default=true AND active=true;

INSERT INTO permissions_catalog (
  permission_name, domain, label, description, sort_order, is_dangerous, is_active
)
VALUES
  (
    'bitrix24.payments.create', 'Bitrix24', 'Создание оплат из Bitrix24',
    'Создавать подтверждённые оплаты из виджета сделки Bitrix24', 475, true, true
  ),
  (
    'bitrix24.payments.confirm_overpayment', 'Bitrix24', 'Подтверждение переплаты Bitrix24',
    'Подтверждать перенос оплаты, создающей переплату заказа ERP', 476, true, true
  )
ON CONFLICT (permission_name) DO UPDATE
SET domain=EXCLUDED.domain,
    label=EXCLUDED.label,
    description=EXCLUDED.description,
    sort_order=EXCLUDED.sort_order,
    is_dangerous=EXCLUDED.is_dangerous,
    is_active=true,
    updated_at=now();

INSERT INTO role_permissions (role_id, permission_name, is_enabled)
SELECT role_id, permission_name, true
FROM (VALUES
  (1, 'bitrix24.payments.create'),
  (2, 'bitrix24.payments.create'),
  (10, 'bitrix24.payments.create'),
  (15, 'bitrix24.payments.create'),
  (1, 'bitrix24.payments.confirm_overpayment'),
  (2, 'bitrix24.payments.confirm_overpayment'),
  (15, 'bitrix24.payments.confirm_overpayment')
) AS grant_seed(role_id, permission_name)
WHERE EXISTS (SELECT 1 FROM roles role WHERE role.role_id=grant_seed.role_id)
ON CONFLICT (role_id, permission_name) DO UPDATE
SET is_enabled=true, updated_at=now();

UPDATE permissions_state
   SET version=version+1, updated_at=now()
 WHERE id=true;

COMMIT;
