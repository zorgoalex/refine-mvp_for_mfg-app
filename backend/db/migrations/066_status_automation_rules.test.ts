import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./066_status_automation_rules.sql', import.meta.url), 'utf8');

describe('066_status_automation_rules migration', () => {
  it('creates the status automation rules table idempotently', () => {
    expect(sql).toMatch(/BEGIN;/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS status_automation_rules/i);
    expect(sql).toMatch(/COMMIT;/i);
  });

  it('defines the rule fields, action constraint, and dispatch index', () => {
    expect(sql).toMatch(/id\s+bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY/i);
    expect(sql).toMatch(/name\s+text\s+NOT NULL CHECK \(length\(btrim\(name\)\) BETWEEN 1 AND 200\)/i);
    expect(sql).toMatch(/action_type\s+text\s+NOT NULL CHECK \(action_type IN/i);
    expect(sql).toMatch(/target_status_id\s+bigint\s+NOT NULL/i);
    expect(sql).toMatch(/conditions_json\s+jsonb\s+NOT NULL DEFAULT '\{\}'::jsonb/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_status_automation_rules_dispatch/i);
    expect(sql).toMatch(/ON status_automation_rules \(event_type, is_enabled, priority, id\)/i);
  });
});
