-- Generic raw stdout/stderr sink for CNC Telegram worker diagnostics.
BEGIN;

CREATE TABLE IF NOT EXISTS cnc_telegram_worker_technical_logs (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_instance_id UUID NOT NULL,
  sequence BIGINT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  stream TEXT NOT NULL,
  message TEXT NOT NULL,
  redaction_version TEXT NOT NULL,
  redacted BOOLEAN NOT NULL DEFAULT false,
  truncated BOOLEAN NOT NULL DEFAULT false,
  redaction_categories TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  dropped_before INTEGER NOT NULL DEFAULT 0,
  batch_id UUID NOT NULL,
  writer_user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cnc_tg_technical_instance_sequence UNIQUE (worker_instance_id, sequence),
  CONSTRAINT chk_cnc_tg_technical_sequence CHECK (sequence > 0),
  CONSTRAINT chk_cnc_tg_technical_stream CHECK (stream IN ('stdout', 'stderr')),
  CONSTRAINT chk_cnc_tg_technical_message CHECK (char_length(message) BETWEEN 1 AND 8192),
  CONSTRAINT chk_cnc_tg_technical_redaction_version CHECK (char_length(redaction_version) BETWEEN 1 AND 64),
  CONSTRAINT chk_cnc_tg_technical_redaction_categories CHECK (cardinality(redaction_categories) <= 16),
  CONSTRAINT chk_cnc_tg_technical_dropped CHECK (dropped_before >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cnc_tg_technical_observed
  ON cnc_telegram_worker_technical_logs(observed_at DESC, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_technical_instance_observed
  ON cnc_telegram_worker_technical_logs(worker_instance_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_cnc_tg_technical_stream_observed
  ON cnc_telegram_worker_technical_logs(stream, observed_at DESC);

INSERT INTO permissions_catalog (
  permission_name, domain, label, description, sort_order, is_dangerous, is_active
)
VALUES (
  'audit.technical.view', 'audit', 'Просмотр технических логов',
  'Доступ к raw stdout/stderr внутренних worker-процессов', 161, true, true
)
ON CONFLICT (permission_name) DO UPDATE
SET domain=EXCLUDED.domain,
    label=EXCLUDED.label,
    description=EXCLUDED.description,
    is_dangerous=EXCLUDED.is_dangerous,
    is_active=true,
    updated_at=now();

INSERT INTO role_permissions (role_id, permission_name, is_enabled)
SELECT role_id, 'audit.technical.view', true
FROM roles
WHERE role_code IN ('admin', 'superadmin')
ON CONFLICT (role_id, permission_name) DO NOTHING;

UPDATE permissions_state SET version=version+1, updated_at=now() WHERE id=true;

COMMIT;
