import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./019_final_order_deadline_notification_rule.sql', import.meta.url), 'utf8');
const normalizedSql = sql
  .replace(/"([^"]+)"/g, '$1')
  .replace(/\s*\.\s*/g, '.')
  .replace(/\s+/g, ' ');
const protectedTables = [
  'orders',
  'deadline_instances',
  'deadline_events',
  'deadline_policies',
  'deadline_policy_versions',
  'deadline_action_rules',
  'deadline_action_executions',
  'deadline_pauses',
  'deadline_reminder_rules',
  'deadline_order_overrides',
  'notifications',
  'outbox_events',
];

describe('019_final_order_deadline_notification_rule migration', () => {
  it('inserts the final order deadline manager rule disabled with order-only conditions', () => {
    expect(sql).toMatch(/deadline-final-order-expired-manager/);
    expect(sql).toMatch(/DEADLINE_EXPIRED/);
    expect(sql).toMatch(/false,\s*-- is_enabled/i);
    expect(sql).toMatch(/'DEADLINE_EXPIRED',\s*false,/i);
    expect(sql).toMatch(/90,\s*[\r\n]\s*'warning'/);
    expect(sql).toMatch(/"deadlineEntityTypes":\s*\["order"\]/);
    expect(sql).toMatch(/"excludeOrderStatusIds":\s*\[7\]/);
    expect(sql).toMatch(/"excludeCompletedOrders":\s*true/);
    expect(sql).toMatch(/"requireCurrentDeadlineEvent":\s*true/);
    expect(sql).toMatch(/"resolvers":\s*\["order_manager"\]/);
  });

  it('keeps conditions_json narrowed to the approved final-order notification predicates', () => {
    const conditionsMatch = sql.match(/'(\{[^']*"deadlineEntityTypes"[^']*\})'::jsonb/);
    expect(conditionsMatch).not.toBeNull();
    const conditions = JSON.parse(conditionsMatch?.[1] ?? '{}') as Record<string, unknown>;

    expect(conditions).toEqual({
      deadlineEntityTypes: ['order'],
      excludeOrderStatusIds: [7],
      excludeCompletedOrders: true,
      requireCurrentDeadlineEvent: true,
    });
  });

  it('does not alter runtime flags, worker ownership, orders, deadlines, outbox, or notifications', () => {
    expect(sql).not.toMatch(/BACKEND_/);
    expect(normalizedSql).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO)\s+(?:ONLY\s+)?(?:public\.)?[^;\s]*(?:worker|scheduler|relay)/i,
    );
    for (const tableName of protectedTables) {
      expect(normalizedSql).not.toMatch(mutationPatternFor(tableName));
    }
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(normalizedSql).not.toMatch(mutationPatternFor('notification_rules', ['UPDATE', 'DELETE FROM', 'TRUNCATE', 'MERGE INTO']));
  });

  it('does not overwrite an existing operator-managed rule with the same code', () => {
    expect(sql).toMatch(/ON CONFLICT \(rule_code\) DO NOTHING/i);
    expect(sql).not.toMatch(/DO UPDATE/i);
  });
});

function mutationPatternFor(
  tableName: string,
  statements = ['INSERT INTO', 'UPDATE', 'DELETE FROM', 'TRUNCATE', 'MERGE INTO'],
): RegExp {
  const escapedName = tableName.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const statementPattern = statements.map((statement) => statement.replace(' ', String.raw`\s+`)).join('|');

  return new RegExp(String.raw`(?:${statementPattern})\s+(?:ONLY\s+)?(?:public\.)?${escapedName}\b`, 'i');
}
