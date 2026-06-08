import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./014_notification_rules.sql', import.meta.url), 'utf8');

describe('014_notification_rules migration', () => {
  it('creates notification_rules additively without touching outbox/notifications', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS notification_rules/i);
    expect(sql).toMatch(/rule_code\s+TEXT\s+UNIQUE\s+NOT NULL/i);
    expect(sql).toMatch(/event_type\s+TEXT\s+NOT NULL/i);
    expect(sql).toMatch(/conditions_json\s+JSONB/i);
    expect(sql).toMatch(/recipients_json\s+JSONB/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_notification_rules_event/i);
    expect(sql).not.toMatch(/ALTER TABLE outbox_events/i);
    expect(sql).not.toMatch(/ALTER TABLE notifications/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
  });
});
