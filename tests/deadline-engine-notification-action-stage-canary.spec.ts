import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const CANARY_ENABLED = process.env.DEADLINE_NOTIFICATION_ACTION_STAGE_CANARY === 'true';
const backendApiUrl = trimTrailingSlash(
  process.env.DEADLINE_ENGINE_STAGE_BACKEND_API_URL ?? 'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const fixtureKey = process.env.DEADLINE_NOTIFICATION_ACTION_FIXTURE_KEY ?? '';
const fixtureOrderId = readNumberEnv('DEADLINE_NOTIFICATION_ACTION_ORDER_ID');
const workerNow =
  process.env.DEADLINE_NOTIFICATION_ACTION_WORKER_NOW?.trim() ||
  '2000-01-04T00:01:00.000Z';

test.describe('deadline engine notification action stage canary', () => {
  test.skip(
    !CANARY_ENABLED,
    'Set DEADLINE_NOTIFICATION_ACTION_STAGE_CANARY=true to enable the notification action stage canary.',
  );
  test.setTimeout(240000);

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
    expect(created.deadlineCount).toBe(1);
    expect(created.eventCount).toBe(0);
    expect(created.actionRuleCount).toBe(1);
    expect(created.actionExecutionCount).toBe(0);
    expect(created.notificationCount).toBe(0);
  });

  test.afterAll(() => {
    let restoreError: unknown;
    try {
      if (
        process.env.DEADLINE_NOTIFICATION_ACTION_RESTORE === 'true' &&
        fixtureKey &&
        fixtureOrderId
      ) {
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

  test('executes fixture notification action once when the worker expires the deadline', async ({
    request,
  }) => {
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_test_deadline_notification_action_${runId}_${crypto
      .randomBytes(4)
      .toString('hex')}`;
    const password = crypto.randomBytes(24).toString('base64url');

    userId = createSmokeUser(username, password);
    const token = await loginForApiToken(request, username, password);
    await expectRuntimeFlags(request, token);

    assertNoNonFixtureDueDeadlines(workerNow);
    const response = await request.post(`${backendApiUrl}/deadline-worker/process-due-now`, {
      data: { now: workerNow, limit: 1 },
      headers: { Authorization: `Bearer ${token}` },
    });
    await expectOk(response);
    expect(await response.json()).toEqual({
      scanned: 1,
      processed: 1,
      expired: 1,
      completed: 0,
    });

    const firstEvidence = loadNotificationActionEvidence();
    expectNotificationActionEvidence(firstEvidence);

    const repeatResponse = await request.post(`${backendApiUrl}/deadline-worker/process-due-now`, {
      data: { now: workerNow, limit: 1 },
      headers: { Authorization: `Bearer ${token}` },
    });
    await expectOk(repeatResponse);
    expect(await repeatResponse.json()).toEqual({
      scanned: 0,
      processed: 0,
      expired: 0,
      completed: 0,
    });

    const repeatEvidence = loadNotificationActionEvidence();
    expectNotificationActionEvidence(repeatEvidence);
    expect(repeatEvidence.notificationIdempotencyKey).toBe(
      firstEvidence.notificationIdempotencyKey,
    );
  });
});

function expectRestoredFixtureEmpty(snapshot: FixtureSnapshot) {
  expect(snapshot.deadlineCount).toBe(0);
  expect(snapshot.eventCount).toBe(0);
  expect(snapshot.actionRuleCount).toBe(0);
  expect(snapshot.actionExecutionCount).toBe(0);
  expect(snapshot.notificationCount).toBe(0);
}

function requireCanaryEnv() {
  if (process.env.DEADLINE_NOTIFICATION_ACTION_STAGE_CANARY !== 'true') {
    throw new Error('DEADLINE_NOTIFICATION_ACTION_STAGE_CANARY=true is required');
  }
  if (process.env.DEADLINE_NOTIFICATION_ACTION_RESTORE !== 'true') {
    throw new Error('DEADLINE_NOTIFICATION_ACTION_RESTORE=true is required');
  }
  if (process.env.DEADLINE_NOTIFICATION_ACTION_TARGET_ENV !== 'backend-test') {
    throw new Error('DEADLINE_NOTIFICATION_ACTION_TARGET_ENV=backend-test is required');
  }
  if (!fixtureKey.trim()) {
    throw new Error('DEADLINE_NOTIFICATION_ACTION_FIXTURE_KEY is required');
  }
  if (!fixtureOrderId) {
    throw new Error('DEADLINE_NOTIFICATION_ACTION_ORDER_ID is required');
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
          'E2E Test Deadline Notification Action Stage Canary',
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
  const output = execFileSync(
    'npm',
    ['run', 'deadline-notification-action:fixture', '--', command],
    { encoding: 'utf8' },
  );
  const jsonLine = output
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim().startsWith('{'));
  if (!jsonLine) {
    throw new Error(`deadline notification action fixture ${command} did not return JSON`);
  }
  return JSON.parse(jsonLine) as FixtureSnapshot;
}

function loadNotificationActionEvidence(): NotificationActionEvidence {
  return psql<NotificationActionEvidence>(
    `
    WITH fixture_deadline AS (
      SELECT deadline_id, status, order_id
      FROM deadline_instances
      WHERE metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
        AND metadata_json->>'fixtureRole' = 'notification-action'
        AND order_id = ${fixtureOrderId}
      LIMIT 1
    ),
    fixture_events AS (
      SELECT deadline_event_id
      FROM deadline_events
      WHERE deadline_id IN (SELECT deadline_id FROM fixture_deadline)
        AND event_type = 'DEADLINE_EXPIRED'
    ),
    fixture_action_rules AS (
      SELECT action_rule_id
      FROM deadline_action_rules
      WHERE config_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
        AND config_json->>'fixtureRole' = 'notification-action'
        AND scope_type = 'order'
        AND event_type = 'DEADLINE_EXPIRED'
        AND action_type = 'notify_assignee'
    ),
    fixture_action_executions AS (
      SELECT *
      FROM deadline_action_executions
      WHERE deadline_event_id IN (SELECT deadline_event_id FROM fixture_events)
    ),
    fixture_notifications AS (
      SELECT n.*
      FROM notifications n
      JOIN fixture_events fe ON fe.deadline_event_id::text = n.source_id
      WHERE n.source_type = 'deadline'
    )
    SELECT json_build_object(
      'deadlineId', (SELECT deadline_id::text FROM fixture_deadline),
      'deadlineStatus', (SELECT status FROM fixture_deadline),
      'deadlineEventId', (SELECT deadline_event_id::text FROM fixture_events LIMIT 1),
      'expiredEvents', (SELECT count(*)::int FROM fixture_events),
      'actionRules', (SELECT count(*)::int FROM fixture_action_rules),
      'actionExecutions', (SELECT count(*)::int FROM fixture_action_executions),
      'executedNotificationActions', (
        SELECT count(*)::int
        FROM fixture_action_executions
        WHERE status = 'executed'
          AND action_type = 'notify_assignee'
      ),
      'notifications', (SELECT count(*)::int FROM fixture_notifications),
      'notificationCreated', (
        SELECT (result_json->>'notificationCreated')::boolean
        FROM fixture_action_executions
        WHERE action_type = 'notify_assignee'
        LIMIT 1
      ),
      'notificationActionType', (
        SELECT result_json->>'actionType'
        FROM fixture_action_executions
        WHERE action_type = 'notify_assignee'
        LIMIT 1
      ),
      'notificationSourceType', (SELECT source_type FROM fixture_notifications LIMIT 1),
      'notificationIdempotencyKey', (
        SELECT result_json->>'notificationIdempotencyKey'
        FROM fixture_action_executions
        WHERE action_type = 'notify_assignee'
        LIMIT 1
      ),
      'notificationUserId', (
        SELECT (result_json->>'notificationUserId')::int
        FROM fixture_action_executions
        WHERE action_type = 'notify_assignee'
        LIMIT 1
      ),
      'orderManagerId', (
        SELECT o.manager_id::int
        FROM orders o
        JOIN fixture_deadline fd ON fd.order_id = o.order_id
        LIMIT 1
      )
    )::text;
    `,
    { json: true },
  );
}

function expectNotificationActionEvidence(evidence: NotificationActionEvidence) {
  expect(evidence.deadlineStatus).toBe('expired');
  expect(evidence.expiredEvents).toBe(1);
  expect(evidence.actionRules).toBe(1);
  expect(evidence.actionExecutions).toBe(1);
  expect(evidence.executedNotificationActions).toBe(1);
  expect(evidence.notifications).toBe(1);
  expect(evidence.notificationCreated).toBe(true);
  expect(evidence.notificationActionType).toBe('notify_assignee');
  expect(evidence.notificationSourceType).toBe('deadline');
  expect(evidence.notificationIdempotencyKey).toMatch(
    /^deadline-notification:[0-9a-f-]{36}:notify_assignee:\d+$/,
  );
  expect(evidence.notificationIdempotencyKey).toContain(evidence.deadlineEventId);
  expect(evidence.notificationUserId).toBe(evidence.orderManagerId);
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

interface FixtureSnapshot {
  fixtureKey: string;
  orderId: number;
  deadlineCount: number;
  eventCount: number;
  actionRuleCount: number;
  actionExecutionCount: number;
  notificationCount: number;
}

interface NotificationActionEvidence {
  deadlineId: string;
  deadlineStatus: 'expired';
  deadlineEventId: string;
  expiredEvents: number;
  actionRules: number;
  actionExecutions: number;
  executedNotificationActions: number;
  notifications: number;
  notificationCreated: boolean;
  notificationActionType: string;
  notificationSourceType: string;
  notificationIdempotencyKey: string;
  notificationUserId: number;
  orderManagerId: number;
}
