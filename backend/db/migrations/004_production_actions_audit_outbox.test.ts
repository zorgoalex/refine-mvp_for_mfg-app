import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./004_production_actions_audit_outbox.sql', import.meta.url),
  'utf8',
);

describe('production actions audit/outbox migration', () => {
  it('adds command and outbox idempotency contracts', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS command_idempotency_keys/i);
    expect(migration).toContain('idempotency_key TEXT PRIMARY KEY');
    expect(migration).toContain('request_hash TEXT NOT NULL');
    expect(migration).toContain('response_json JSONB');
    expect(migration).toMatch(/ALTER TABLE outbox_events\s+ADD COLUMN IF NOT EXISTS idempotency_key TEXT/i);
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_events_idempotency_key/i);
    expect(migration).not.toMatch(/WHERE\s+idempotency_key\s+IS\s+NOT\s+NULL/i);
  });

  it('adds queryable audit dimensions for production commands', () => {
    for (const column of [
      'source TEXT',
      'related_order_id BIGINT',
      'related_client_id BIGINT',
      'related_production_event_id BIGINT',
      'status_field TEXT',
      'status_id BIGINT',
      'status_name TEXT',
      'stage_code TEXT',
    ]) {
      expect(migration).toContain(column);
    }

    expect(migration).toContain('idx_audit_log_related_order_created_at');
    expect(migration).toContain('idx_audit_log_stage_code_created_at');
  });

  it('recreates orders_view with version for stale-safe calendar commands', () => {
    expect(migration).toMatch(/CREATE OR REPLACE VIEW orders_view/i);
    expect(migration).toContain('ord.version');
    expect(migration).toContain('order_name_digits.value::BIGINT > 2147483647');
  });
});
