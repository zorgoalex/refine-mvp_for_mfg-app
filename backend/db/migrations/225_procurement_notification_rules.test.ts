import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./225_procurement_notification_rules.sql', import.meta.url), 'utf8');

describe('225_procurement_notification_rules migration', () => {
  it('seeds «material arrived» disabled, in_app only, receipt allocations only, to the order manager', () => {
    expect(sql).toMatch(/'procurement-material-arrived',\s*'order\.resource_procurement_changed',\s*false,/);
    expect(sql).toMatch(/"procurementChangeTypes":\["allocation_added"\],"allocationRoles":\["receipt"\]/);
    expect(sql).toMatch(/'\{"resolvers":\["order_manager"\]\}'::jsonb/);
    expect(sql).toMatch(/'\["in_app"\]'::jsonb/);
    expect(sql).toMatch(/ON CONFLICT \(rule_code\) DO NOTHING/);
  });

  it('is data configuration only: no DDL, no notifications, no outbox events', () => {
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE|DELETE|UPDATE)\b/i);
    expect(sql).not.toMatch(/INSERT INTO (notifications|outbox_events)\b/i);
  });
});
