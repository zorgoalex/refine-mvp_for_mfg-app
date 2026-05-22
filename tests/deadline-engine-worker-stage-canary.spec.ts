import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const CANARY_ENABLED = process.env.DEADLINE_ENGINE_STAGE_WORKER_WRITE_CANARY === 'true';
const backendApiUrl = trimTrailingSlash(
  process.env.DEADLINE_ENGINE_STAGE_BACKEND_API_URL ?? 'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const fixtureKey = process.env.DEADLINE_WORKER_FIXTURE_KEY ?? '';
const fixtureOrderId = readNumberEnv('DEADLINE_WORKER_FIXTURE_ORDER_ID');
const manualWorkerNow = '2000-01-01T00:01:00.000Z';
const scheduledWorkerNow = '2000-01-02T00:01:00.000Z';

test.describe('deadline engine worker stage write canary', () => {
  test.skip(
    !CANARY_ENABLED,
    'Set DEADLINE_ENGINE_STAGE_WORKER_WRITE_CANARY=true to enable the stage worker write canary.',
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

  test('cancels one fixture deadline and processes due worker fixtures exactly once', async ({
    request,
  }) => {
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_test_deadline_worker_${runId}_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(24).toString('base64url');

    userId = createSmokeUser(username, password);
    const token = await loginForApiToken(request, username, password);
    await expectRuntimeFlags(request, token);

    const cancelDeadline = loadFixtureDeadline('cancel');
    const cancelResponse = await request.post(
      `${backendApiUrl}/deadlines/${cancelDeadline.deadlineId}/cancel`,
      {
        data: { reason: 'Deadline worker stage write canary cancellation' },
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    await expectOk(cancelResponse);

    const repeatCancelResponse = await request.post(
      `${backendApiUrl}/deadlines/${cancelDeadline.deadlineId}/cancel`,
      {
        data: { reason: 'Deadline worker stage write canary cancellation repeat' },
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(repeatCancelResponse.status(), await repeatCancelResponse.text()).toBe(409);

    expect(loadCancelEvidence(cancelDeadline.deadlineId)).toEqual({
      status: 'cancelled',
      cancelledEvents: 1,
      auditRows: 1,
      outboxRows: 1,
    });

    assertNoNonFixtureDueDeadlines(manualWorkerNow);
    const manualResponse = await request.post(`${backendApiUrl}/deadline-worker/process-due-now`, {
      data: { now: manualWorkerNow, limit: 1 },
      headers: { Authorization: `Bearer ${token}` },
    });
    await expectOk(manualResponse);
    expect(await manualResponse.json()).toEqual({
      scanned: 1,
      processed: 1,
      expired: 1,
      completed: 0,
    });

    const repeatManualResponse = await request.post(`${backendApiUrl}/deadline-worker/process-due-now`, {
      data: { now: manualWorkerNow, limit: 1 },
      headers: { Authorization: `Bearer ${token}` },
    });
    await expectOk(repeatManualResponse);
    expect(await repeatManualResponse.json()).toEqual({
      scanned: 0,
      processed: 0,
      expired: 0,
      completed: 0,
    });

    const manualDeadline = loadFixtureDeadline('manual-worker');
    expect(loadWorkerEvidence(manualDeadline.deadlineId, 'manual')).toEqual({
      status: 'expired',
      expiredEvents: 1,
      auditRows: 1,
      outboxRows: 1,
      actionExecutions: 1,
      skippedNotifications: 1,
    });

    assertNoNonFixtureDueDeadlines(scheduledWorkerNow);
    const scheduledResponse = await request.post(
      `${backendApiUrl}/deadline-worker/process-due-scheduled`,
      {
        data: { now: scheduledWorkerNow, limit: 1 },
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (scheduledResponse.ok()) {
      const scheduledBody = await scheduledResponse.json();
      expect(scheduledBody).toEqual({
        scanned: 1,
        processed: 1,
        expired: 1,
        completed: 0,
      });

      const repeatScheduledResponse = await request.post(
        `${backendApiUrl}/deadline-worker/process-due-scheduled`,
        {
          data: { now: scheduledWorkerNow, limit: 1 },
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      await expectOk(repeatScheduledResponse);
      expect(await repeatScheduledResponse.json()).toEqual({
        scanned: 0,
        processed: 0,
        expired: 0,
        completed: 0,
      });

      const scheduledDeadline = loadFixtureDeadline('scheduled-worker');
      expect(loadWorkerEvidence(scheduledDeadline.deadlineId, 'scheduler')).toEqual({
        status: 'expired',
        expiredEvents: 1,
        auditRows: 1,
        outboxRows: 1,
        actionExecutions: 1,
        skippedNotifications: 1,
      });
    } else {
      const scheduledError = await parseResponseBody(scheduledResponse);
      expect(scheduledResponse.status(), JSON.stringify(scheduledError)).toBe(503);
      expect(typeof scheduledError).toBe('object');
      expect(scheduledError).not.toBeNull();
      expect(Array.isArray(scheduledError)).toBe(false);
      expect((scheduledError as { code?: unknown }).code).toBe(
        'DEADLINE_WORKER_SCHEDULER_OWNER_MISMATCH',
      );
    }
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
  if (!fixtureKey.trim()) {
    throw new Error('DEADLINE_WORKER_FIXTURE_KEY is required');
  }
  if (process.env.DEADLINE_WORKER_FIXTURE_RESTORE !== 'true') {
    throw new Error('DEADLINE_WORKER_FIXTURE_RESTORE=true is required');
  }
  if (!fixtureOrderId) {
    throw new Error('DEADLINE_WORKER_FIXTURE_ORDER_ID is required');
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

async function parseResponseBody(response: APIResponse): Promise<unknown> {
  const contentType = response.headers()['content-type'] ?? '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return { text: await response.text() };
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
          'E2E Test Deadline Worker Stage Canary',
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
  if (!jsonLine) {
    throw new Error(`deadline-worker fixture ${command} did not return JSON`);
  }
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

function loadCancelEvidence(deadlineId: string): CancelEvidence {
  return psql<CancelEvidence>(
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
        AND event_type = 'DEADLINE_CANCELLED'
    )
    SELECT json_build_object(
      'status', (SELECT status FROM fixture_deadline),
      'cancelledEvents', (SELECT count(*)::int FROM fixture_events),
      'auditRows', (
        SELECT count(*)::int
        FROM audit_log
        WHERE entity_type = 'deadline'
          AND entity_id = '${escapeSql(deadlineId)}'
          AND event = 'deadlines.deadline_cancelled'
          AND source = 'backend-deadline-command'
      ),
      'outboxRows', (
        SELECT count(*)::int
        FROM outbox_events
        WHERE aggregate_type = 'deadline'
          AND aggregate_id = '${escapeSql(deadlineId)}'
          AND event_type = 'deadline.event.created'
          AND (payload_json->>'deadlineEventId')::uuid IN (SELECT deadline_event_id FROM fixture_events)
      )
    )::text;
    `,
    { json: true },
  );
}

function loadWorkerEvidence(deadlineId: string, trigger: 'manual' | 'scheduler'): WorkerEvidence {
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
    ),
    fixture_action_rules AS (
      SELECT action_rule_id
      FROM deadline_action_rules
      WHERE config_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
    )
    SELECT json_build_object(
      'status', (SELECT status FROM fixture_deadline),
      'expiredEvents', (SELECT count(*)::int FROM fixture_events),
      'auditRows', (
        SELECT count(*)::int
        FROM audit_log
        WHERE entity_type = 'deadline'
          AND entity_id = '${escapeSql(deadlineId)}'
          AND event = 'deadlines.deadline_expired'
          AND source = 'deadline-engine-${trigger}'
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
          AND action_rule_id IN (SELECT action_rule_id FROM fixture_action_rules)
      ),
      'skippedNotifications', (
        SELECT count(*)::int
        FROM deadline_action_executions
        WHERE deadline_event_id IN (SELECT deadline_event_id FROM fixture_events)
          AND action_rule_id IN (SELECT action_rule_id FROM fixture_action_rules)
          AND action_type = 'notify_assignee'
          AND status = 'skipped'
          AND skip_reason IN (
            'global_actions_disabled',
            'notifications_disabled',
            'notification_target_missing'
          )
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

type FixtureRole = 'cancel' | 'manual-worker' | 'scheduled-worker';

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

interface CancelEvidence {
  status: 'cancelled';
  cancelledEvents: number;
  auditRows: number;
  outboxRows: number;
}

interface WorkerEvidence {
  status: 'expired';
  expiredEvents: number;
  auditRows: number;
  outboxRows: number;
  actionExecutions: number;
  skippedNotifications: number;
}
