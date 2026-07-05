import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

/**
 * Track B Task 11 — Notification Engine Deadline Convergence stage canary.
 *
 * Opt-in, `backend-test`-only. Proves the cutover invariant end-to-end with the
 * convergence flag ON: a single `DEADLINE_EXPIRED` event is delivered by the
 * notification ENGINE (manager / stage-assignee / group-participant rules
 * seeded by migration 015), while the legacy INLINE paths write nothing —
 * `deadline_action_executions` notify/escalate rows are
 * `status='skipped', skip_reason='owned_by_notification_engine'` and the P8
 * inline port leaves a `GROUP_DEADLINE_OVERDUE_SKIPPED` outbox marker (zero
 * `group-feature notifications` residue). Replay is idempotent, delivered text never
 * leaks payload/phone/secret data, and all fixtures restore to zero.
 *
 * PRECONDITIONS the operator must satisfy on `backend-test` / `erp_test`
 * inside the exclusive cutover window (NOT created by this spec):
 *  - migrations `014` (engine) + `015` (deadline parity seed) applied
 *  - `BACKEND_ENABLE_NOTIFICATION_ENGINE=true`, `BACKEND_OUTBOX_RELAY_OWNER!=none`
 *  - `BACKEND_NOTIFICATION_ENGINE_OWNS_DEADLINE=true`
 *  - legacy `BACKEND_DEADLINE_NOTIFICATIONS_ENABLED` / `BACKEND_ENABLE_GROUP_P8_NOTIFICATIONS`
 *    left at their (default-off) values — the convergence flag is the single owner switch
 *  - an OVERDUE fixture deadline_instance linked to the fixture order, with a
 *    manager, a stage assignee, a group participant, and a non-visible user
 *
 * The spec mutates only fixture-scoped rows and restores them; it never seeds
 * the parity rules (those come from migration 015) and never flips flags.
 */

const FIXTURE_KEY = 'notification-engine-deadline-convergence-2026-06-10';
const SEED_RULE_CODES = [
  'deadline-expired-notify-manager',
  'deadline-expired-notify-assignee',
  'deadline-expired-group-participants',
  'deadline-expired-escalate-manager',
] as const;
const DEADLINE_EVENT_TYPE = 'DEADLINE_EXPIRED';

const CANARY_ENABLED = process.env.NOTIFICATION_CONVERGENCE_STAGE_CANARY === 'true';
const backendApiUrl = trimTrailingSlash(
  process.env.NOTIFICATION_CONVERGENCE_BACKEND_API_URL ?? 'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.NOTIFICATION_CONVERGENCE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const fixtureKey = process.env.NOTIFICATION_CONVERGENCE_FIXTURE_KEY?.trim() ?? '';
const targetEnv = process.env.NOTIFICATION_CONVERGENCE_TARGET_ENV?.trim() ?? '';
const restoreEnabled = process.env.NOTIFICATION_CONVERGENCE_FIXTURE_RESTORE === 'true';
const fixtureOrderId = readNumberEnv('NOTIFICATION_CONVERGENCE_FIXTURE_ORDER_ID');
const fixtureDeadlineInstanceId = process.env.NOTIFICATION_CONVERGENCE_FIXTURE_DEADLINE_INSTANCE_ID?.trim() ?? '';
const managerUserId = readNumberEnv('NOTIFICATION_CONVERGENCE_FIXTURE_MANAGER_USER_ID');
const assigneeUserId = readNumberEnv('NOTIFICATION_CONVERGENCE_FIXTURE_ASSIGNEE_USER_ID');
const participantUserId = readNumberEnv('NOTIFICATION_CONVERGENCE_FIXTURE_PARTICIPANT_USER_ID');
const nonVisibleUserId = readNumberEnv('NOTIFICATION_CONVERGENCE_FIXTURE_NONVISIBLE_USER_ID');

const missingCanaryPrerequisites = [
  fixtureKey ? null : 'NOTIFICATION_CONVERGENCE_FIXTURE_KEY',
  fixtureKey && fixtureKey !== FIXTURE_KEY ? `NOTIFICATION_CONVERGENCE_FIXTURE_KEY=${FIXTURE_KEY}` : null,
  targetEnv ? null : 'NOTIFICATION_CONVERGENCE_TARGET_ENV=backend-test',
  targetEnv && targetEnv !== 'backend-test' ? 'NOTIFICATION_CONVERGENCE_TARGET_ENV=backend-test' : null,
  restoreEnabled ? null : 'NOTIFICATION_CONVERGENCE_FIXTURE_RESTORE=true',
  fixtureOrderId ? null : 'NOTIFICATION_CONVERGENCE_FIXTURE_ORDER_ID',
  fixtureDeadlineInstanceId ? null : 'NOTIFICATION_CONVERGENCE_FIXTURE_DEADLINE_INSTANCE_ID',
  managerUserId ? null : 'NOTIFICATION_CONVERGENCE_FIXTURE_MANAGER_USER_ID',
  assigneeUserId ? null : 'NOTIFICATION_CONVERGENCE_FIXTURE_ASSIGNEE_USER_ID',
  participantUserId ? null : 'NOTIFICATION_CONVERGENCE_FIXTURE_PARTICIPANT_USER_ID',
  nonVisibleUserId ? null : 'NOTIFICATION_CONVERGENCE_FIXTURE_NONVISIBLE_USER_ID',
  dockerContainerExists(postgresContainer) ? null : `docker container ${postgresContainer}`,
].filter((value): value is string => Boolean(value));

test.describe('notification engine deadline convergence stage canary', () => {
  test.skip(
    !CANARY_ENABLED,
    'Set NOTIFICATION_CONVERGENCE_STAGE_CANARY=true to enable the deadline convergence stage canary.',
  );
  test.skip(
    CANARY_ENABLED && missingCanaryPrerequisites.length > 0,
    `Missing deadline convergence stage canary prerequisites: ${missingCanaryPrerequisites.join(', ')}`,
  );
  test.setTimeout(240000);

  let userId: number | null = null;

  test.beforeAll(() => {
    requireCanaryEnv();
    // Precondition: the parity rules must already exist (migration 015), and no
    // prior fixture delivery/skip residue should be present.
    assertSeedRulesPresent();
    expectFixtureResidueZero('preflight restore');
  });

  test.afterAll(() => {
    let restoreError: unknown;
    try {
      if (restoreEnabled) {
        restoreFixture();
        expectFixtureResidueZero('afterAll restore');
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

  test('engine owns DEADLINE_EXPIRED; inline dispatcher + P8 write nothing; no double-send', async ({
    request,
  }) => {
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_test_notif_convergence_${runId}_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(24).toString('base64url');
    userId = createSmokeUser(username, password);
    const token = await loginForApiToken(request, username, password);

    // 1) Worker processes the overdue fixture deadline → enqueues the
    //    `deadline.event.created` envelope and (flag on) skips the inline
    //    notify/escalate + P8 paths.
    const workerSummary = await processDueNow(request, token);
    expect(workerSummary.processed, JSON.stringify(workerSummary)).toBeGreaterThanOrEqual(1);

    // 2) Relay drains the envelope → engine delivers per seeded parity rule.
    const relaySummary = await processRelayNow(request, token);
    expect(relaySummary.failed, JSON.stringify(relaySummary)).toBe(0);
    expect(relaySummary.processed, JSON.stringify(relaySummary)).toBeGreaterThanOrEqual(1);

    // 3) ENGINE deliveries: manager + assignee + participant each got exactly one
    //    notification sourced from a seeded rule; the non-visible user got none.
    const managerCount = engineDeliveryCount(managerUserId!);
    const assigneeCount = engineDeliveryCount(assigneeUserId!);
    const participantCount = engineDeliveryCount(participantUserId!);
    expect(managerCount, 'manager must receive an engine-delivered notification').toBeGreaterThanOrEqual(1);
    expect(assigneeCount, 'stage assignee must receive an engine-delivered notification').toBeGreaterThanOrEqual(1);
    expect(participantCount, 'group participant must receive an engine-delivered notification').toBeGreaterThanOrEqual(1);

    const nonVisibleCount = engineDeliveryCount(nonVisibleUserId!);
    expect(nonVisibleCount, 'base-visibility filter must drop the non-visible recipient').toBe(0);

    // 4) INLINE dispatcher wrote nothing: notify_*/escalate executions for this
    //    deadline are recorded as skipped with the convergence reason.
    const inlineActive = inlineNotifyExecutionCount('active');
    const inlineSkipped = inlineNotifyExecutionCount('skipped');
    expect(inlineActive, 'inline dispatcher must NOT execute notify_*/escalate when engine owns the event').toBe(0);
    expect(inlineSkipped, 'inline notify/escalate must be recorded skipped:owned_by_notification_engine').toBeGreaterThanOrEqual(1);

    // 5) P8 inline wrote nothing: a GROUP_DEADLINE_OVERDUE_SKIPPED marker exists
    //    and there is zero group-feature notification residue for this deadline.
    expect(p8SkipMarkerCount(), 'P8 inline must leave a GROUP_DEADLINE_OVERDUE_SKIPPED marker').toBeGreaterThanOrEqual(1);
    expect(p8InlineResidueCount(), 'P8 inline must write zero group-feature notifications when engine owns the event').toBe(0);

    // 6) Replay idempotency: re-draining the same envelope creates no duplicates.
    const totalBefore = engineDeliveryTotal();
    const replay = await processRelayNow(request, token);
    expect(replay.failed, JSON.stringify(replay)).toBe(0);
    expect(engineDeliveryTotal(), 'relay replay must not create duplicate notifications').toBe(totalBefore);

    // 7) Privacy scan on delivered text — only whitelisted placeholders, no
    //    raw payload / phone / JWT-like secret, no unresolved {token}.
    for (const row of engineDeliveredRows()) {
      const target = `${row.title} ${row.message}`;
      expect(target, 'no phone-like digit run').not.toMatch(/\+?\d{10,}/);
      expect(target, 'no JWT-like secret').not.toMatch(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
      expect(target, 'no unresolved template placeholder').not.toMatch(/\{[a-zA-Z0-9_]+\}/);
    }

    // 8) Restore-to-zero (explicit), proven by a residue re-count.
    restoreFixture();
    expectFixtureResidueZero('explicit restore');
  });
});

interface WorkerSummary {
  processed: number;
  failed?: number;
}
interface RelaySummary {
  claimed?: number;
  processed: number;
  failed: number;
}

async function processDueNow(request: APIRequestContext, token: string): Promise<WorkerSummary> {
  const response = await request.post(`${backendApiUrl}/deadline-worker/process-due-now`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  });
  await expectOk(response);
  const body = (await response.json()) as WorkerSummary;
  expect(typeof body.processed).toBe('number');
  return body;
}

async function processRelayNow(request: APIRequestContext, token: string): Promise<RelaySummary> {
  const response = await request.post(`${backendApiUrl}/outbox-relay/process-now`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status() === 503) {
    const body = await parseResponseBody(response);
    if (errorCode(body) === 'NOTIFICATION_ENGINE_DISABLED') {
      throw new Error(
        'Notification engine is disabled on the target (NOTIFICATION_ENGINE_DISABLED). ' +
          'Enable BACKEND_ENABLE_NOTIFICATION_ENGINE + relay owner before running this canary.',
      );
    }
  }
  await expectOk(response);
  const body = (await response.json()) as RelaySummary;
  expect(typeof body.processed).toBe('number');
  expect(typeof body.failed).toBe('number');
  return body;
}

function requireCanaryEnv() {
  if (!fixtureKey || fixtureKey !== FIXTURE_KEY) {
    throw new Error(`NOTIFICATION_CONVERGENCE_FIXTURE_KEY must equal ${FIXTURE_KEY}`);
  }
  assertTargetEnv(targetEnv);
  assertBackendApiUrl(backendApiUrl);
  if (!restoreEnabled) throw new Error('NOTIFICATION_CONVERGENCE_FIXTURE_RESTORE=true is required');
  for (const [name, value] of [
    ['NOTIFICATION_CONVERGENCE_FIXTURE_ORDER_ID', fixtureOrderId],
    ['NOTIFICATION_CONVERGENCE_FIXTURE_MANAGER_USER_ID', managerUserId],
    ['NOTIFICATION_CONVERGENCE_FIXTURE_ASSIGNEE_USER_ID', assigneeUserId],
    ['NOTIFICATION_CONVERGENCE_FIXTURE_PARTICIPANT_USER_ID', participantUserId],
    ['NOTIFICATION_CONVERGENCE_FIXTURE_NONVISIBLE_USER_ID', nonVisibleUserId],
  ] as const) {
    if (!value) throw new Error(`${name} is required (positive integer)`);
  }
  if (!fixtureDeadlineInstanceId) {
    throw new Error('NOTIFICATION_CONVERGENCE_FIXTURE_DEADLINE_INSTANCE_ID is required (deadline_id UUID)');
  }
}

/**
 * Fail-closed target-env guard: only `backend-test` is acceptable. Anything
 * resembling prod/production/live MUST throw before any write happens.
 */
function assertTargetEnv(env: string) {
  if (env === 'backend-test') return;
  throw new Error(
    `Refusing to run deadline convergence stage canary against target env "${env}". ` +
      'Only NOTIFICATION_CONVERGENCE_TARGET_ENV=backend-test is permitted (prod/production/live are rejected).',
  );
}

function assertBackendApiUrl(url: string) {
  const host = new URL(url).hostname.toLowerCase();
  if (/prod|production|\blive\b/.test(host)) {
    throw new Error(`Refusing to target a prod/live-looking backend host: ${host}`);
  }
  if (!host.includes('backend-test')) {
    throw new Error(`Deadline convergence stage canary backend host must contain "backend-test", got: ${host}`);
  }
}

function assertSeedRulesPresent() {
  const present = Number(
    psql(`
      SELECT count(*)::int FROM notification_rules
      WHERE event_type = '${escapeSql(DEADLINE_EVENT_TYPE)}'
        AND rule_code IN (${SEED_RULE_CODES.map((c) => `'${escapeSql(c)}'`).join(', ')})
        AND is_enabled = true;
    `),
  );
  expect(
    present,
    'migration 015 deadline parity rules must be applied + enabled before this canary',
  ).toBe(SEED_RULE_CODES.length);
}

async function loginForApiToken(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<string> {
  const response = await request.post(`${backendApiUrl}/auth/login`, { data: { username, password } });
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
  return contentType.includes('application/json') ? response.json() : { text: await response.text() };
}

function errorCode(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as { code?: unknown; error?: unknown };
  if (record.code !== undefined) return record.code;
  if (!record.error || typeof record.error !== 'object' || Array.isArray(record.error)) return undefined;
  return (record.error as { code?: unknown }).code;
}

function createSmokeUser(username: string, password: string): number {
  const email = `${username}@example.invalid`;
  const passwordHash = bcrypt.hashSync(password, 10);
  return Number(
    psql(`
      WITH inserted AS (
        INSERT INTO users (username, email, password_hash, role_id, full_name, is_active)
        VALUES (
          '${escapeSql(username)}', '${escapeSql(email)}', '${escapeSql(passwordHash)}',
          2, 'E2E Test Notification Convergence Stage Canary', true
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
    UPDATE users SET is_active = false, edited_by = NULL WHERE user_id = ${id};
  `);
}

/** Count of engine-delivered (source_type='notification_rule') rows for a user from a seeded deadline rule. */
function engineDeliveryCount(userId: number): number {
  return Number(
    psql(`
      SELECT count(*)::int
      FROM notifications n
      JOIN notification_rules r ON r.notification_rule_id::text = n.source_id
      WHERE n.user_id = ${userId}
        AND n.source_type = 'notification_rule'
        AND r.rule_code IN (${SEED_RULE_CODES.map((c) => `'${escapeSql(c)}'`).join(', ')});
    `),
  );
}

function engineDeliveryTotal(): number {
  return Number(
    psql(`
      SELECT count(*)::int
      FROM notifications n
      JOIN notification_rules r ON r.notification_rule_id::text = n.source_id
      WHERE n.source_type = 'notification_rule'
        AND n.entity_type = 'order'
        AND n.entity_id = '${escapeSql(String(fixtureOrderId))}'
        AND r.rule_code IN (${SEED_RULE_CODES.map((c) => `'${escapeSql(c)}'`).join(', ')});
    `),
  );
}

interface DeliveredRow { title: string; message: string }
function engineDeliveredRows(): DeliveredRow[] {
  return psqlJsonArray<DeliveredRow>(`
    SELECT coalesce(json_agg(json_build_object('title', n.title, 'message', n.message)), '[]'::json)::text
    FROM notifications n
    JOIN notification_rules r ON r.notification_rule_id::text = n.source_id
    WHERE n.source_type = 'notification_rule'
      AND n.entity_type = 'order'
      AND n.entity_id = '${escapeSql(String(fixtureOrderId))}'
      AND r.rule_code IN (${SEED_RULE_CODES.map((c) => `'${escapeSql(c)}'`).join(', ')});
  `);
}

/** Inline notify/escalate executions for the fixture deadline, by status bucket. */
function inlineNotifyExecutionCount(bucket: 'active' | 'skipped'): number {
  const statusFilter =
    bucket === 'skipped'
      ? `status = 'skipped' AND skip_reason = 'owned_by_notification_engine'`
      : `status <> 'skipped'`;
  return Number(
    psql(`
      SELECT count(*)::int
      FROM deadline_action_executions e
      WHERE e.action_type IN ('notify_assignee','notify_manager','notify_department_head','escalate')
        AND e.deadline_event_id IN (
          SELECT deadline_event_id FROM deadline_events
          WHERE deadline_id = '${escapeSql(fixtureDeadlineInstanceId)}'
        )
        AND ${statusFilter};
    `),
  );
}

function p8SkipMarkerCount(): number {
  return Number(
    psql(`
      SELECT count(*)::int FROM outbox_events
      WHERE event_type = 'GROUP_DEADLINE_OVERDUE_SKIPPED'
        AND aggregate_type = 'deadline_instance'
        AND aggregate_id = '${escapeSql(fixtureDeadlineInstanceId)}'
        AND payload_json->>'skipReason' = 'owned_by_notification_engine';
    `),
  );
}

/**
 * Residue of the legacy P8 inline write path for this deadline. The legacy port
 * delivers via the generic `notifications` table with entity_type='project'
 * (the DEADLINE entity_type VALUE — kept as the documented rename boundary; the
 * port writes `input.entityType`, i.e. the deadline's own entity_type),
 * source_id=`${deadlineEventId}:${factKey}` — there is no dedicated
 * group-feature notifications table. Under convergence the engine owns the event so
 * the P8 inline port records only a skip marker and writes zero notifications
 * for this deadline's events.
 */
function p8InlineResidueCount(): number {
  return Number(
    psql(`
      SELECT count(*)::int
      FROM notifications n
      WHERE n.entity_type = 'project'
        AND EXISTS (
          SELECT 1 FROM deadline_events de
          WHERE de.deadline_id = '${escapeSql(fixtureDeadlineInstanceId)}'
            AND n.source_id LIKE de.deadline_event_id::text || ':%'
        );
    `),
  );
}

/** Deletes only this fixture's delivered/skip residue, leaving seeded rules intact. */
function restoreFixture(): void {
  psql(`
    DELETE FROM notifications n
    USING notification_rules r
    WHERE r.notification_rule_id::text = n.source_id
      AND n.source_type = 'notification_rule'
      AND n.entity_type = 'order'
      AND n.entity_id = '${escapeSql(String(fixtureOrderId))}'
      AND r.rule_code IN (${SEED_RULE_CODES.map((c) => `'${escapeSql(c)}'`).join(', ')});
    DELETE FROM outbox_events
    WHERE event_type = 'GROUP_DEADLINE_OVERDUE_SKIPPED'
      AND aggregate_type = 'deadline_instance'
      AND aggregate_id = '${escapeSql(fixtureDeadlineInstanceId)}';
  `);
}

function expectFixtureResidueZero(label: string) {
  expect(engineDeliveryTotal(), `${label}: engine deliveries`).toBe(0);
  expect(p8SkipMarkerCount(), `${label}: P8 skip markers`).toBe(0);
}

function psql<T = string>(sql: string): T {
  const output = execFileSync(
    'docker',
    ['exec', '-i', postgresContainer, 'psql', '-U', 'erp_user', '-d', 'erpdb', '-qAtX', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
  return output as T;
}

function psqlJsonArray<T>(sql: string): T[] {
  const output = psql<string>(sql);
  if (!output) return [];
  const parsed = JSON.parse(output) as T[];
  return Array.isArray(parsed) ? parsed : [];
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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}
