import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const CANARY_ENABLED = process.env.DEADLINE_SCHEDULER_EXTERNAL_OWNER_STAGE_CANARY === 'true';
const backendApiUrl = trimTrailingSlash(
  process.env.DEADLINE_ENGINE_STAGE_BACKEND_API_URL ?? 'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const fixtureKey = process.env.DEADLINE_WORKER_FIXTURE_KEY ?? '';
const fixtureOrderId = readNumberEnv('DEADLINE_WORKER_FIXTURE_ORDER_ID');
const externalOwnerWorkerNow = '2000-01-01T00:01:00.000Z';

test.describe('deadline scheduler external owner stage canary', () => {
  test.skip(
    !CANARY_ENABLED,
    'Set DEADLINE_SCHEDULER_EXTERNAL_OWNER_STAGE_CANARY=true to enable the external-owner stage canary.',
  );
  test.setTimeout(180000);

  let userId: number | null = null;

  test.beforeAll(() => {
    requireCanaryEnv();

    const restored = runFixture('restore');
    expect(restored.fixtureKey).toBe(fixtureKey);
    expect(restored.orderId).toBe(fixtureOrderId);
    expectRestoredFixtureEmpty(restored);

    const created = runFixture('create');
    expect(created.fixtureKey).toBe(fixtureKey);
    expect(created.orderId).toBe(fixtureOrderId);
    expect(created.deadlineCount).toBe(3);
    expect(created.eventCount).toBe(0);
  });

  test.afterAll(() => {
    let restoreError: unknown;
    try {
      if (fixtureKey && fixtureOrderId && process.env.DEADLINE_WORKER_FIXTURE_RESTORE === 'true') {
        const restored = runFixture('restore');
        expectRestoredFixtureEmpty(restored);
      }
    } catch (error) {
      restoreError = error;
    } finally {
      try {
        cleanupUser(userId);
      } catch (cleanupError) {
        if (!restoreError) throw cleanupError;
      }
      if (restoreError) throw restoreError;
    }
  });

  test('processes one due fixture through the external scheduler endpoint', async ({ request }) => {
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_test_deadline_external_scheduler_${runId}_${crypto
      .randomBytes(4)
      .toString('hex')}`;
    const password = crypto.randomBytes(24).toString('base64url');

    userId = createSmokeUser(username, password);
    const token = await loginForApiToken(request, username, password);
    await expectRuntimeFlags(request, token);

    assertNoNonFixtureDueDeadlines(externalOwnerWorkerNow);
    const response = await request.post(`${backendApiUrl}/deadline-worker/process-due-scheduled`, {
      data: { now: externalOwnerWorkerNow, limit: 1 },
      headers: { Authorization: `Bearer ${token}` },
    });
    await expectOk(response);
    expect(await response.json()).toEqual({
      scanned: 1,
      processed: 1,
      expired: 1,
      completed: 0,
    });

    const repeatResponse = await request.post(
      `${backendApiUrl}/deadline-worker/process-due-scheduled`,
      {
        data: { now: externalOwnerWorkerNow, limit: 1 },
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    await expectOk(repeatResponse);
    expect(await repeatResponse.json()).toEqual({
      scanned: 0,
      processed: 0,
      expired: 0,
      completed: 0,
    });

    const deadline = loadFixtureDeadline('manual-worker');
    expect(loadWorkerEvidence(deadline.deadlineId)).toEqual({
      status: 'expired',
      expiredEvents: 1,
      schedulerAuditRows: 1,
      manualAuditRows: 0,
      outboxRows: 1,
      actionExecutions: 0,
    });
  });
});

function expectRestoredFixtureEmpty(snapshot: FixtureSnapshot) {
  expect(snapshot.deadlineCount).toBe(0);
  expect(snapshot.eventCount).toBe(0);
  expect(snapshot.auditCount).toBe(0);
  expect(snapshot.outboxCount).toBe(0);
  expect(snapshot.actionExecutionCount).toBe(0);
  if (snapshot.actionRuleCount !== undefined) expect(snapshot.actionRuleCount).toBe(0);
  if (snapshot.notificationCount !== undefined) expect(snapshot.notificationCount).toBe(0);
}

function requireCanaryEnv() {
  if (!fixtureKey.trim()) throw new Error('DEADLINE_WORKER_FIXTURE_KEY is required');
  if (process.env.DEADLINE_WORKER_FIXTURE_RESTORE !== 'true') {
    throw new Error('DEADLINE_WORKER_FIXTURE_RESTORE=true is required');
  }
  if (!fixtureOrderId) throw new Error('DEADLINE_WORKER_FIXTURE_ORDER_ID is required');
  if (process.env.BACKEND_DEADLINE_WORKER_SCHEDULER_OWNER !== 'external') {
    throw new Error('BACKEND_DEADLINE_WORKER_SCHEDULER_OWNER=external is required');
  }
}

async function expectRuntimeFlags(request: APIRequestContext, token: string) {
  const response = await request.get(`${backendApiUrl}/deadlines?page=1&pageSize=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await expectOk(response);
  const body = await response.json();
  expect(Array.isArray(body.data)).toBe(true);
}

async function loginForApiToken(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<string> {
  const response = await request.post(`${backendApiUrl}/auth/login`, {
    data: { username, password },
  });
  await expectOk(response);
  const body = await response.json();
  expect(typeof body.accessToken).toBe('string');
  return body.accessToken;
}

async function expectOk(response: APIResponse) {
  const body = response.ok() ? '' : await response.text();
  expect(response.ok(), body).toBe(true);
}

function createSmokeUser(username: string, password: string): number {
  const email = `${username}@example.invalid`;
  const passwordHash = bcrypt.hashSync(password, 10);

  return Number(
    psql(`
      WITH inserted AS (
        INSERT INTO users (username, email, password_hash, role_id, full_name, is_active)
        VALUES (
          '${escapeSql(username)}',
          '${escapeSql(email)}',
          '${escapeSql(passwordHash)}',
          2,
          'E2E Test Deadline External Scheduler Canary',
          true
        )
        RETURNING user_id
      )
      SELECT user_id FROM inserted;
    `),
  );
}

function cleanupUser(id: number | null) {
  if (!id) return;

  psql(`
    DELETE FROM refresh_tokens WHERE user_id = ${id};
    DELETE FROM auth_sessions WHERE user_id = ${id};
    UPDATE users
    SET is_active = false,
        edited_by = NULL
    WHERE user_id = ${id};
  `);
}

function runFixture(command: 'restore' | 'create'): FixtureSnapshot {
  const output = execFileSync('npm', ['run', 'deadline-worker:fixture', '--', command], {
    encoding: 'utf8',
  });
  const jsonLine = output
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim().startsWith('{'));
  if (!jsonLine) throw new Error(`deadline-worker fixture ${command} did not return JSON`);
  return JSON.parse(jsonLine) as FixtureSnapshot;
}

function loadFixtureDeadline(role: FixtureRole): FixtureDeadline {
  return psql<FixtureDeadline>(
    `
    SELECT json_build_object(
      'deadlineId', deadline_id::text,
      'status', status,
      'fixtureRole', metadata_json->>'fixtureRole'
    )::text
    FROM deadline_instances
    WHERE metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
      AND metadata_json->>'fixtureRole' = '${escapeSql(role)}'
      AND order_id = ${fixtureOrderId}
    LIMIT 1;
    `,
    { json: true },
  );
}

function loadWorkerEvidence(deadlineId: string): WorkerEvidence {
  return psql<WorkerEvidence>(
    `
    WITH fixture_deadline AS (
      SELECT deadline_id, status
      FROM deadline_instances
      WHERE metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
        AND deadline_id = '${escapeSql(deadlineId)}'::uuid
    ),
    fixture_events AS (
      SELECT deadline_event_id
      FROM deadline_events
      WHERE deadline_id IN (SELECT deadline_id FROM fixture_deadline)
        AND event_type = 'DEADLINE_EXPIRED'
    )
    SELECT json_build_object(
      'status', (SELECT status FROM fixture_deadline),
      'expiredEvents', (SELECT count(*)::int FROM fixture_events),
      'schedulerAuditRows', (
        SELECT count(*)::int
        FROM audit_log
        WHERE entity_type = 'deadline'
          AND entity_id = '${escapeSql(deadlineId)}'
          AND event = 'deadlines.deadline_expired'
          AND source = 'deadline-engine-scheduler'
      ),
      'manualAuditRows', (
        SELECT count(*)::int
        FROM audit_log
        WHERE entity_type = 'deadline'
          AND entity_id = '${escapeSql(deadlineId)}'
          AND event = 'deadlines.deadline_expired'
          AND source = 'deadline-engine-manual'
      ),
      'outboxRows', (
        SELECT count(*)::int
        FROM outbox_events
        WHERE aggregate_type = 'deadline'
          AND aggregate_id = '${escapeSql(deadlineId)}'
          AND event_type = 'deadline.event.created'
          AND (payload_json->>'deadlineEventId')::uuid IN (SELECT deadline_event_id FROM fixture_events)
      ),
      'actionExecutions', (
        SELECT count(*)::int
        FROM deadline_action_executions
        WHERE deadline_event_id IN (SELECT deadline_event_id FROM fixture_events)
      )
    )::text;
    `,
    { json: true },
  );
}

function assertNoNonFixtureDueDeadlines(now: string) {
  const count = Number(
    psql(`
      SELECT count(*)::int
      FROM deadline_instances
      WHERE status = 'active'
        AND deadline_at <= '${escapeSql(now)}'::timestamptz
        AND COALESCE(metadata_json->>'fixtureKey', '') <> '${escapeSql(fixtureKey)}';
    `),
  );
  expect(count).toBe(0);
}

function psql<T = string>(sql: string, options: { json?: boolean } = {}): T {
  const output = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      postgresContainer,
      'psql',
      '-U',
      'erp_user',
      '-d',
      'erpdb',
      '-qAtX',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  ).trim();

  if (options.json) return JSON.parse(output) as T;
  return output as T;
}

function readNumberEnv(name: string): number | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

type FixtureRole = 'manual-worker';

interface FixtureSnapshot {
  fixtureKey: string;
  orderId: number;
  deadlineCount: number;
  eventCount: number;
  auditCount?: number;
  outboxCount?: number;
  actionExecutionCount?: number;
  actionRuleCount?: number;
  notificationCount?: number;
}

interface FixtureDeadline {
  deadlineId: string;
  status: string;
  fixtureRole: FixtureRole;
}

interface WorkerEvidence {
  status: 'expired';
  expiredEvents: number;
  schedulerAuditRows: number;
  manualAuditRows: number;
  outboxRows: number;
  actionExecutions: number;
}
