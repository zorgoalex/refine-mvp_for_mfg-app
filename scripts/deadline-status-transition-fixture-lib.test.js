import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtureLib from './deadline-status-transition-fixture-lib.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const {
  buildCreateSql,
  buildEvidenceSql,
  buildRestoreSql,
  hasProductionTarget,
  readFixtureConfig,
  runSql,
} = fixtureLib;

const env = {
  DEADLINE_STATUS_TRANSITION_STAGE_CANARY: 'true',
  DEADLINE_STATUS_TRANSITION_RESTORE: 'true',
  DEADLINE_STATUS_TRANSITION_TARGET_ENV: 'backend-test',
  DEADLINE_STATUS_TRANSITION_FIXTURE_KEY: 'deadline-status-transition-canary-2026-05-26',
  DEADLINE_STATUS_TRANSITION_ORDER_ID: '11182',
  DEADLINE_STATUS_TRANSITION_WORKER_NOW: '2000-01-05T00:01:00.000Z',
};

describe('deadline status transition fixture helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires explicit stage canary gates', () => {
    expect(() => readFixtureConfig({})).toThrow(
      'DEADLINE_STATUS_TRANSITION_STAGE_CANARY=true is required',
    );
    expect(() =>
      readFixtureConfig({
        ...env,
        DEADLINE_STATUS_TRANSITION_STAGE_CANARY: 'false',
      }),
    ).toThrow('DEADLINE_STATUS_TRANSITION_STAGE_CANARY=true is required');
    expect(() =>
      readFixtureConfig({
        ...env,
        DEADLINE_STATUS_TRANSITION_RESTORE: 'false',
      }),
    ).toThrow('DEADLINE_STATUS_TRANSITION_RESTORE=true is required');
    expect(() =>
      readFixtureConfig({
        ...env,
        DEADLINE_STATUS_TRANSITION_TARGET_ENV: 'staging',
      }),
    ).toThrow('DEADLINE_STATUS_TRANSITION_TARGET_ENV=backend-test is required');
  });

  it('requires fixture key and positive order id', () => {
    expect(() =>
      readFixtureConfig({
        ...env,
        DEADLINE_STATUS_TRANSITION_FIXTURE_KEY: '',
      }),
    ).toThrow('DEADLINE_STATUS_TRANSITION_FIXTURE_KEY is required');
    expect(() =>
      readFixtureConfig({
        ...env,
        DEADLINE_STATUS_TRANSITION_ORDER_ID: '0',
      }),
    ).toThrow('DEADLINE_STATUS_TRANSITION_ORDER_ID must be a positive integer');
    expect(
      readFixtureConfig({
        ...env,
        DEADLINE_STATUS_TRANSITION_ORDER_ID: undefined,
      }).orderId,
    ).toBe(11182);
  });

  it('rejects production-like target markers', () => {
    expect(hasProductionTarget(['backend-test', 'erp_test'])).toBe(false);
    expect(hasProductionTarget(['production'])).toBe(true);
    expect(hasProductionTarget(['prod-vps'])).toBe(true);
    expect(hasProductionTarget(['live'])).toBe(true);
    expect(() =>
      readFixtureConfig({
        ...env,
        BACKEND_FQDN: 'backend-live.example.com',
      }),
    ).toThrow('Refusing to run deadline status transition fixture against production target');
    expect(() =>
      readFixtureConfig({
        ...env,
        DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER: 'erp_prod-postgresdb-1',
      }),
    ).toThrow('Refusing to run deadline status transition fixture against production target');
    expect(() =>
      readFixtureConfig({
        ...env,
        DEADLINE_ENGINE_STAGE_BACKEND_API_URL: 'https://backend-production.example.com/api/v1',
      }),
    ).toThrow('Refusing to run deadline status transition fixture against production target');
  });

  it('builds create SQL for one deadline, two prioritized rules, and one disabled override', () => {
    const config = readFixtureConfig(env);
    const sql = buildCreateSql(config);

    expect(sql).toContain("'deadline-status-transition-canary-2026-05-26'");
    expect(sql).toMatch(/INSERT INTO deadline_status_transition_canary_snapshots/i);
    expect(sql).toContain('PRIMARY KEY (fixture_key, order_id)');
    expect(sql).toContain('ON CONFLICT (fixture_key, order_id) DO NOTHING');
    expect(sql).toMatch(/INSERT INTO deadline_instances/i);
    expect(sql.match(/INSERT INTO deadline_action_rules/gi)).toHaveLength(2);
    expect(sql).toContain("'orderId', 11182");
    expect(sql).toContain("'change_order_status'");
    expect(sql).toContain("'DEADLINE_EXPIRED'");
    expect(sql).toContain("'scope', jsonb_build_object('type', 'global_orders')");
    expect(sql).toContain("'requireCurrentDeadlineEvent'");
    expect(sql).toContain("'requireCurrentDeadlineEvent', false");
    expect(sql).toContain("'targetOrderStatusId'");
    expect(sql).toMatch(/INSERT INTO deadline_order_overrides/i);
    expect(sql).toContain('true,');
    expect(sql).toContain("'fixtureRole', 'status-transition'");
    expect(sql).not.toMatch(/notify_assignee|set_overdue_flag|change_production_status|webhook/i);
  });

  it('builds restore SQL scoped to fixture rows and restores original order status', () => {
    const config = readFixtureConfig(env);
    const sql = buildRestoreSql(config);

    expect(sql).toContain("'deadline-status-transition-canary-2026-05-26'");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS deadline_status_transition_canary_snapshots/i);
    expect(sql).toContain('PRIMARY KEY (fixture_key, order_id)');
    expect(sql).toMatch(/UPDATE orders o\s+SET order_status_id = s\.original_status_id/i);
    expect(sql).toMatch(/DELETE FROM deadline_action_executions/i);
    expect(sql).toMatch(/DELETE FROM deadline_events/i);
    expect(sql).toMatch(/DELETE FROM deadline_instances/i);
    expect(sql).toMatch(/DELETE FROM deadline_action_rules/i);
    expect(sql).toMatch(/metadata_json->>'fixtureRole' = 'status-transition'/i);
    expect(sql).toMatch(/config_json->>'fixtureRole' = 'status-transition'/i);
    expect(sql).toMatch(/\(config_json->>'orderId'\)::bigint = 11182/i);
    expect(sql).toMatch(/\(metadata_json->>'orderId'\)::bigint = 11182/i);
    expect(sql).toMatch(/\(payload_json->>'orderId'\)::bigint = 11182/i);
    expect(sql).not.toMatch(/DELETE FROM orders/i);
  });

  it('builds evidence SQL for worker, production audit, outbox, and residue counts', () => {
    const config = readFixtureConfig(env);
    const sql = buildEvidenceSql(config);

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS deadline_status_transition_canary_snapshots/i);
    expect(sql).toContain('PRIMARY KEY (fixture_key, order_id)');
    expect(sql).toContain("'selectedExecutionCount'");
    expect(sql).toContain("'lowerPrioritySkippedCount'");
    expect(sql).toContain("'productionAuditRows'");
    expect(sql).toContain('FROM audit_log');
    expect(sql).toContain('FROM outbox_events');
    expect(sql).toContain("'deadlineCount'");
    expect(sql).toContain("'eventCount'");
    expect(sql).toContain("'actionRuleCount'");
    expect(sql).toContain("'actionExecutionCount'");
    expect(sql).toContain("'activeOverrideCount'");
    expect(sql).toContain('SELECT max(target_status_id)::int');
    expect(sql).toContain("'postRestoreResidue'");
  });

  it('runs docker psql with fail-fast flags and parses the last JSON line', () => {
    execFileSync.mockReturnValue('NOTICE: setup\n{"ignored":true}\n{"ok":true}\n');
    const config = readFixtureConfig({
      ...env,
      DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER: 'custom-postgres',
    });

    const result = runSql(config, 'SELECT 1', { execFileSync });

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
