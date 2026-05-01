import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('./002_deadline_engine.sql', import.meta.url), 'utf8');

describe('deadline engine migration', () => {
  it('creates the deadline domain tables and outbox without mutating orders', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS deadline_policies/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS deadline_policy_versions/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS deadline_instances/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS deadline_events/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS deadline_action_rules/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS deadline_action_executions/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS deadline_pauses/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS deadline_reminder_rules/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS outbox_events/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS notifications/i);
    expect(migration).not.toMatch(/ALTER TABLE\s+orders\b/i);
    expect(migration).not.toMatch(/ALTER TABLE\s+order_workshops\b/i);
  });

  it('enforces enum-like statuses and idempotent action executions', () => {
    expect(migration).toContain('chk_deadline_instances_status');
    expect(migration).toContain('completed_on_time');
    expect(migration).toContain('completed_late');
    expect(migration).toContain('chk_deadline_action_executions_status');
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_deadline_action_executions_idempotency/i);
  });

  it('adds indexes required for due scans and order read models', () => {
    expect(migration).toMatch(/idx_deadline_instances_due/i);
    expect(migration).toMatch(/idx_deadline_instances_order/i);
    expect(migration).toMatch(/idx_deadline_events_order/i);
    expect(migration).toMatch(/idx_outbox_events_pending/i);
  });
});
