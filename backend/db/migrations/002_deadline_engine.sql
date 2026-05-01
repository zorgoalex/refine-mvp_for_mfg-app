-- Backend ERP deadline engine additive migration draft.
--
-- This migration is intentionally additive. It creates the deadline engine
-- domain tables without changing orders, order_workshops, or production status
-- semantics. Run backend/db/prechecks/002_deadline_engine_precheck.sql before
-- applying this to a shared database.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS deadline_policies (
  policy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_code TEXT NOT NULL,
  policy_name TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  target_type TEXT,
  target_code TEXT,
  duration_value INTEGER,
  duration_unit TEXT,
  start_point TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_deadline_policies_scope_type
    CHECK (scope_type IN ('order', 'order_stage', 'client_action', 'project', 'task')),
  CONSTRAINT chk_deadline_policies_duration_unit
    CHECK (
      duration_unit IS NULL
      OR duration_unit IN ('minute', 'hour', 'day', 'working_hour', 'working_day')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_deadline_policies_code
  ON deadline_policies(policy_code);

CREATE TABLE IF NOT EXISTS deadline_policy_versions (
  policy_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID NOT NULL REFERENCES deadline_policies(policy_id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  config_json JSONB NOT NULL,
  created_by_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_deadline_policy_versions_policy_version
    UNIQUE (policy_id, version_number)
);

CREATE TABLE IF NOT EXISTS deadline_instances (
  deadline_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID REFERENCES deadline_policies(policy_id) ON DELETE SET NULL,
  policy_version_id UUID REFERENCES deadline_policy_versions(policy_version_id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  parent_entity_type TEXT,
  parent_entity_id TEXT,
  order_id BIGINT REFERENCES orders(order_id) ON DELETE CASCADE,
  order_workshop_id BIGINT,
  client_id BIGINT,
  responsible_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'manual',
  is_manually_overridden BOOLEAN NOT NULL DEFAULT false,
  policy_snapshot_json JSONB,
  metadata_json JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  updated_by_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_deadline_instances_status
    CHECK (
      status IN (
        'active',
        'paused',
        'expired',
        'completed_on_time',
        'completed_late',
        'cancelled',
        'superseded'
      )
    ),
  CONSTRAINT chk_deadline_instances_source
    CHECK (source IN ('policy', 'manual', 'imported', 'recalculated', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_deadline_instances_due
  ON deadline_instances(deadline_at, status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_deadline_instances_entity
  ON deadline_instances(entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_deadline_instances_order
  ON deadline_instances(order_id, deadline_at DESC);

CREATE INDEX IF NOT EXISTS idx_deadline_instances_responsible
  ON deadline_instances(responsible_user_id, deadline_at DESC);

CREATE TABLE IF NOT EXISTS deadline_events (
  deadline_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deadline_id UUID NOT NULL REFERENCES deadline_instances(deadline_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  order_id BIGINT REFERENCES orders(order_id) ON DELETE CASCADE,
  order_workshop_id BIGINT,
  client_id BIGINT,
  deadline_at TIMESTAMPTZ,
  event_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delay_minutes INTEGER,
  payload_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_deadline_events_severity
    CHECK (severity IN ('info', 'warning', 'critical'))
);

CREATE INDEX IF NOT EXISTS idx_deadline_events_deadline
  ON deadline_events(deadline_id, event_at DESC);

CREATE INDEX IF NOT EXISTS idx_deadline_events_entity
  ON deadline_events(entity_type, entity_id, event_at DESC);

CREATE INDEX IF NOT EXISTS idx_deadline_events_order
  ON deadline_events(order_id, event_at DESC);

CREATE INDEX IF NOT EXISTS idx_deadline_events_type
  ON deadline_events(event_type, event_at DESC);

CREATE TABLE IF NOT EXISTS deadline_action_rules (
  action_rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID REFERENCES deadline_policies(policy_id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  event_type TEXT NOT NULL,
  action_type TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deadline_action_rules_lookup
  ON deadline_action_rules(scope_type, event_type, action_type);

CREATE TABLE IF NOT EXISTS deadline_action_executions (
  action_execution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deadline_event_id UUID NOT NULL REFERENCES deadline_events(deadline_event_id) ON DELETE CASCADE,
  action_rule_id UUID REFERENCES deadline_action_rules(action_rule_id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  skip_reason TEXT,
  error_code TEXT,
  error_message TEXT,
  result_json JSONB,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_deadline_action_executions_status
    CHECK (status IN ('executed', 'skipped', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_deadline_action_executions_idempotency
  ON deadline_action_executions(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_deadline_action_executions_event
  ON deadline_action_executions(deadline_event_id);

CREATE TABLE IF NOT EXISTS deadline_pauses (
  deadline_pause_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deadline_id UUID NOT NULL REFERENCES deadline_instances(deadline_id) ON DELETE CASCADE,
  pause_reason TEXT NOT NULL,
  pause_mode TEXT NOT NULL,
  paused_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resumed_at TIMESTAMPTZ,
  paused_by_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  resumed_by_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  notes TEXT,
  CONSTRAINT chk_deadline_pauses_mode
    CHECK (pause_mode IN ('pause_without_shift', 'pause_and_shift_deadline'))
);

CREATE TABLE IF NOT EXISTS deadline_reminder_rules (
  reminder_rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID REFERENCES deadline_policies(policy_id) ON DELETE CASCADE,
  event_offset_minutes INTEGER NOT NULL,
  reminder_type TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_deadline_reminder_type
    CHECK (reminder_type IN ('before_deadline', 'after_deadline', 'repeat_after_expiration'))
);

CREATE TABLE IF NOT EXISTS outbox_events (
  outbox_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT chk_outbox_events_status
    CHECK (status IN ('pending', 'processing', 'processed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_pending
  ON outbox_events(next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS notifications (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  CONSTRAINT chk_notifications_level
    CHECK (level IN ('info', 'warning', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, created_at DESC)
  WHERE is_read = false;

COMMIT;
