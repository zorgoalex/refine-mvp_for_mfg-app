import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./228_procurement_scheduled_notification_rules.sql', import.meta.url), 'utf8');

describe('228_procurement_scheduled_notification_rules migration', () => {
  it('seeds three disabled in_app rules: demand changed → order manager; digest and unallocated — switches without recipients', () => {
    expect(sql).toMatch(/'procurement-demand-changed', 'order\.resource_demand_changed_after_mark', false,/);
    expect(sql).toMatch(/'procurement-deficit-digest', 'procurement\.deficit_digest', false,/);
    expect(sql).toMatch(/'procurement-receipt-unallocated', 'procurement\.receipt_unallocated', false,/);
    expect(sql).toMatch(/'\{"resolvers":\["order_manager"\]\}'::jsonb/);
    expect(sql.match(/'\["in_app"\]'::jsonb/g)).toHaveLength(3);
    expect(sql).toMatch(/ON CONFLICT \(rule_code\) DO NOTHING/);
  });

  it('is data configuration only', () => {
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE|DELETE|UPDATE)\b/i);
    expect(sql).not.toMatch(/INSERT INTO (notifications|outbox_events)\b/i);
  });
});
