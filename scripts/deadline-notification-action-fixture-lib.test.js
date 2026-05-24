import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtureLib from './deadline-notification-action-fixture-lib.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const {
  buildFixtureSql,
  hasProductionTarget,
  readFixtureConfig,
  restoreFixtureSql,
  runSql,
  snapshotFixtureSql,
} = fixtureLib;

const validEnv = {
  DEADLINE_NOTIFICATION_ACTION_STAGE_CANARY: 'true',
  DEADLINE_NOTIFICATION_ACTION_RESTORE: 'true',
  DEADLINE_NOTIFICATION_ACTION_TARGET_ENV: 'backend-test',
  DEADLINE_NOTIFICATION_ACTION_FIXTURE_KEY:
    'deadline-notification-action-canary-2026-05-24',
  DEADLINE_NOTIFICATION_ACTION_ORDER_ID: '11192',
};

describe('deadline notification action fixture helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires canary, restore, target env, fixture key, and order id gates', () => {
    expect(() => readFixtureConfig({})).toThrow(
      'DEADLINE_NOTIFICATION_ACTION_STAGE_CANARY=true is required',
    );
    expect(() =>
      readFixtureConfig({
        DEADLINE_NOTIFICATION_ACTION_STAGE_CANARY: 'true',
        DEADLINE_NOTIFICATION_ACTION_RESTORE: 'true',
        DEADLINE_NOTIFICATION_ACTION_FIXTURE_KEY:
          'deadline-notification-action-canary-2026-05-24',
        DEADLINE_NOTIFICATION_ACTION_ORDER_ID: '11192',
      }),
    ).toThrow('DEADLINE_NOTIFICATION_ACTION_TARGET_ENV=backend-test is required');
    expect(() =>
      readFixtureConfig({
        DEADLINE_NOTIFICATION_ACTION_STAGE_CANARY: 'true',
        DEADLINE_NOTIFICATION_ACTION_RESTORE: 'true',
        DEADLINE_NOTIFICATION_ACTION_TARGET_ENV: 'staging',
        DEADLINE_NOTIFICATION_ACTION_FIXTURE_KEY:
          'deadline-notification-action-canary-2026-05-24',
        DEADLINE_NOTIFICATION_ACTION_ORDER_ID: '11192',
      }),
    ).toThrow('DEADLINE_NOTIFICATION_ACTION_TARGET_ENV=backend-test is required');
    expect(() =>
      readFixtureConfig({
        DEADLINE_NOTIFICATION_ACTION_STAGE_CANARY: 'true',
        DEADLINE_NOTIFICATION_ACTION_RESTORE: 'true',
        DEADLINE_NOTIFICATION_ACTION_TARGET_ENV: 'backend-test',
      }),
    ).toThrow('DEADLINE_NOTIFICATION_ACTION_FIXTURE_KEY is required');
    expect(() =>
      readFixtureConfig({
        DEADLINE_NOTIFICATION_ACTION_STAGE_CANARY: 'true',
        DEADLINE_NOTIFICATION_ACTION_RESTORE: 'true',
        DEADLINE_NOTIFICATION_ACTION_TARGET_ENV: 'backend-test',
        DEADLINE_NOTIFICATION_ACTION_FIXTURE_KEY:
          'deadline-notification-action-canary-2026-05-24',
      }),
    ).toThrow('DEADLINE_NOTIFICATION_ACTION_ORDER_ID is required');
    expect(() =>
      readFixtureConfig({
        DEADLINE_NOTIFICATION_ACTION_STAGE_CANARY: 'true',
        DEADLINE_NOTIFICATION_ACTION_TARGET_ENV: 'backend-test',
        DEADLINE_NOTIFICATION_ACTION_FIXTURE_KEY:
          'deadline-notification-action-canary-2026-05-24',
        DEADLINE_NOTIFICATION_ACTION_ORDER_ID: '11192',
      }),
    ).toThrow('DEADLINE_NOTIFICATION_ACTION_RESTORE=true is required');
    expect(() =>
      readFixtureConfig({
        DEADLINE_NOTIFICATION_ACTION_STAGE_CANARY: 'true',
        DEADLINE_NOTIFICATION_ACTION_RESTORE: 'true',
        DEADLINE_NOTIFICATION_ACTION_TARGET_ENV: 'backend-test',
        DEADLINE_NOTIFICATION_ACTION_FIXTURE_KEY:
          'deadline-notification-action-canary-2026-05-24',
        DEADLINE_NOTIFICATION_ACTION_ORDER_ID: '0',
      }),
    ).toThrow('DEADLINE_NOTIFICATION_ACTION_ORDER_ID must be a positive integer');
  });

  it('rejects production-like targets by default', () => {
    expect(hasProductionTarget(['backend-test'])).toBe(false);
    expect(hasProductionTarget(['erp_test'])).toBe(false);
    expect(hasProductionTarget(['production'])).toBe(true);
    expect(hasProductionTarget(['prod-vps'])).toBe(true);
    expect(hasProductionTarget(['live'])).toBe(true);
    expect(() =>
      readFixtureConfig({
        ...validEnv,
        DEADLINE_NOTIFICATION_ACTION_TARGET_ENV: 'production',
      }),
    ).toThrow('Refusing to run deadline notification action fixture against a production target');
    expect(() =>
      readFixtureConfig({
        ...validEnv,
        BACKEND_FQDN: 'backend-live.example.com',
      }),
    ).toThrow('Refusing to run deadline notification action fixture against a production target');
  });

  it('uses safe fixture defaults and accepts explicit fixture timing overrides', () => {
    expect(readFixtureConfig(validEnv)).toMatchObject({
      postgresContainer: 'erp_test-postgresdb-1',
      now: '2000-01-04T00:00:00.000Z',
      workerNow: '2000-01-04T00:01:00.000Z',
    });

    expect(
      readFixtureConfig({
        ...validEnv,
        DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER: 'custom-postgres',
        DEADLINE_NOTIFICATION_ACTION_NOW: '2000-02-04T00:00:00.000Z',
        DEADLINE_NOTIFICATION_ACTION_WORKER_NOW: '2000-02-04T00:01:00.000Z',
      }),
    ).toMatchObject({
      postgresContainer: 'custom-postgres',
      now: '2000-02-04T00:00:00.000Z',
      workerNow: '2000-02-04T00:01:00.000Z',
    });
  });

  it.each([
    ['COMPOSE_PROJECT_NAME', 'erp_prod'],
    ['FRONTEND_ORIGIN', 'https://app-live.example.com'],
    ['APP_ENV', 'production'],
    ['BACKEND_ENV', 'prod-vps'],
    ['BACKEND_NODE_ENV', 'live'],
    ['NODE_ENV', 'production'],
  ])('rejects production-like %s values', (key, value) => {
    expect(() =>
      readFixtureConfig({
        ...validEnv,
        [key]: value,
      }),
    ).toThrow('Refusing to run deadline notification action fixture against a production target');
  });

  it('builds one due deadline and one fixture-scoped notify_assignee action rule', () => {
    const config = readFixtureConfig(validEnv);

    const sql = buildFixtureSql(config);

    expect(sql).toContain("'deadline-notification-action-canary-2026-05-24'");
    expect(sql).toContain('11192');
    expect(sql.match(/INSERT INTO deadline_instances/gi)).toHaveLength(1);
    expect(sql.match(/INSERT INTO deadline_action_rules/gi)).toHaveLength(1);
    expect(sql).toContain("'DEADLINE_EXPIRED'");
    expect(sql).toContain("'notify_assignee'");
    expect(sql).toContain("scope_type,");
    expect(sql).toContain("'order'");
    expect(sql).toContain("jsonb_build_object('fixtureKey'");
    expect(sql).toContain("'fixtureRole', 'notification-action'");
    expect(sql).toContain("'workerNow', '2000-01-04T00:01:00.000Z'");
    expect(sql).toContain("'createdBy', 'deadline-notification-action-fixture'");
    expect(sql).toMatch(/JOIN users u ON u\.user_id = o\.manager_id/i);
    expect(sql).toMatch(/u\.is_active = true/i);
    expect(sql).toMatch(/o\.completion_date IS NULL/i);
    expect(sql).not.toMatch(
      /set_overdue_flag|change_order_status|change_production_status|create_task|escalate|webhook/i,
    );
    expect(sql).not.toMatch(/INSERT INTO deadline_policies/i);
    expect(sql).not.toMatch(/deadline_settings/i);
  });

  it('snapshots notification evidence and action execution result details', () => {
    const config = readFixtureConfig(validEnv);

    const sql = snapshotFixtureSql(config);

    expect(sql).toContain("'notificationCount'");
    expect(sql).toContain("'executedNotificationActions'");
    expect(sql).toContain("'notificationIdempotencyKey'");
    expect(sql).toMatch(
      /JOIN fixture_deadline_events fde ON fde\.deadline_event_id::text = n\.source_id/i,
    );
    expect(sql).toMatch(/n\.source_type = 'deadline'/i);
    expect(sql).toMatch(/dae\.result_json->>'notificationIdempotencyKey'/i);
    expect(sql).toMatch(/action_type = 'notify_assignee'/i);
  });

  it('builds restore SQL scoped by fixture deadline events and fixture action rule', () => {
    const config = readFixtureConfig(validEnv);

    const sql = restoreFixtureSql(config);
    const deleteStatements = [
      ...sql.matchAll(/DELETE\s+FROM\s+([a-z_]+)\b[\s\S]*?;/gi),
    ].map(([statement, tableName]) => ({ statement, tableName }));

    expect(sql).toContain(
      "metadata_json->>'fixtureKey' = 'deadline-notification-action-canary-2026-05-24'",
    );
    expect(sql).toContain(
      "config_json->>'fixtureKey' = 'deadline-notification-action-canary-2026-05-24'",
    );
    expect(deleteStatements.map(({ tableName }) => tableName)).toEqual([
      'deadline_action_executions',
      'notifications',
      'outbox_events',
      'audit_log',
      'deadline_events',
      'deadline_instances',
      'deadline_action_rules',
    ]);
    expect(deleteStatements[0].statement).toMatch(
      /DELETE\s+FROM\s+deadline_action_executions\b[\s\S]*WHERE[\s\S]*fixture_deadline_events/i,
    );
    expect(deleteStatements[1].statement).toMatch(
      /DELETE\s+FROM\s+notifications\b[\s\S]*WHERE[\s\S]*source_type\s*=\s*'deadline'[\s\S]*fixture_deadline_events/i,
    );
    expect(deleteStatements[2].statement).toMatch(
      /DELETE\s+FROM\s+outbox_events\b[\s\S]*WHERE[\s\S]*fixture_deadline_events/i,
    );
    expect(deleteStatements[3].statement).toMatch(
      /DELETE\s+FROM\s+audit_log\b[\s\S]*WHERE[\s\S]*fixture_deadline_events/i,
    );
    expect(deleteStatements[4].statement).toMatch(
      /DELETE\s+FROM\s+deadline_events\b[\s\S]*WHERE[\s\S]*fixture_deadline_instances/i,
    );
    expect(deleteStatements[5].statement).toMatch(
      /DELETE\s+FROM\s+deadline_instances\b[\s\S]*WHERE[\s\S]*metadata_json->>'fixtureKey'\s*=\s*'deadline-notification-action-canary-2026-05-24'/i,
    );
    expect(deleteStatements[6].statement).toMatch(
      /DELETE\s+FROM\s+deadline_action_rules\b[\s\S]*WHERE[\s\S]*config_json->>'fixtureKey'\s*=\s*'deadline-notification-action-canary-2026-05-24'/i,
    );
    expect(sql).not.toMatch(/DELETE FROM deadline_instances\s*;/i);
    expect(sql).not.toMatch(/DELETE FROM deadline_action_rules\s*;/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
  });

  it('runs SQL through docker exec psql and parses JSON output', () => {
    execFileSync.mockReturnValue('{"ok":true}\n');
    const config = readFixtureConfig({
      ...validEnv,
      DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER: 'custom-postgres',
    });

    const result = runSql(config, 'SELECT 1', { json: true, execFileSync });

    expect(result).toEqual({ ok: true });
    expect(execFileSync).toHaveBeenCalledWith(
      'docker',
      [
        'exec',
        '-i',
        'custom-postgres',
        'psql',
        '-U',
        'erp_user',
        '-d',
        'erpdb',
        '-qAtX',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        'SELECT 1',
      ],
      { encoding: 'utf8' },
    );
  });
});
