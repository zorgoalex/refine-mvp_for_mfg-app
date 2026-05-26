import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./008_deadline_rule_override_contract.sql', import.meta.url),
  'utf8',
);

function getStatement(name: RegExp): string {
  const statement = migration
    .split(';')
    .find((candidate) => name.test(candidate));

  expect(statement).toBeDefined();

  return `${statement};`;
}

describe('deadline rule and override contract migration', () => {
  it('adds deterministic rule priority and execution snapshot columns additively', () => {
    expect(migration).toMatch(
      /ALTER TABLE deadline_action_rules\s+ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100/i,
    );
    expect(migration).toMatch(
      /ALTER TABLE deadline_action_executions\s+ADD COLUMN IF NOT EXISTS rule_config_snapshot_json JSONB NOT NULL DEFAULT '\{\}'::jsonb/i,
    );
    expect(migration).toMatch(
      /ALTER TABLE deadline_action_executions\s+ADD COLUMN IF NOT EXISTS rule_version_id UUID/i,
    );
    expect(migration).toMatch(
      /ALTER TABLE deadline_action_executions\s+ADD COLUMN IF NOT EXISTS order_id BIGINT/i,
    );
    expect(migration).toMatch(
      /ALTER TABLE deadline_action_executions\s+ADD COLUMN IF NOT EXISTS target_status_id BIGINT/i,
    );
    expect(migration).toMatch(/idx_deadline_action_rules_evaluation/i);
    expect(migration).toMatch(/ON deadline_action_rules\s*\(\s*scope_type\s*,\s*event_type\s*,\s*priority\s*,\s*created_at\s*,\s*action_rule_id\s*\)/i);
  });

  it('creates order overrides with exactly-one policy/action constraint and active uniqueness', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS deadline_order_overrides/i);
    expect(migration).toMatch(/override_id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
    expect(migration).toMatch(/order_id BIGINT NOT NULL/i);
    expect(migration).toMatch(
      /policy_id UUID REFERENCES deadline_policies\(policy_id\) ON DELETE RESTRICT/i,
    );
    expect(migration).toMatch(
      /action_rule_id UUID REFERENCES deadline_action_rules\(action_rule_id\) ON DELETE RESTRICT/i,
    );
    expect(migration).toMatch(/reason TEXT NOT NULL/i);
    expect(migration).toMatch(/created_by_user_id BIGINT NOT NULL/i);
    expect(migration).toMatch(/updated_by_user_id BIGINT NOT NULL/i);
    expect(migration).toMatch(/retired_by_user_id BIGINT/i);
    expect(migration).toContain('chk_deadline_order_overrides_exactly_one_target');
    expect(migration).toMatch(/policy_id IS NOT NULL AND action_rule_id IS NULL/i);
    expect(migration).toMatch(/policy_id IS NULL AND action_rule_id IS NOT NULL/i);

    const policyUnique = getStatement(/uq_deadline_order_overrides_active_policy/i);
    expect(policyUnique).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_deadline_order_overrides_active_policy/i);
    expect(policyUnique).toMatch(/ON deadline_order_overrides\s*\(\s*order_id\s*,\s*policy_id\s*\)/i);
    expect(policyUnique).toMatch(/WHERE retired_at IS NULL AND policy_id IS NOT NULL/i);

    const actionUnique = getStatement(/uq_deadline_order_overrides_active_action_rule/i);
    expect(actionUnique).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_deadline_order_overrides_active_action_rule/i);
    expect(actionUnique).toMatch(/ON deadline_order_overrides\s*\(\s*order_id\s*,\s*action_rule_id\s*\)/i);
    expect(actionUnique).toMatch(/WHERE retired_at IS NULL AND action_rule_id IS NOT NULL/i);
  });

  it('adds lookup indexes and updated_at maintenance without destructive operations', () => {
    expect(migration).toMatch(/idx_deadline_order_overrides_order_active/i);
    expect(migration).toMatch(/idx_deadline_order_overrides_policy_lookup/i);
    expect(migration).toMatch(/idx_deadline_order_overrides_action_rule_lookup/i);
    expect(migration).toMatch(/deadline_order_overrides_updated_at/i);
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migration).not.toMatch(/\bDROP\s+INDEX\b/i);
    expect(migration).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
