import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const FIXTURE_KEY = 'notification-engine-canary-2026-06-07';

const CANARY_ENABLED = process.env.NOTIFICATION_ENGINE_STAGE_CANARY === 'true';
const backendApiUrl = trimTrailingSlash(
  process.env.NOTIFICATION_ENGINE_STAGE_BACKEND_API_URL ?? 'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.NOTIFICATION_ENGINE_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const fixtureKey = process.env.NOTIFICATION_ENGINE_FIXTURE_KEY?.trim() ?? '';
const targetEnv = process.env.NOTIFICATION_ENGINE_TARGET_ENV?.trim() ?? '';
const restoreEnabled = process.env.NOTIFICATION_ENGINE_FIXTURE_RESTORE === 'true';
const fixtureOrderId = readNumberEnv('NOTIFICATION_ENGINE_FIXTURE_ORDER_ID');
const recipientUserId = readNumberEnv('NOTIFICATION_ENGINE_FIXTURE_RECIPIENT_USER_ID');
const nonVisibleUserId = readNumberEnv('NOTIFICATION_ENGINE_FIXTURE_NONVISIBLE_USER_ID');
const expectDisabledAfterRestore =
  process.env.NOTIFICATION_ENGINE_EXPECT_DISABLED_AFTER_RESTORE === 'true';

const ruleCode = `E2E-notif-canary-${fixtureKey || FIXTURE_KEY}`;
const EVENT_TYPE = 'order.production_status_changed';

const missingCanaryPrerequisites = [
  fixtureKey ? null : 'NOTIFICATION_ENGINE_FIXTURE_KEY',
  fixtureKey && fixtureKey !== FIXTURE_KEY ? `NOTIFICATION_ENGINE_FIXTURE_KEY=${FIXTURE_KEY}` : null,
  targetEnv ? null : 'NOTIFICATION_ENGINE_TARGET_ENV=backend-test',
  targetEnv && targetEnv !== 'backend-test' ? 'NOTIFICATION_ENGINE_TARGET_ENV=backend-test' : null,
  restoreEnabled ? null : 'NOTIFICATION_ENGINE_FIXTURE_RESTORE=true',
  fixtureOrderId ? null : 'NOTIFICATION_ENGINE_FIXTURE_ORDER_ID',
  recipientUserId ? null : 'NOTIFICATION_ENGINE_FIXTURE_RECIPIENT_USER_ID',
  nonVisibleUserId ? null : 'NOTIFICATION_ENGINE_FIXTURE_NONVISIBLE_USER_ID',
  dockerContainerExists(postgresContainer) ? null : `docker container ${postgresContainer}`,
].filter((value): value is string => Boolean(value));

test.describe('notification engine stage canary', () => {
  test.skip(
    !CANARY_ENABLED,
    'Set NOTIFICATION_ENGINE_STAGE_CANARY=true to enable the notification engine stage canary.',
  );
  test.skip(
    CANARY_ENABLED && missingCanaryPrerequisites.length > 0,
    `Missing notification engine stage canary prerequisites: ${missingCanaryPrerequisites.join(', ')}`,
  );
  test.setTimeout(240000);

  let userId: number | null = null;
  let fixtureRuleId: string | null = null;
  let fixtureOutboxId: string | null = null;

  test.beforeAll(() => {
    requireCanaryEnv();

    expectFixtureResidueZero(restoreFixture(), 'preflight restore');
    const created = createFixture();
    fixtureRuleId = created.ruleId;
    fixtureOutboxId = created.outboxId;
  });

  test.afterAll(() => {
    let restoreError: unknown;
    try {
      if (restoreEnabled) {
        expectFixtureResidueZero(restoreFixture(), 'afterAll restore');
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

  test('relays the fixture event exactly once, honours visibility, and never leaks privacy data', async ({
    request,
  }) => {
    expect(fixtureRuleId).not.toBeNull();
    expect(fixtureOutboxId).not.toBeNull();
    const ruleId = fixtureRuleId!;
    const outboxId = fixtureOutboxId!;

    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_test_notification_engine_${runId}_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(24).toString('base64url');

    userId = createSmokeUser(username, password);
    const token = await loginForApiToken(request, username, password);

    const firstSummary = await processNow(request, token);
    expect(firstSummary.processed, JSON.stringify(firstSummary)).toBeGreaterThanOrEqual(1);
    expect(firstSummary.failed, JSON.stringify(firstSummary)).toBe(0);

    const expectedIdempotencyKey = `notif-rule:${outboxId}:${ruleId}:${recipientUserId}`;
    const delivered = loadDeliveredNotifications(expectedIdempotencyKey);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      sourceType: 'notification_rule',
      sourceId: ruleId,
      entityType: 'order',
      entityId: String(fixtureOrderId),
      idempotencyKey: expectedIdempotencyKey,
    });

    const nonVisibleCount = loadNotificationCountForUser(nonVisibleUserId!, ruleId);
    expect(nonVisibleCount, 'base-visibility filter must drop the non-visible recipient').toBe(0);

    const replaySummary = await processNow(request, token);
    expect(replaySummary.failed, JSON.stringify(replaySummary)).toBe(0);

    const deliveredAfterReplay = loadDeliveredNotifications(expectedIdempotencyKey);
    expect(deliveredAfterReplay, 'replay must not create a duplicate notification').toHaveLength(1);
    expect(deliveredAfterReplay[0].notificationId).toBe(delivered[0].notificationId);

    const privacyTarget = `${deliveredAfterReplay[0].title} ${deliveredAfterReplay[0].message}`;
    expect(privacyTarget).not.toMatch(/\+?\d{10,}/);
    expect(privacyTarget).not.toMatch(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
    expect(privacyTarget).not.toMatch(/\{[a-zA-Z0-9_]+\}/);
    expect(privacyTarget).toContain(String(fixtureOrderId));
    expect(privacyTarget).toContain(EVENT_TYPE);

    expectFixtureResidueZero(restoreFixture(), 'explicit restore');

    if (expectDisabledAfterRestore) {
      const postRestoreResponse = await request.post(`${backendApiUrl}/outbox-relay/process-now`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(postRestoreResponse.status(), await postRestoreResponse.text()).toBe(503);
      const postRestoreBody = await parseResponseBody(postRestoreResponse);
      expect(errorCode(postRestoreBody)).toBe('NOTIFICATION_ENGINE_DISABLED');
    }
  });
});

interface RelaySummary {
  claimed?: number;
  processed: number;
  failed: number;
}

async function processNow(request: APIRequestContext, token: string): Promise<RelaySummary> {
  const response = await request.post(`${backendApiUrl}/outbox-relay/process-now`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status() === 503) {
    const body = await parseResponseBody(response);
    if (errorCode(body) === 'NOTIFICATION_ENGINE_DISABLED') {
      throw new Error(
        'Notification engine is disabled on the target (NOTIFICATION_ENGINE_DISABLED). ' +
          'Enable BACKEND_NOTIFICATIONS_ENGINE_ENABLED on the target before running this canary.',
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
  if (!fixtureKey) {
    throw new Error('NOTIFICATION_ENGINE_FIXTURE_KEY is required');
  }
  if (fixtureKey !== FIXTURE_KEY) {
    throw new Error(`NOTIFICATION_ENGINE_FIXTURE_KEY must equal ${FIXTURE_KEY}`);
  }
  if (!targetEnv) {
    throw new Error('NOTIFICATION_ENGINE_TARGET_ENV is required');
  }
  assertTargetEnv(targetEnv);
  assertBackendApiUrl(backendApiUrl);
  if (!restoreEnabled) {
    throw new Error('NOTIFICATION_ENGINE_FIXTURE_RESTORE=true is required');
  }
  if (!fixtureOrderId) {
    throw new Error('NOTIFICATION_ENGINE_FIXTURE_ORDER_ID is required (positive integer)');
  }
  if (!recipientUserId) {
    throw new Error('NOTIFICATION_ENGINE_FIXTURE_RECIPIENT_USER_ID is required (positive integer)');
  }
  if (!nonVisibleUserId) {
    throw new Error('NOTIFICATION_ENGINE_FIXTURE_NONVISIBLE_USER_ID is required (positive integer)');
  }
}

/**
 * Fail-closed target-env guard: only `backend-test` is acceptable. Anything
 * resembling prod/production/live MUST throw before any fixture or write
 * happens — never silently skip a write-capable canary against a live target.
 */
function assertTargetEnv(env: string) {
  if (env === 'backend-test') return;
  throw new Error(
    `Refusing to run notification engine stage canary against target env "${env}". ` +
      'Only NOTIFICATION_ENGINE_TARGET_ENV=backend-test is permitted (prod/production/live are rejected).',
  );
}

/**
 * Defence in depth: even if the target-env string passes, the backend API URL
 * host must look like a backend-test host and must not match known prod/live
 * host patterns.
 */
function assertBackendApiUrl(url: string) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (/prod|production|\blive\b/.test(host)) {
    throw new Error(`Refusing to target a prod/live-looking backend host: ${host}`);
  }
  if (!host.includes('backend-test')) {
    throw new Error(`Notification engine stage canary backend host must contain "backend-test", got: ${host}`);
  }
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

function errorCode(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as { code?: unknown; error?: unknown };
  if (record.code !== undefined) return record.code;
  if (!record.error || typeof record.error !== 'object' || Array.isArray(record.error)) {
    return undefined;
  }
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
          '${escapeSql(username)}',
          '${escapeSql(email)}',
          '${escapeSql(passwordHash)}',
          2,
          'E2E Test Notification Engine Stage Canary',
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

interface CreatedFixture {
  ruleId: string;
  outboxId: string;
}

/**
 * Inserts exactly one `notification_rules` fixture row (rule_code prefixed
 * with `E2E-notif-canary-`) and one pending `outbox_events` fixture row for
 * `order.production_status_changed`. Both rows are uniquely identifiable by
 * the fixture key so `restoreFixture` can delete them precisely and prove
 * zero residue afterwards. Templates use ONLY the engine's whitelisted
 * `{orderId}`/`{eventType}` placeholders — never raw payload/finance/phone
 * fields.
 */
function createFixture(): CreatedFixture {
  const idempotencyKey = `E2E-notif-canary-${fixtureKey}-${crypto.randomBytes(6).toString('hex')}`;
  const recipients = JSON.stringify({ userIds: [recipientUserId, nonVisibleUserId] });
  const payload = JSON.stringify({
    orderId: fixtureOrderId,
    clientId: null,
    productionStatusId: null,
    fixtureKey,
  });

  const result = psqlJson<{ ruleId: string; outboxId: string }>(`
    WITH inserted_rule AS (
      INSERT INTO notification_rules
        (rule_code, event_type, is_enabled, priority, level, conditions_json, recipients_json, title_template, message_template)
      VALUES (
        '${escapeSql(ruleCode)}',
        '${escapeSql(EVENT_TYPE)}',
        true,
        100,
        'info',
        '{}'::jsonb,
        '${escapeSql(recipients)}'::jsonb,
        'Order {orderId} update',
        'Order {orderId} changed: {eventType}'
      )
      RETURNING notification_rule_id
    ),
    inserted_outbox AS (
      INSERT INTO outbox_events
        (event_type, aggregate_type, aggregate_id, payload_json, status, idempotency_key)
      VALUES (
        '${escapeSql(EVENT_TYPE)}',
        'order',
        '${escapeSql(String(fixtureOrderId))}',
        '${escapeSql(payload)}'::jsonb,
        'pending',
        '${escapeSql(idempotencyKey)}'
      )
      RETURNING outbox_event_id
    )
    SELECT json_build_object(
      'ruleId', (SELECT notification_rule_id::text FROM inserted_rule),
      'outboxId', (SELECT outbox_event_id::text FROM inserted_outbox)
    )::text;
  `);

  expect(result.ruleId).toBeTruthy();
  expect(result.outboxId).toBeTruthy();
  return result;
}

interface FixtureResidue {
  notifications: number;
  outboxEvents: number;
  notificationRules: number;
}

/**
 * Deletes fixture rows in dependency-safe order (notifications -> outbox ->
 * rules) and returns post-delete counts so the caller can assert restore-to-
 * zero. All deletes are scoped by the fixture rule id(s)/key so nothing
 * outside this fixture's footprint is ever touched.
 */
function restoreFixture(): FixtureResidue {
  return psqlJson<FixtureResidue>(`
    WITH fixture_rules AS (
      SELECT notification_rule_id
      FROM notification_rules
      WHERE rule_code LIKE 'E2E-notif-canary-%'
    ),
    deleted_notifications AS (
      DELETE FROM notifications
      WHERE idempotency_key LIKE 'notif-rule:%'
        AND source_type = 'notification_rule'
        AND source_id IN (SELECT notification_rule_id::text FROM fixture_rules)
      RETURNING notification_id
    ),
    deleted_outbox AS (
      DELETE FROM outbox_events
      WHERE aggregate_type = 'order'
        AND aggregate_id = '${escapeSql(String(fixtureOrderId))}'
        AND event_type = '${escapeSql(EVENT_TYPE)}'
        AND idempotency_key LIKE 'E2E%'
      RETURNING outbox_event_id
    ),
    deleted_rules AS (
      DELETE FROM notification_rules
      WHERE rule_code LIKE 'E2E-notif-canary-%'
      RETURNING notification_rule_id
    )
    SELECT json_build_object(
      'notifications', (SELECT count(*)::int FROM deleted_notifications),
      'outboxEvents', (SELECT count(*)::int FROM deleted_outbox),
      'notificationRules', (SELECT count(*)::int FROM deleted_rules)
    )::text;
  `);
}

function expectFixtureResidueZero(_residue: FixtureResidue, label: string) {
  const proof = loadFixtureResidueProof();
  expect(proof.notifications, label).toBe(0);
  expect(proof.outboxEvents, label).toBe(0);
  expect(proof.notificationRules, label).toBe(0);
}

function loadFixtureResidueProof(): FixtureResidue {
  return psqlJson<FixtureResidue>(`
    SELECT json_build_object(
      'notifications', (
        SELECT count(*)::int
        FROM notifications n
        JOIN notification_rules r ON r.notification_rule_id::text = n.source_id
        WHERE n.idempotency_key LIKE 'notif-rule:%'
          AND n.source_type = 'notification_rule'
          AND r.rule_code LIKE 'E2E-notif-canary-%'
      ),
      'outboxEvents', (
        SELECT count(*)::int FROM outbox_events
        WHERE aggregate_type = 'order'
          AND aggregate_id = '${escapeSql(String(fixtureOrderId))}'
          AND event_type = '${escapeSql(EVENT_TYPE)}'
          AND idempotency_key LIKE 'E2E%'
      ),
      'notificationRules', (
        SELECT count(*)::int FROM notification_rules
        WHERE rule_code LIKE 'E2E-notif-canary-%'
      )
    )::text;
  `);
}

interface DeliveredNotification {
  notificationId: string;
  sourceType: string;
  sourceId: string;
  entityType: string;
  entityId: string;
  idempotencyKey: string;
  title: string;
  message: string;
}

function loadDeliveredNotifications(idempotencyKey: string): DeliveredNotification[] {
  return psqlJsonArray<DeliveredNotification>(`
    SELECT coalesce(json_agg(row_to_json(n)), '[]'::json)::text
    FROM (
      SELECT
        notification_id::text AS "notificationId",
        source_type AS "sourceType",
        source_id AS "sourceId",
        entity_type AS "entityType",
        entity_id AS "entityId",
        idempotency_key AS "idempotencyKey",
        title,
        message
      FROM notifications
      WHERE idempotency_key = '${escapeSql(idempotencyKey)}'
    ) n;
  `);
}

function loadNotificationCountForUser(userId: number, ruleId: string): number {
  return Number(
    psql(`
      SELECT count(*)::int
      FROM notifications
      WHERE user_id = ${userId}
        AND source_type = 'notification_rule'
        AND source_id = '${escapeSql(ruleId)}';
    `),
  );
}

function psql<T = string>(sql: string): T {
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

  return output as T;
}

function psqlJson<T>(sql: string): T {
  const output = psql<string>(sql);
  if (!output) throw new Error(`Expected JSON SQL output, got empty output for: ${sql.slice(0, 160)}`);
  return JSON.parse(output) as T;
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
