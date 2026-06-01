import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtureLib from './deadline-escalate-fixture-lib.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const {
  buildCreateSql,
  buildEvidenceSql,
  buildRestoreSql,
  escapeSql,
  readConfig,
  requireBackendTestTarget,
  runCommand,
  runSql,
} = fixtureLib;

const validEnv = {
  DEADLINE_ESCALATE_STAGE_CANARY: 'true',
  DEADLINE_ESCALATE_RESTORE: 'true',
  DEADLINE_ESCALATE_TARGET_ENV: 'backend-test',
  DEADLINE_ESCALATE_ORDER_ID: '11195',
};

const config = {
  fixtureKey: 'deadline-escalate-canary-2026-06-01',
  orderId: 11195,
  managerUserId: 1,
  postgresContainer: 'erp_test-postgresdb-1',
  workerNow: '2000-01-06T00:01:00.000Z',
};

describe('deadline escalate fixture helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires backend-test target and restore gates', () => {
    expect(() => requireBackendTestTarget({})).toThrow(
      'DEADLINE_ESCALATE_STAGE_CANARY=true is required',
    );
    expect(() =>
      requireBackendTestTarget({
        DEADLINE_ESCALATE_TARGET_ENV: 'backend-test',
        DEADLINE_ESCALATE_RESTORE: 'true',
      }),
    ).toThrow('DEADLINE_ESCALATE_STAGE_CANARY=true is required');
    expect(() =>
      requireBackendTestTarget({
        DEADLINE_ESCALATE_STAGE_CANARY: 'true',
      }),
    ).toThrow(
      'DEADLINE_ESCALATE_TARGET_ENV=backend-test is required',
    );
    expect(() =>
      requireBackendTestTarget({
        DEADLINE_ESCALATE_STAGE_CANARY: 'true',
        DEADLINE_ESCALATE_TARGET_ENV: 'staging',
        DEADLINE_ESCALATE_RESTORE: 'true',
      }),
    ).toThrow('DEADLINE_ESCALATE_TARGET_ENV=backend-test is required');
    expect(() =>
      requireBackendTestTarget({
        DEADLINE_ESCALATE_STAGE_CANARY: 'true',
        DEADLINE_ESCALATE_TARGET_ENV: 'backend-test',
      }),
    ).toThrow('DEADLINE_ESCALATE_RESTORE=true is required');
    expect(() => requireBackendTestTarget(validEnv)).not.toThrow();
  });

  it('reads fixture config from env and requires a positive explicit order id', () => {
    expect(() =>
      readConfig({
        DEADLINE_ESCALATE_RESTORE: 'true',
        DEADLINE_ESCALATE_TARGET_ENV: 'backend-test',
      }),
    ).toThrow('DEADLINE_ESCALATE_STAGE_CANARY=true is required');
    expect(() =>
      readConfig({
        DEADLINE_ESCALATE_STAGE_CANARY: 'true',
        DEADLINE_ESCALATE_RESTORE: 'true',
        DEADLINE_ESCALATE_TARGET_ENV: 'backend-test',
      }),
    ).toThrow('DEADLINE_ESCALATE_ORDER_ID is required');
    expect(() =>
      readConfig({
        ...validEnv,
        DEADLINE_ESCALATE_ORDER_ID: '0',
      }),
    ).toThrow('DEADLINE_ESCALATE_ORDER_ID must be a positive integer');
    expect(() =>
      readConfig({
        ...validEnv,
        DEADLINE_ESCALATE_ORDER_ID: 'abc',
      }),
    ).toThrow('DEADLINE_ESCALATE_ORDER_ID must be a positive integer');

    expect(
      readConfig({
        ...validEnv,
        DEADLINE_ESCALATE_FIXTURE_KEY: 'custom-deadline-escalate-fixture',
        DEADLINE_ESCALATE_ORDER_ID: '22222',
        DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER: 'custom-postgres',
        DEADLINE_ESCALATE_WORKER_NOW: '2000-02-06T00:01:00.000Z',
      }),
    ).toMatchObject({
      fixtureKey: 'custom-deadline-escalate-fixture',
      orderId: 22222,
      managerUserId: 1,
      postgresContainer: 'custom-postgres',
      workerNow: '2000-02-06T00:01:00.000Z',
    });
  });

  it.each([
    ['COMPOSE_PROJECT_NAME', 'erp_prod'],
    ['APP_ENV', 'production'],
    ['BACKEND_ENV', 'prod-vps'],
    ['BACKEND_NODE_ENV', 'live'],
    ['NODE_ENV', 'production'],
    ['BACKEND_FQDN', 'backend-live.example.com'],
    ['FRONTEND_ORIGIN', 'https://erp-prod.example.com'],
    ['DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER', 'erp_prod-postgresdb-1'],
    ['DEADLINE_ENGINE_STAGE_BACKEND_API_URL', 'https://backend-prod.example.com/api/v1'],
  ])('rejects production-like %s values', (key, value) => {
    expect(() =>
      requireBackendTestTarget({
        ...validEnv,
        [key]: value,
      }),
    ).toThrow('Refusing to run deadline escalate fixture against a production target');
  });

  it('escapes SQL strings', () => {
    expect(escapeSql("deadline-escalate's-canary")).toBe(
      "deadline-escalate''s-canary",
    );
  });

  it('builds scoped restore SQL without truncating shared tables', () => {
    const sql = buildRestoreSql(config);
    const deleteStatements = [
      ...sql.matchAll(/DELETE\s+FROM\s+([a-z_]+)\b[\s\S]*?;/gi),
    ].map(([statement, tableName]) => ({ statement, tableName }));

    expect(sql).toContain(
      "metadata_json->>'fixtureKey' = 'deadline-escalate-canary-2026-06-01'",
    );
    expect(sql).toContain(
      "config_json->>'fixtureKey' = 'deadline-escalate-canary-2026-06-01'",
    );
    expect(deleteStatements.map(({ tableName }) => tableName)).toEqual([
      'deadline_action_executions',
      'notifications',
      'outbox_events',
      'audit_log',
      'deadline_events',
      'deadline_action_rules',
      'deadline_instances',
    ]);
    expect(deleteStatements[0].statement).toMatch(
      /DELETE\s+FROM\s+deadline_action_executions\b[\s\S]*fixture_deadline_events/i,
    );
    expect(deleteStatements[1].statement).toMatch(
      /DELETE\s+FROM\s+notifications\b[\s\S]*source_type\s*=\s*'deadline'[\s\S]*fixture_deadline_events/i,
    );
    expect(deleteStatements[4].statement).toMatch(
      /DELETE\s+FROM\s+deadline_events\b[\s\S]*fixture_deadlines/i,
    );
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql).not.toMatch(/DELETE FROM deadline_instances\s*;/i);
    expect(sql).not.toMatch(/DELETE FROM deadline_action_rules\s*;/i);
  });

  it('builds one enabled expired escalate rule and one expired active deadline candidate', () => {
    const sql = buildCreateSql(config);

    expect(sql).toContain("'deadline-escalate-canary-2026-06-01'");
    expect(sql).toContain('11195');
    expect(sql).toContain('manager_id = 1');
    expect(sql.match(/INSERT INTO deadline_instances/gi)).toHaveLength(1);
    expect(sql.match(/INSERT INTO deadline_action_rules/gi)).toHaveLength(1);
    expect(sql).toContain("'DEADLINE_EXPIRED'");
    expect(sql).toContain("'escalate'");
    expect(sql).toContain('true');
    expect(sql).toContain("jsonb_build_object('fixtureKey'");
    expect(sql).toContain("'managerUserId', 1");
    expect(sql).toContain("'workerNow', '2000-01-06T00:01:00.000Z'");
    expect(sql).toMatch(/deadline_at[\s\S]*interval '1 minute'/i);
    expect(sql).toMatch(/metadata_json[\s\S]*fixtureKey/i);
    expect(sql).toMatch(/config_json[\s\S]*fixtureKey/i);
    expect(sql).not.toMatch(
      /notify_assignee|change_order_status|set_overdue_flag|change_production_status|create_task|webhook/i,
    );
  });

  it('builds evidence SQL for selected execution and manager notification counters', () => {
    const sql = buildEvidenceSql(config);

    expect(sql).toContain("'selectedExecutionCount'");
    expect(sql).toContain("'managerNotificationCount'");
    expect(sql).toContain("'distinctManagerUserCount'");
    expect(sql).toContain("'notificationIdempotencyKey'");
    expect(sql).toContain("'auditCount'");
    expect(sql).toContain("'outboxCount'");
    expect(sql).toContain("'deadlineCount'");
    expect(sql).toMatch(/action_type\s*=\s*'escalate'/i);
    expect(sql).toMatch(/user_id\s*=\s*1/i);
    expect(sql).toMatch(/COUNT\s*\(\s*DISTINCT\s+n\.user_id\s*\)/i);
  });

  it('runs SQL through docker exec psql and parses the last JSON line', () => {
    execFileSync.mockReturnValue('NOTICE: fixture\n{"ok":true}\n');

    const result = runSql(
      {
        ...config,
        postgresContainer: 'custom-postgres',
      },
      'SELECT 1',
      { execFileSync },
    );

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

  it('supports create, snapshot, evidence, and restore commands', () => {
    execFileSync.mockReturnValue('{"fixtureKey":"deadline-escalate-canary-2026-06-01"}\n');

    expect(runCommand('snapshot', validEnv, { execFileSync })).toEqual({
      fixtureKey: 'deadline-escalate-canary-2026-06-01',
    });
    expect(runCommand('evidence', validEnv, { execFileSync })).toEqual({
      fixtureKey: 'deadline-escalate-canary-2026-06-01',
    });
    expect(runCommand('create', validEnv, { execFileSync })).toEqual({
      fixtureKey: 'deadline-escalate-canary-2026-06-01',
    });
    expect(runCommand('restore', validEnv, { execFileSync })).toEqual({
      fixtureKey: 'deadline-escalate-canary-2026-06-01',
    });
    expect(() => runCommand('missing', validEnv)).toThrow(
      'Usage: deadline-escalate-fixture <snapshot|evidence|create|restore>',
    );
  });
});
