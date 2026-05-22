import { describe, expect, it } from 'vitest';
import fixtureLib from './deadline-worker-fixture-lib.js';

const {
  buildFixtureSql,
  hasProductionTarget,
  readFixtureConfig,
  restoreFixtureSql,
  snapshotFixtureSql,
} = fixtureLib;

describe('deadline worker fixture helper', () => {
  it('requires fixture key, fixture order id, and restore opt-in', () => {
    expect(() => readFixtureConfig({})).toThrow('DEADLINE_WORKER_FIXTURE_KEY is required');
    expect(() =>
      readFixtureConfig({
        DEADLINE_WORKER_FIXTURE_KEY: 'deadline-worker-write-canary-2026-05-22',
        DEADLINE_WORKER_FIXTURE_RESTORE: 'true',
      }),
    ).toThrow('DEADLINE_WORKER_FIXTURE_ORDER_ID is required');
    expect(() =>
      readFixtureConfig({
        DEADLINE_WORKER_FIXTURE_KEY: 'deadline-worker-write-canary-2026-05-22',
        DEADLINE_WORKER_FIXTURE_ORDER_ID: '11192',
      }),
    ).toThrow('DEADLINE_WORKER_FIXTURE_RESTORE=true is required');
  });

  it('rejects production-like targets by default', () => {
    expect(hasProductionTarget(['staging'])).toBe(false);
    expect(hasProductionTarget(['backend-test'])).toBe(false);
    expect(hasProductionTarget(['production'])).toBe(true);
    expect(hasProductionTarget(['prod-vps'])).toBe(true);
    expect(hasProductionTarget(['live'])).toBe(true);
  });

  it('builds fixture SQL scoped by fixture key and order id', () => {
    const config = readFixtureConfig({
      DEADLINE_WORKER_FIXTURE_KEY: 'deadline-worker-write-canary-2026-05-22',
      DEADLINE_WORKER_FIXTURE_RESTORE: 'true',
      DEADLINE_WORKER_FIXTURE_ORDER_ID: '11192',
      DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER: 'erp_test-postgresdb-1',
    });

    const sql = buildFixtureSql(config);

    expect(sql).toContain("'deadline-worker-write-canary-2026-05-22'");
    expect(sql).toContain('11192');
    expect(sql).toContain("fixtureRole', 'cancel'");
    expect(sql).toContain("fixtureRole', 'manual-worker'");
    expect(sql).toContain("fixtureRole', 'scheduled-worker'");
    expect(sql).toContain("action_type, is_enabled, config_json");
  });

  it('snapshots action rules and notifications as fixture evidence', () => {
    const config = readFixtureConfig({
      DEADLINE_WORKER_FIXTURE_KEY: 'deadline-worker-write-canary-2026-05-22',
      DEADLINE_WORKER_FIXTURE_RESTORE: 'true',
      DEADLINE_WORKER_FIXTURE_ORDER_ID: '11192',
    });

    const sql = snapshotFixtureSql(config);

    expect(sql).toContain("'actionRuleCount'");
    expect(sql).toContain("'notificationCount'");
    expect(sql).toMatch(/SELECT COUNT\(\*\)::int FROM fixture_action_rules/i);
    expect(sql).toMatch(
      /FROM notifications n[\s\S]*JOIN fixture_deadline_events fde ON fde\.deadline_event_id::text = n\.source_id[\s\S]*n\.source_type = 'deadline'/i,
    );
    expect(sql).toMatch(
      /fingerprint[\s\S]*action_rule_count[\s\S]*notification_count/i,
    );
  });

  it('builds restore SQL without broad deletes', () => {
    const config = readFixtureConfig({
      DEADLINE_WORKER_FIXTURE_KEY: 'deadline-worker-write-canary-2026-05-22',
      DEADLINE_WORKER_FIXTURE_RESTORE: 'true',
      DEADLINE_WORKER_FIXTURE_ORDER_ID: '11192',
    });

    const sql = restoreFixtureSql(config);
    const deleteStatements = [...sql.matchAll(/DELETE\s+FROM\s+([a-z_]+)\b[\s\S]*?;/gi)].map(
      ([statement, tableName]) => ({ statement, tableName }),
    );

    expect(sql).toContain("metadata_json->>'fixtureKey' = 'deadline-worker-write-canary-2026-05-22'");
    expect(sql).toContain("config_json->>'fixtureKey' = 'deadline-worker-write-canary-2026-05-22'");
    expect(sql).toMatch(
      /fixture_deadline\w*\s+AS\s*\([^)]*metadata_json->>'fixtureKey'\s*=\s*'deadline-worker-write-canary-2026-05-22'[^)]*order_id\s*=\s*11192[^)]*\)/i,
    );
    expect(sql).toMatch(
      /fixture_action_rule\w*\s+AS\s*\([^)]*config_json->>'fixtureKey'\s*=\s*'deadline-worker-write-canary-2026-05-22'[^)]*\)/i,
    );
    expect(deleteStatements.map(({ tableName }) => tableName)).toEqual([
      'deadline_action_executions',
      'outbox_events',
      'audit_log',
      'notifications',
      'deadline_events',
      'deadline_instances',
      'deadline_action_rules',
    ]);
    expect(deleteStatements[0].statement).toMatch(
      /DELETE\s+FROM\s+deadline_action_executions\b[\s\S]*WHERE[\s\S]*(fixture_deadline_events|fixture_action_rules|metadata_json->>'fixtureKey')/i,
    );
    expect(deleteStatements[1].statement).toMatch(
      /DELETE\s+FROM\s+outbox_events\b[\s\S]*WHERE[\s\S]*(fixture_deadline_events|fixture_deadline_instances|metadata_json->>'fixtureKey')/i,
    );
    expect(deleteStatements[2].statement).toMatch(
      /DELETE\s+FROM\s+audit_log\b[\s\S]*WHERE[\s\S]*(fixture_deadline_events|fixture_deadline_instances|metadata_json->>'fixtureKey')/i,
    );
    expect(deleteStatements[3].statement).toMatch(
      /DELETE\s+FROM\s+notifications\b[\s\S]*WHERE[\s\S]*source_type\s*=\s*'deadline'[\s\S]*fixture_deadline_events/i,
    );
    expect(deleteStatements[4].statement).toMatch(
      /DELETE\s+FROM\s+deadline_events\b[\s\S]*WHERE[\s\S]*(fixture_deadline_instances|metadata_json->>'fixtureKey')/i,
    );
    expect(deleteStatements[5].statement).toMatch(
      /DELETE\s+FROM\s+deadline_instances\b[\s\S]*WHERE[\s\S]*metadata_json->>'fixtureKey'\s*=\s*'deadline-worker-write-canary-2026-05-22'/i,
    );
    expect(deleteStatements[6].statement).toMatch(
      /DELETE\s+FROM\s+deadline_action_rules\b[\s\S]*WHERE[\s\S]*config_json->>'fixtureKey'\s*=\s*'deadline-worker-write-canary-2026-05-22'/i,
    );
    expect(sql).not.toMatch(/DELETE FROM deadline_instances\s*;/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
  });
});
