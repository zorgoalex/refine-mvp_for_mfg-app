import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const CANARY_ENABLED = process.env.DEADLINE_ESCALATE_STAGE_CANARY === 'true';
const backendApiUrl = trimTrailingSlash(
  process.env.DEADLINE_ENGINE_STAGE_BACKEND_API_URL ?? 'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const fixtureKey =
  process.env.DEADLINE_ESCALATE_FIXTURE_KEY?.trim() ||
  'deadline-escalate-canary-2026-06-01';
const fixtureOrderId = readNumberEnv('DEADLINE_ESCALATE_ORDER_ID');
const managerUserId = 1;
const workerNow =
  process.env.DEADLINE_ESCALATE_WORKER_NOW?.trim() || '2000-01-06T00:01:00.000Z';
const missingCanaryPrerequisites = [
  process.env.DEADLINE_ESCALATE_RESTORE === 'true'
    ? null
    : 'DEADLINE_ESCALATE_RESTORE=true',
  process.env.DEADLINE_ESCALATE_TARGET_ENV === 'backend-test'
    ? null
    : 'DEADLINE_ESCALATE_TARGET_ENV=backend-test',
  fixtureOrderId ? null : 'DEADLINE_ESCALATE_ORDER_ID',
  dockerContainerExists(postgresContainer) ? null : `docker container ${postgresContainer}`,
].filter((value): value is string => Boolean(value));

test.describe('deadline escalate stage canary', () => {
  test.skip(
    !CANARY_ENABLED,
    'Set DEADLINE_ESCALATE_STAGE_CANARY=true to enable the escalate stage canary.',
  );
  test.skip(
    CANARY_ENABLED && missingCanaryPrerequisites.length > 0,
    `Missing Deadline escalate canary prerequisites: ${missingCanaryPrerequisites.join(', ')}`,
  );
  test.setTimeout(240000);

  let userId: number | null = null;

  test.beforeAll(() => {
    requireCanaryEnv();

    const restored = runFixture('restore');
    expect(restored.fixtureKey).toBe(fixtureKey);
    expect(restored.orderId).toBe(fixtureOrderId);
    expectRestored(restored);

    const created = runFixture('create');
    expect(created.fixtureKey).toBe(fixtureKey);
    expect(created.orderId).toBe(fixtureOrderId);
    expect(created.managerUserId).toBe(managerUserId);
    expect(created.deadlineCount).toBe(1);
    expect(created.eventCount).toBe(0);
    expect(created.actionRuleCount).toBe(1);
    expect(created.actionExecutionCount).toBe(0);
    expect(created.managerNotificationCount).toBe(0);
  });

  test.afterAll(() => {
    let restoreError: unknown;
    try {
      if (process.env.DEADLINE_ESCALATE_RESTORE === 'true') {
        const restored = runFixture('restore');
        expectRestored(restored);
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

  test('executes exactly one manager escalation notification and is idempotent on replay', async ({
    request,
  }) => {
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_test_deadline_escalate_${runId}_${crypto
      .randomBytes(4)
      .toString('hex')}`;
    const password = crypto.randomBytes(24).toString('base64url');

    userId = createSmokeUser(username, password);
    const token = await loginForApiToken(request, username, password);
    await expectRuntimeReady(request, token);

    assertNoNonFixtureDueDeadlines(workerNow);

    const firstRequestId = `deadline-escalate-canary-${runId}-first`;
    const response = await request.post(`${backendApiUrl}/deadline-worker/process-due-now`, {
      data: { now: workerNow, limit: 1 },
      headers: {
        Authorization: `Bearer ${token}`,
        'x-request-id': firstRequestId,
      },
    });
    await expectOk(response);
    expect(await response.json()).toEqual({
      scanned: 1,
      processed: 1,
      expired: 1,
      completed: 0,
    });

    const firstEvidence = runFixture('evidence');
    expectEscalateEvidence(firstEvidence);

    const replayRequestId = `deadline-escalate-canary-${runId}-replay`;
    const repeatResponse = await request.post(`${backendApiUrl}/deadline-worker/process-due-now`, {
      data: { now: workerNow, limit: 1 },
      headers: {
        Authorization: `Bearer ${token}`,
        'x-request-id': replayRequestId,
      },
    });
    await expectOk(repeatResponse);
    expect(await repeatResponse.json()).toEqual({
      scanned: 0,
      processed: 0,
      expired: 0,
      completed: 0,
    });

    const repeatEvidence = runFixture('evidence');
    expectEscalateEvidence(repeatEvidence);
    expect(repeatEvidence.notificationIdempotencyKey).toBe(
      firstEvidence.notificationIdempotencyKey,
    );
  });
});

function requireCanaryEnv() {
  if (process.env.DEADLINE_ESCALATE_STAGE_CANARY !== 'true') {
    throw new Error('DEADLINE_ESCALATE_STAGE_CANARY=true is required');
  }
  if (process.env.DEADLINE_ESCALATE_RESTORE !== 'true') {
    throw new Error('DEADLINE_ESCALATE_RESTORE=true is required');
  }
  if (process.env.DEADLINE_ESCALATE_TARGET_ENV !== 'backend-test') {
    throw new Error('DEADLINE_ESCALATE_TARGET_ENV=backend-test is required');
  }
  if (!fixtureOrderId) {
    throw new Error('DEADLINE_ESCALATE_ORDER_ID must be a positive integer');
  }
  assertBackendTestApiUrl(backendApiUrl);
}

function expectRestored(snapshot: FixtureEvidence) {
  expect(snapshot.deadlineCount).toBe(0);
  expect(snapshot.eventCount).toBe(0);
  expect(snapshot.actionRuleCount).toBe(0);
  expect(snapshot.actionExecutionCount).toBe(0);
  expect(snapshot.selectedExecutionCount).toBe(0);
  expect(snapshot.managerNotificationCount).toBe(0);
  expect(snapshot.distinctManagerUserCount).toBe(0);
  expect(snapshot.auditCount).toBe(0);
  expect(snapshot.outboxCount).toBe(0);
}

function expectEscalateEvidence(evidence: FixtureEvidence) {
  expect(evidence.fixtureKey).toBe(fixtureKey);
  expect(evidence.orderId).toBe(fixtureOrderId);
  expect(evidence.managerUserId).toBe(managerUserId);
  expect(evidence.deadlineCount).toBe(1);
  expect(evidence.eventCount).toBe(1);
  expect(evidence.actionRuleCount).toBe(1);
  expect(evidence.actionExecutionCount).toBe(1);
  expect(evidence.selectedExecutionCount).toBe(1);
  expect(evidence.managerNotificationCount).toBe(1);
  expect(evidence.distinctManagerUserCount).toBe(1);
  expect(evidence.notificationIdempotencyKey).toMatch(
    /^deadline-notification:[0-9a-f-]{36}:escalate:1$/,
  );
}

function runFixture(command: 'restore' | 'create' | 'snapshot' | 'evidence'): FixtureEvidence {
  const output = execFileSync('npm', ['run', 'deadline-escalate:fixture', '--', command], {
    encoding: 'utf8',
    env: process.env,
  });
  const jsonLine = output
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim().startsWith('{'));
  if (!jsonLine) {
    throw new Error(`deadline escalate fixture ${command} did not return JSON`);
  }
  return JSON.parse(jsonLine) as FixtureEvidence;
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

async function expectRuntimeReady(request: APIRequestContext, token: string) {
  const response = await request.get(`${backendApiUrl}/deadlines?page=1&pageSize=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await expectOk(response);
  const body = await response.json();
  expect(Array.isArray(body.data)).toBe(true);
}

async function expectOk(response: APIResponse) {
  const body = response.ok() ? '' : await response.text();
  expect(response.ok(), body).toBe(true);
}

function createSmokeUser(username: string, password: string): number {
  const email = `${username}@example.invalid`;
  const passwordHash = bcrypt.hashSync(password, 10);

  return Number(
    scalarSql(`
      WITH inserted AS (
        INSERT INTO users (username, email, password_hash, role_id, full_name, is_active)
        VALUES (
          '${escapeSql(username)}',
          '${escapeSql(email)}',
          '${escapeSql(passwordHash)}',
          2,
          'E2E Test Deadline Escalate Stage Canary',
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

  scalarSql(`
    DELETE FROM refresh_tokens WHERE user_id = ${id};
    DELETE FROM auth_sessions WHERE user_id = ${id};
    UPDATE users
    SET is_active = false,
        edited_by = NULL
    WHERE user_id = ${id};
  `);
}

function assertNoNonFixtureDueDeadlines(now: string) {
  const count = Number(
    scalarSql(`
      SELECT count(*)::int
      FROM deadline_instances
      WHERE status = 'active'
        AND deadline_at <= '${escapeSql(now)}'::timestamptz
        AND COALESCE(metadata_json->>'fixtureKey', '') <> '${escapeSql(fixtureKey)}';
    `),
  );
  expect(count).toBe(0);
}

function scalarSql(sql: string): string {
  return execFileSync(
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
}

function dockerContainerExists(containerName: string): boolean {
  try {
    execFileSync('docker', ['container', 'inspect', containerName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readNumberEnv(name: string): number | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function assertBackendTestApiUrl(value: string) {
  const parsed = new URL(value);
  expect(parsed.hostname, 'Deadline escalate canary must target backend-test').toBe(
    'backend-test.mebelkz.app',
  );
  expect(parsed.pathname.replace(/\/+$/, ''), 'Deadline API path must be /api/v1').toBe('/api/v1');
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}

interface FixtureEvidence {
  fixtureKey: string;
  orderId: number;
  managerUserId: number;
  deadlineCount: number;
  eventCount: number;
  actionRuleCount: number;
  actionExecutionCount: number;
  selectedExecutionCount: number;
  managerNotificationCount: number;
  distinctManagerUserCount: number;
  notificationIdempotencyKey: string | null;
  auditCount: number;
  outboxCount: number;
}
