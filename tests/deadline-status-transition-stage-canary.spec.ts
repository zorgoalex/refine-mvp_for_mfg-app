import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const CANARY_ENABLED = process.env.DEADLINE_STATUS_TRANSITION_STAGE_CANARY === 'true';
const backendApiUrl = trimTrailingSlash(
  process.env.DEADLINE_ENGINE_STAGE_BACKEND_API_URL ?? 'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const fixtureKey = process.env.DEADLINE_STATUS_TRANSITION_FIXTURE_KEY ?? '';
const fixtureOrderId = readNumberEnv('DEADLINE_STATUS_TRANSITION_ORDER_ID') ?? 11182;
const workerNow =
  process.env.DEADLINE_STATUS_TRANSITION_WORKER_NOW?.trim() ||
  '2000-01-05T00:01:00.000Z';
const missingCanaryPrerequisites = [
  fixtureKey.trim() ? null : 'DEADLINE_STATUS_TRANSITION_FIXTURE_KEY',
  process.env.DEADLINE_STATUS_TRANSITION_RESTORE === 'true'
    ? null
    : 'DEADLINE_STATUS_TRANSITION_RESTORE=true',
  process.env.DEADLINE_STATUS_TRANSITION_TARGET_ENV === 'backend-test'
    ? null
    : 'DEADLINE_STATUS_TRANSITION_TARGET_ENV=backend-test',
  dockerContainerExists(postgresContainer) ? null : `docker container ${postgresContainer}`,
].filter((value): value is string => Boolean(value));

test.describe('deadline status transition stage canary', () => {
  test.skip(
    !CANARY_ENABLED,
    'Set DEADLINE_STATUS_TRANSITION_STAGE_CANARY=true to enable the stage canary.',
  );
  test.skip(
    CANARY_ENABLED && missingCanaryPrerequisites.length > 0,
    `Missing Deadline status transition canary prerequisites: ${missingCanaryPrerequisites.join(', ')}`,
  );
  test.setTimeout(240000);

  let targetStatusId: number | null = null;
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
    expect(created.deadlineCount).toBe(1);
    expect(created.actionRuleCount).toBe(2);
    expect(created.activeOverrideCount).toBe(1);
    expect(typeof created.targetStatusId).toBe('number');
    targetStatusId = created.targetStatusId ?? null;
  });

  test.afterAll(() => {
    let restoreError: unknown;
    try {
      if (
        process.env.DEADLINE_STATUS_TRANSITION_RESTORE === 'true' &&
        fixtureKey.trim() &&
        fixtureOrderId
      ) {
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

  test('previews disabled override, executes one status transition, proves replay, and restores', async ({
    request,
  }) => {
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_test_deadline_status_${runId}_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(24).toString('base64url');

    userId = createSmokeUser(username, password);
    const token = await loginForApiToken(request, username, password);
    await expectRuntimeReady(request, token);

    const disabledPreview = await previewRules(request, token);
    expect(disabledPreview.orderId).toBe(fixtureOrderId);
    expect(disabledPreview.candidateActionRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionType: 'change_order_status',
          wouldRun: false,
          wouldSkipReason: 'order_override_disabled',
        }),
      ]),
    );

    await retireFixtureOverride(request, token);

    const enabledPreview = await previewRules(request, token);
    // Preview without a persisted deadlineEventId is deliberately hypothetical:
    // mandatory current-event protection keeps every status mutation non-runnable.
    expect(enabledPreview.selectedActionRuleId).toBeNull();
    expect(
      enabledPreview.candidateActionRules.filter((rule: PreviewCandidate) => rule.wouldRun),
    ).toHaveLength(0);
    expect(enabledPreview.candidateActionRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionType: 'change_order_status',
          wouldRun: false,
          wouldSkipReason: 'stale_deadline_event',
        }),
      ]),
    );

    const fixtureDeadlineId = loadFixtureDeadlineId();
    const workerResponse = await request.post(`${backendApiUrl}/deadline-worker/process-due-now`, {
      data: { now: workerNow, limit: 1, deadlineId: fixtureDeadlineId },
      headers: { Authorization: `Bearer ${token}` },
    });
    await expectOk(workerResponse);
    expect(await workerResponse.json()).toEqual({
      scanned: 1,
      processed: 1,
      expired: 1,
      completed: 0,
    });

    const evidence = runFixture('evidence');
    expect(evidence.currentStatusId).toBe(targetStatusId);
    expect(evidence.targetStatusId).toBe(targetStatusId);
    expect(evidence.selectedExecutionCount).toBe(1);
    expect(evidence.lowerPrioritySkippedCount).toBeGreaterThanOrEqual(1);
    expect(evidence.productionAuditRows).toBeGreaterThanOrEqual(1);
    expect(evidence.productionOutboxRows).toBeGreaterThanOrEqual(1);

    const replayResponse = await request.post(`${backendApiUrl}/deadline-worker/process-due-now`, {
      data: { now: workerNow, limit: 1, deadlineId: fixtureDeadlineId },
      headers: { Authorization: `Bearer ${token}` },
    });
    await expectOk(replayResponse);
    expect(await replayResponse.json()).toEqual({
      scanned: 0,
      processed: 0,
      expired: 0,
      completed: 0,
    });

    const replayEvidence = runFixture('evidence');
    expect(replayEvidence.selectedExecutionCount).toBe(1);
    expect(replayEvidence.currentStatusId).toBe(targetStatusId);
  });
});

function requireCanaryEnv() {
  if (process.env.DEADLINE_STATUS_TRANSITION_STAGE_CANARY !== 'true') {
    throw new Error('DEADLINE_STATUS_TRANSITION_STAGE_CANARY=true is required');
  }
  if (process.env.DEADLINE_STATUS_TRANSITION_RESTORE !== 'true') {
    throw new Error('DEADLINE_STATUS_TRANSITION_RESTORE=true is required');
  }
  if (process.env.DEADLINE_STATUS_TRANSITION_TARGET_ENV !== 'backend-test') {
    throw new Error('DEADLINE_STATUS_TRANSITION_TARGET_ENV=backend-test is required');
  }
  if (!fixtureKey.trim()) {
    throw new Error('DEADLINE_STATUS_TRANSITION_FIXTURE_KEY is required');
  }
  assertBackendTestApiUrl(backendApiUrl);
}

function expectRestored(snapshot: FixtureSnapshot) {
  expect(snapshot.deadlineCount).toBe(0);
  expect(snapshot.eventCount).toBe(0);
  expect(snapshot.actionRuleCount).toBe(0);
  expect(snapshot.actionExecutionCount).toBe(0);
  expect(snapshot.activeOverrideCount).toBe(0);
  if (snapshot.originalStatusId !== null) {
    expect(snapshot.currentStatusId).toBe(snapshot.originalStatusId);
  }
}

function runFixture(command: 'restore' | 'create' | 'snapshot' | 'evidence'): FixtureSnapshot {
  const output = execFileSync(
    'npm',
    ['run', 'deadline-status-transition:fixture', '--', command],
    { encoding: 'utf8', env: process.env },
  );
  const jsonLine = output
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim().startsWith('{'));
  if (!jsonLine) {
    throw new Error(`deadline status transition fixture ${command} did not return JSON`);
  }
  return JSON.parse(jsonLine) as FixtureSnapshot;
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
}

async function previewRules(request: APIRequestContext, token: string): Promise<PreviewResponse> {
  const response = await request.post(
    `${backendApiUrl}/orders/${fixtureOrderId}/deadline-action-preview`,
    {
      data: {
        eventType: 'DEADLINE_EXPIRED',
        deadlineId: loadFixtureDeadlineId(),
        fixtureKey,
      },
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  await expectOk(response);
  return response.json();
}

async function retireFixtureOverride(request: APIRequestContext, token: string) {
  const overrideId = loadFixtureOverrideId();
  const response = await request.delete(
    `${backendApiUrl}/orders/${fixtureOrderId}/deadline-overrides/${overrideId}`,
    {
      data: { reason: 'Stage canary enabling status transition after disabled preview' },
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  await expectOk(response);
}

function loadFixtureDeadlineId(): string {
  return scalarSql(`
    SELECT deadline_id::text
    FROM deadline_instances
    WHERE metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
      AND metadata_json->>'fixtureRole' = 'status-transition'
      AND order_id = ${fixtureOrderId}
    ORDER BY created_at DESC
    LIMIT 1;
  `);
}

function loadFixtureOverrideId(): string {
  return scalarSql(`
    SELECT doo.override_id::text
    FROM deadline_order_overrides doo
    JOIN deadline_action_rules dar ON dar.action_rule_id = doo.action_rule_id
    WHERE doo.order_id = ${fixtureOrderId}
      AND doo.retired_at IS NULL
      AND dar.config_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
      AND dar.config_json->>'fixtureRole' = 'status-transition'
    ORDER BY doo.created_at DESC
    LIMIT 1;
  `);
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
          'E2E Test Deadline Status Transition Canary',
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

async function expectOk(response: APIResponse) {
  const body = response.ok() ? '' : await response.text();
  expect(response.ok(), body).toBe(true);
}

function readNumberEnv(name: string): number | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function dockerContainerExists(containerName: string): boolean {
  try {
    execFileSync('docker', ['container', 'inspect', containerName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function assertBackendTestApiUrl(value: string) {
  const parsed = new URL(value);
  expect(parsed.hostname, 'Deadline status transition canary must target backend-test').toBe(
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

interface FixtureSnapshot {
  fixtureKey: string;
  orderId: number;
  originalStatusId: number | null;
  currentStatusId: number;
  targetStatusId?: number | null;
  deadlineCount: number;
  eventCount: number;
  actionRuleCount: number;
  actionExecutionCount: number;
  activeOverrideCount: number;
  selectedExecutionCount?: number;
  lowerPrioritySkippedCount?: number;
  productionAuditRows?: number;
  productionOutboxRows?: number;
}

interface PreviewCandidate {
  actionRuleId: string;
  actionType: string;
  wouldRun: boolean;
  wouldSkipReason: string | null;
}

interface PreviewResponse {
  orderId: number;
  candidateActionRules: PreviewCandidate[];
  selectedActionRuleId: string | null;
}
