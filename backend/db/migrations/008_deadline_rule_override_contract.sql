-- Deadline Engine rule/override contract.
--
-- Adds deterministic rule evaluation fields, immutable execution evidence, and
-- order-level override storage for later backend command/evaluator slices.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE deadline_action_rules
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100;

CREATE INDEX IF NOT EXISTS idx_deadline_action_rules_evaluation
  ON deadline_action_rules(scope_type, event_type, priority, created_at, action_rule_id);

ALTER TABLE deadline_action_executions
  ADD COLUMN IF NOT EXISTS rule_config_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE deadline_action_executions
  ADD COLUMN IF NOT EXISTS rule_version_id UUID;

ALTER TABLE deadline_action_executions
  ADD COLUMN IF NOT EXISTS order_id BIGINT;

ALTER TABLE deadline_action_executions
  ADD COLUMN IF NOT EXISTS target_status_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_deadline_action_executions_order
  ON deadline_action_executions(order_id, created_at DESC)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deadline_action_executions_rule_order
  ON deadline_action_executions(action_rule_id, order_id, created_at DESC)
  WHERE action_rule_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS deadline_order_overrides (
  override_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id BIGINT NOT NULL,
  policy_id UUID REFERENCES deadline_policies(policy_id) ON DELETE RESTRICT,
  action_rule_id UUID REFERENCES deadline_action_rules(action_rule_id) ON DELETE RESTRICT,
  is_disabled BOOLEAN NOT NULL DEFAULT false,
  override_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT NOT NULL,
  created_by_user_id BIGINT NOT NULL,
  updated_by_user_id BIGINT NOT NULL,
  retired_by_user_id BIGINT,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_deadline_order_overrides_exactly_one_target
    CHECK (
      (policy_id IS NOT NULL AND action_rule_id IS NULL)
      OR (policy_id IS NULL AND action_rule_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_deadline_order_overrides_active_policy
  ON deadline_order_overrides(order_id, policy_id)
  WHERE retired_at IS NULL AND policy_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_deadline_order_overrides_active_action_rule
  ON deadline_order_overrides(order_id, action_rule_id)
  WHERE retired_at IS NULL AND action_rule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deadline_order_overrides_order_active
  ON deadline_order_overrides(order_id, retired_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_deadline_order_overrides_policy_lookup
  ON deadline_order_overrides(policy_id, order_id)
  WHERE policy_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deadline_order_overrides_action_rule_lookup
  ON deadline_order_overrides(action_rule_id, order_id)
  WHERE action_rule_id IS NOT NULL;

CREATE OR REPLACE FUNCTION deadline_order_overrides_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'deadline_order_overrides_updated_at'
      AND tgrelid = 'deadline_order_overrides'::regclass
  ) THEN
    CREATE TRIGGER deadline_order_overrides_updated_at
      BEFORE UPDATE ON deadline_order_overrides
      FOR EACH ROW
      EXECUTE FUNCTION deadline_order_overrides_set_updated_at();
  END IF;
END;
$$;

COMMIT;
