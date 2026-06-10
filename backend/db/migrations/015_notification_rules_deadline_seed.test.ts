import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./015_notification_rules_deadline_seed.sql', import.meta.url), 'utf8');

describe('015_notification_rules_deadline_seed migration', () => {
  it('inserts the four parity rules idempotently with ON CONFLICT DO NOTHING', () => {
    expect(sql).toMatch(/INSERT INTO notification_rules/i);
    expect(sql).toMatch(/ON CONFLICT \(rule_code\) DO NOTHING/i);
    expect(sql).toMatch(/'deadline-expired-notify-manager'/);
    expect(sql).toMatch(/'deadline-expired-notify-assignee'/);
    expect(sql).toMatch(/'deadline-expired-project-participants'/);
    expect(sql).toMatch(/'deadline-expired-escalate-manager'/);
  });

  it('keys all rules on the inner deadline type DEADLINE_EXPIRED', () => {
    const matches = sql.match(/'DEADLINE_EXPIRED'/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it('uses the supported resolvers (order_manager, stage_assignee, project_participants) and skips department_head', () => {
    expect(sql).toMatch(/"resolvers":\s*\["order_manager"\]/);
    expect(sql).toMatch(/"resolvers":\s*\["stage_assignee"\]/);
    expect(sql).toMatch(/"resolvers":\s*\["project_participants"\]/);
    expect(sql).not.toMatch(/"department_head"/);
  });

  it('preserves the existing notification_rules shape and does not mutate other tables', () => {
    expect(sql).not.toMatch(/ALTER TABLE notification_rules/i);
    expect(sql).not.toMatch(/ALTER TABLE outbox_events/i);
    expect(sql).not.toMatch(/ALTER TABLE notifications/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
  });

  it('uses the engine whitelisted template placeholders', () => {
    expect(sql).toMatch(/\{orderId\}/);
  });
});
