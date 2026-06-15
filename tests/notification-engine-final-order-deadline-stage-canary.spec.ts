import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import * as bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';

/**
 * Opt-in backend-test canaries for migration 019 final-order Deadline rules.
 * FINAL_ORDER_DEADLINE_STAGE_CANARY is the pre-enable shadow-rule proof and
 * requires the real 019 row to remain disabled. FINAL_ORDER_DEADLINE_STANDING_
 * STAGE_CANARY is the post-enable real-rule proof and requires the broad
 * manager rule to be disabled. Both modes require explicit fixture env, drain
 * the backend outbox relay, and restore fixture rows.
 */

const FIXTURE_KEY = 'final-order-deadline-rule-canary-2026-06-14';
const STANDING_FIXTURE_KEY = 'final-order-standing-enable-2026-06-15';
const REAL_019_RULE_CODE = 'deadline-final-order-expired-manager';
const REAL_BROAD_MANAGER_RULE_CODE = 'deadline-expired-notify-manager';
const SHADOW_FINAL_RULE_CODE = `E2E-final-order-deadline-${FIXTURE_KEY}-final`;
const DEADLINE_ENVELOPE_EVENT_TYPE = 'deadline.event.created';
const DEADLINE_EVENT_TYPE = 'DEADLINE_EXPIRED';

const CANARY_ENABLED = process.env.FINAL_ORDER_DEADLINE_STAGE_CANARY === 'true';
const STANDING_CANARY_ENABLED = process.env.FINAL_ORDER_DEADLINE_STANDING_STAGE_CANARY === 'true';
const backendApiUrl = trimTrailingSlash(
  process.env.FINAL_ORDER_DEADLINE_BACKEND_API_URL ?? 'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer = process.env.FINAL_ORDER_DEADLINE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const fixtureKey = process.env.FINAL_ORDER_DEADLINE_FIXTURE_KEY?.trim() ?? '';
const targetEnv = process.env.FINAL_ORDER_DEADLINE_TARGET_ENV?.trim() ?? '';
const restoreEnabled = process.env.FINAL_ORDER_DEADLINE_FIXTURE_RESTORE === 'true';
const fixtureOrderId = readNumberEnv('FINAL_ORDER_DEADLINE_FIXTURE_ORDER_ID');
const managerUserId = readNumberEnv('FINAL_ORDER_DEADLINE_FIXTURE_MANAGER_USER_ID');
let fixtureOutboxIdsForRestore: string[] = [];
let standingFixtureOutboxIdsForRestore: string[] = [];

const missingCanaryPrerequisites = CANARY_ENABLED
  ? [
      fixtureKey ? null : 'FINAL_ORDER_DEADLINE_FIXTURE_KEY',
      fixtureKey && fixtureKey !== FIXTURE_KEY ? `FINAL_ORDER_DEADLINE_FIXTURE_KEY=${FIXTURE_KEY}` : null,
      targetEnv ? null : 'FINAL_ORDER_DEADLINE_TARGET_ENV=backend-test',
      targetEnv && targetEnv !== 'backend-test' ? 'FINAL_ORDER_DEADLINE_TARGET_ENV=backend-test' : null,
      restoreEnabled ? null : 'FINAL_ORDER_DEADLINE_FIXTURE_RESTORE=true',
      fixtureOrderId ? null : 'FINAL_ORDER_DEADLINE_FIXTURE_ORDER_ID',
      managerUserId ? null : 'FINAL_ORDER_DEADLINE_FIXTURE_MANAGER_USER_ID',
      dockerContainerExists(postgresContainer) ? null : `docker container ${postgresContainer}`,
    ].filter((value): value is string => Boolean(value))
  : [];

const missingStandingCanaryPrerequisites = STANDING_CANARY_ENABLED
  ? [
      fixtureKey ? null : 'FINAL_ORDER_DEADLINE_FIXTURE_KEY',
      fixtureKey && fixtureKey !== STANDING_FIXTURE_KEY
        ? `FINAL_ORDER_DEADLINE_FIXTURE_KEY=${STANDING_FIXTURE_KEY}`
        : null,
      targetEnv ? null : 'FINAL_ORDER_DEADLINE_TARGET_ENV=backend-test',
      targetEnv && targetEnv !== 'backend-test' ? 'FINAL_ORDER_DEADLINE_TARGET_ENV=backend-test' : null,
      restoreEnabled ? null : 'FINAL_ORDER_DEADLINE_FIXTURE_RESTORE=true',
      fixtureOrderId ? null : 'FINAL_ORDER_DEADLINE_FIXTURE_ORDER_ID',
      managerUserId ? null : 'FINAL_ORDER_DEADLINE_FIXTURE_MANAGER_USER_ID',
      dockerContainerExists(postgresContainer) ? null : `docker container ${postgresContainer}`,
    ].filter((value): value is string => Boolean(value))
  : [];

test.describe('notification engine final-order deadline stage canary', () => {
  test.skip(
    !CANARY_ENABLED,
    'Set FINAL_ORDER_DEADLINE_STAGE_CANARY=true to enable the final-order deadline stage canary.',
  );
  test.skip(
    CANARY_ENABLED && missingCanaryPrerequisites.length > 0,
    `Missing final-order deadline stage canary prerequisites: ${missingCanaryPrerequisites.join(', ')}`,
  );
  test.setTimeout(240000);

  let userId: number | null = null;
  let fixture: CreatedFixture | null = null;

  test.beforeAll(() => {
    requireCanaryEnv();
    assertMigration019SeedReadyAndDisabled();
    assertBroadManagerSeedReconciled();
    assertFixtureOrderReady();
    expectFixtureResidueZero(restoreFixture(), 'preflight restore');
    fixture = createFixture();
    fixtureOutboxIdsForRestore = [fixture.finalOutboxId, fixture.stageOutboxId];
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

  test('final-order rule is ready: order deadline matches once, broad manager does not duplicate, order_stage does not match', async ({
    request,
  }) => {
    expect(fixture).not.toBeNull();
    const created = fixture!;

    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_test_final_deadline_${runId}_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(24).toString('base64url');
    userId = createSmokeUser(username, password);
    const token = await loginForApiToken(request, username, password);

    const firstSummary = await processRelayNow(request, token);
    expect(firstSummary.failed, JSON.stringify(firstSummary)).toBe(0);
    expect(firstSummary.processed, JSON.stringify(firstSummary)).toBeGreaterThanOrEqual(2);

    const finalRuleKey = deliveryKey(created.finalOutboxId, created.finalRuleId, managerUserId!);
    const finalRuleDelivered = loadDeliveredNotifications(finalRuleKey);
    expect(finalRuleDelivered, '019-shaped final-order rule must deliver exactly once for order deadline').toHaveLength(1);
    expect(finalRuleDelivered[0]).toMatchObject({
      sourceType: 'notification_rule',
      sourceId: created.finalRuleId,
      entityType: 'order',
      entityId: String(fixtureOrderId),
      idempotencyKey: finalRuleKey,
    });

    const managerDeliveriesForFinalOutbox = loadManagerDeliveriesForOutbox(created.finalOutboxId, created.finalRuleId);
    expect(
      managerDeliveriesForFinalOutbox,
      'manager must receive exactly one final-order notification after broad manager seed reconciliation',
    ).toHaveLength(1);
    expect(managerDeliveriesForFinalOutbox[0].sourceId).toBe(created.finalRuleId);

    const stageRuleKey = deliveryKey(created.stageOutboxId, created.finalRuleId, managerUserId!);
    expect(
      loadDeliveredNotifications(stageRuleKey),
      'order_stage deadline must not match the final-order rule deadlineEntityTypes=["order"] condition',
    ).toHaveLength(0);

    const replaySummary = await processRelayNow(request, token);
    expect(replaySummary.failed, JSON.stringify(replaySummary)).toBe(0);
    expect(loadDeliveredNotifications(finalRuleKey), 'relay replay must not duplicate final-order delivery').toHaveLength(1);
    expect(
      loadManagerDeliveriesForOutbox(created.finalOutboxId, created.finalRuleId),
      'relay replay must not duplicate manager delivery',
    ).toHaveLength(1);

    expectFixtureResidueZero(restoreFixture(), 'explicit restore');
  });
});

test.describe('notification engine final-order deadline standing stage canary', () => {
  test.skip(
    !STANDING_CANARY_ENABLED,
    'Set FINAL_ORDER_DEADLINE_STANDING_STAGE_CANARY=true to enable the standing final-order deadline stage canary.',
  );
  test.skip(
    STANDING_CANARY_ENABLED && missingStandingCanaryPrerequisites.length > 0,
    `Missing standing final-order deadline stage canary prerequisites: ${missingStandingCanaryPrerequisites.join(', ')}`,
  );
  test.setTimeout(240000);

  let userId: number | null = null;
  let fixture: CreatedStandingFixture | null = null;

  test.beforeAll(() => {
    requireStandingCanaryEnv();
    assertRealFinalOrderRuleEnabledAndBroadManagerDisabled();
    assertFixtureOrderReady();
    expectStandingFixtureResidueZero(restoreStandingFixture(), 'preflight restore');
    fixture = createStandingFixture();
    standingFixtureOutboxIdsForRestore = [fixture.finalOutboxId, fixture.stageOutboxId];
  });

  test.afterAll(() => {
    let restoreError: unknown;
    try {
      if (restoreEnabled) {
        expectStandingFixtureResidueZero(restoreStandingFixture(), 'afterAll restore');
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

  test('real enabled final-order rule delivers once, excludes order_stage, and restores notification residue', async ({
    request,
  }) => {
    expect(fixture).not.toBeNull();
    const created = fixture!;

    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_test_final_standing_${runId}_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(24).toString('base64url');
    userId = createSmokeUser(username, password);
    const token = await loginForApiToken(request, username, password);

    const firstSummary = await processRelayNow(request, token);
    expect(firstSummary.failed, JSON.stringify(firstSummary)).toBe(0);
    expect(firstSummary.processed, JSON.stringify(firstSummary)).toBeGreaterThanOrEqual(2);

    const finalRuleKey = deliveryKey(created.finalOutboxId, created.realRuleId, managerUserId!);
    const finalRuleDelivered = loadDeliveredNotifications(finalRuleKey);
    expect(finalRuleDelivered, 'real final-order rule must deliver exactly once for order deadline').toHaveLength(1);
    expect(finalRuleDelivered[0]).toMatchObject({
      sourceType: 'notification_rule',
      sourceId: created.realRuleId,
      entityType: 'order',
      entityId: String(fixtureOrderId),
      idempotencyKey: finalRuleKey,
    });

    expect(
      loadManagerDeliveriesForOutbox(created.finalOutboxId, created.realRuleId),
      'manager must receive exactly one notification from the real final-order rule',
    ).toHaveLength(1);

    const stageRuleKey = deliveryKey(created.stageOutboxId, created.realRuleId, managerUserId!);
    expect(
      loadDeliveredNotifications(stageRuleKey),
      'order_stage deadline must not match the standing final-order rule deadlineEntityTypes=["order"] condition',
    ).toHaveLength(0);

    const replaySummary = await processRelayNow(request, token);
    expect(replaySummary.failed, JSON.stringify(replaySummary)).toBe(0);
    expect(loadDeliveredNotifications(finalRuleKey), 'relay replay must not duplicate real-rule delivery').toHaveLength(1);
    expect(loadManagerDeliveriesForOutbox(created.finalOutboxId, created.realRuleId)).toHaveLength(1);

    expectStandingFixtureResidueZero(restoreStandingFixture(), 'explicit restore');
  });
});

interface RelaySummary {
  claimed?: number;
  processed: number;
  failed: number;
}

interface CreatedFixture {
  finalRuleId: string;
  finalDeadlineId: string;
  finalDeadlineEventId: string;
  finalOutboxId: string;
  stageDeadlineId: string;
  stageDeadlineEventId: string;
  stageOutboxId: string;
}

interface CreatedStandingFixture {
  realRuleId: string;
  finalDeadlineId: string;
  finalDeadlineEventId: string;
  finalOutboxId: string;
  stageDeadlineId: string;
  stageDeadlineEventId: string;
  stageOutboxId: string;
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

interface FixtureResidue {
  notifications: number;
  outboxEvents: number;
  deadlineEvents: number;
  deadlineInstances: number;
  notificationRules: number;
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
          'Enable the backend notification engine and relay owner before running this canary.',
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
  if (process.env.FINAL_ORDER_DEADLINE_STAGE_CANARY !== 'true') {
    throw new Error('FINAL_ORDER_DEADLINE_STAGE_CANARY=true is required');
  }
  if (fixtureKey !== FIXTURE_KEY) {
    throw new Error(`FINAL_ORDER_DEADLINE_FIXTURE_KEY must equal ${FIXTURE_KEY}`);
  }
  assertTargetEnv(targetEnv);
  assertBackendApiUrl(backendApiUrl);
  if (!restoreEnabled) throw new Error('FINAL_ORDER_DEADLINE_FIXTURE_RESTORE=true is required');
  if (!fixtureOrderId) throw new Error('FINAL_ORDER_DEADLINE_FIXTURE_ORDER_ID is required (positive integer)');
  if (!managerUserId) throw new Error('FINAL_ORDER_DEADLINE_FIXTURE_MANAGER_USER_ID is required (positive integer)');
}

function requireStandingCanaryEnv() {
  if (process.env.FINAL_ORDER_DEADLINE_STANDING_STAGE_CANARY !== 'true') {
    throw new Error('FINAL_ORDER_DEADLINE_STANDING_STAGE_CANARY=true is required');
  }
  if (fixtureKey !== STANDING_FIXTURE_KEY) {
    throw new Error(`FINAL_ORDER_DEADLINE_FIXTURE_KEY must equal ${STANDING_FIXTURE_KEY}`);
  }
  assertTargetEnv(targetEnv);
  assertBackendApiUrl(backendApiUrl);
  if (!restoreEnabled) throw new Error('FINAL_ORDER_DEADLINE_FIXTURE_RESTORE=true is required');
  if (!fixtureOrderId) throw new Error('FINAL_ORDER_DEADLINE_FIXTURE_ORDER_ID is required (positive integer)');
  if (!managerUserId) throw new Error('FINAL_ORDER_DEADLINE_FIXTURE_MANAGER_USER_ID is required (positive integer)');
}

function assertTargetEnv(env: string) {
  if (env === 'backend-test') return;
  throw new Error(
    `Refusing to run final-order deadline canary against target env "${env}". ` +
      'Only FINAL_ORDER_DEADLINE_TARGET_ENV=backend-test is permitted.',
  );
}

function assertBackendApiUrl(url: string) {
  const host = new URL(url).hostname.toLowerCase();
  if (/prod|production|\blive\b/.test(host)) {
    throw new Error(`Refusing to target a prod/live-looking backend host: ${host}`);
  }
  if (!host.includes('backend-test')) {
    throw new Error(`Final-order deadline canary backend host must contain "backend-test", got: ${host}`);
  }
}

function assertMigration019SeedReadyAndDisabled() {
  const rows = psqlJsonArray<{
    ruleCode: string;
    isEnabled: boolean;
    conditions: Record<string, unknown>;
    recipients: Record<string, unknown>;
    eventType: string;
    priority: number;
    level: string;
  }>(`
    SELECT coalesce(json_agg(row_to_json(r)), '[]'::json)::text
    FROM (
      SELECT
        rule_code AS "ruleCode",
        is_enabled AS "isEnabled",
        event_type AS "eventType",
        priority,
        level,
        conditions_json AS conditions,
        recipients_json AS recipients
      FROM notification_rules
      WHERE rule_code = '${escapeSql(REAL_019_RULE_CODE)}'
    ) r;
  `);

  expect(rows, 'migration 019 disabled seed row must exist before operator enablement').toHaveLength(1);
  expect(rows[0]).toMatchObject({
    ruleCode: REAL_019_RULE_CODE,
    isEnabled: false,
    eventType: DEADLINE_EVENT_TYPE,
    priority: 90,
    level: 'warning',
  });
  expect(rows[0].conditions).toEqual({
    deadlineEntityTypes: ['order'],
    excludeOrderStatusIds: [7],
    excludeCompletedOrders: true,
    requireCurrentDeadlineEvent: true,
  });
  expect(rows[0].recipients).toEqual({ resolvers: ['order_manager'] });
}

function assertBroadManagerSeedReconciled() {
  const rows = psqlJsonArray<{ ruleCode: string; isEnabled: boolean }>(`
    SELECT coalesce(json_agg(row_to_json(r)), '[]'::json)::text
    FROM (
      SELECT rule_code AS "ruleCode", is_enabled AS "isEnabled"
      FROM notification_rules
      WHERE rule_code = '${escapeSql(REAL_BROAD_MANAGER_RULE_CODE)}'
    ) r;
  `);

  if (rows.length === 0) return;
  expect(
    rows[0].isEnabled,
    `${REAL_BROAD_MANAGER_RULE_CODE} must be disabled/reconciled before enabling the final-order manager rule, otherwise manager delivery duplicates by rule idempotency`,
  ).toBe(false);
}

function assertRealFinalOrderRuleEnabledAndBroadManagerDisabled() {
  const rows = psqlJsonArray<{
    ruleCode: string;
    isEnabled: boolean;
    conditions: Record<string, unknown>;
    recipients: Record<string, unknown>;
    eventType: string;
    priority: number;
    level: string;
  }>(`
    SELECT coalesce(json_agg(row_to_json(r)), '[]'::json)::text
    FROM (
      SELECT
        rule_code AS "ruleCode",
        is_enabled AS "isEnabled",
        event_type AS "eventType",
        priority,
        level,
        conditions_json AS conditions,
        recipients_json AS recipients
      FROM notification_rules
      WHERE rule_code = '${escapeSql(REAL_019_RULE_CODE)}'
    ) r;
  `);

  expect(rows, 'standing final-order seed row must exist before standing canary').toHaveLength(1);
  expect(rows[0]).toMatchObject({
    ruleCode: REAL_019_RULE_CODE,
    isEnabled: true,
    eventType: DEADLINE_EVENT_TYPE,
    priority: 90,
    level: 'warning',
  });
  expect(rows[0].conditions).toEqual({
    deadlineEntityTypes: ['order'],
    excludeOrderStatusIds: [7],
    excludeCompletedOrders: true,
    requireCurrentDeadlineEvent: true,
  });
  expect(rows[0].recipients).toEqual({ resolvers: ['order_manager'] });

  assertBroadManagerSeedReconciled();
}

function assertFixtureOrderReady() {
  const rows = psqlJsonArray<{
    orderId: number;
    managerId: number | null;
    orderStatusId: number | null;
    completionDate: string | null;
  }>(`
    SELECT coalesce(json_agg(row_to_json(o)), '[]'::json)::text
    FROM (
      SELECT
        order_id AS "orderId",
        manager_id AS "managerId",
        order_status_id AS "orderStatusId",
        completion_date AS "completionDate"
      FROM orders
      WHERE order_id = ${fixtureOrderId} AND delete_flag = false
    ) o;
  `);

  expect(rows, 'fixture order must exist').toHaveLength(1);
  expect(rows[0].managerId, 'fixture order manager must match FINAL_ORDER_DEADLINE_FIXTURE_MANAGER_USER_ID')
    .toBe(managerUserId);
  expect(rows[0].orderStatusId, 'fixture order status 7 is explicitly excluded by the final-order rule').not.toBe(7);
  expect(rows[0].completionDate, 'fixture order must be incomplete because excludeCompletedOrders=true').toBeNull();
}

function createFixture(): CreatedFixture {
  const suffix = crypto.randomBytes(6).toString('hex');
  const finalOutboxKey = `E2E-final-order-deadline-${fixtureKey}-order-${suffix}`;
  const stageOutboxKey = `E2E-final-order-deadline-${fixtureKey}-stage-${suffix}`;
  const finalConditions = JSON.stringify({
    deadlineEntityTypes: ['order'],
    excludeOrderStatusIds: [7],
    excludeCompletedOrders: true,
    requireCurrentDeadlineEvent: true,
  });
  const orderManagerRecipients = JSON.stringify({ resolvers: ['order_manager'] });

  return psqlJson<CreatedFixture>(`
    WITH final_rule AS (
      INSERT INTO notification_rules
        (rule_code, event_type, is_enabled, priority, level, conditions_json, recipients_json, title_template, message_template)
      VALUES (
        '${escapeSql(SHADOW_FINAL_RULE_CODE)}',
        '${escapeSql(DEADLINE_EVENT_TYPE)}',
        true,
        90,
        'warning',
        '${escapeSql(finalConditions)}'::jsonb,
        '${escapeSql(orderManagerRecipients)}'::jsonb,
        'E2E final order deadline expired',
        'Order {orderId} final deadline expired: {eventType}'
      )
      RETURNING notification_rule_id
    ),
    final_deadline AS (
      INSERT INTO deadline_instances
        (entity_type, entity_id, order_id, responsible_user_id, deadline_at, status, source, metadata_json)
      VALUES (
        'order',
        '${escapeSql(String(fixtureOrderId))}',
        ${fixtureOrderId},
        ${managerUserId},
        now() - interval '1 hour',
        'expired',
        'system',
        jsonb_build_object('fixtureKey', '${escapeSql(fixtureKey)}', 'kind', 'final-order')
      )
      RETURNING deadline_id
    ),
    final_event AS (
      INSERT INTO deadline_events
        (deadline_id, event_type, severity, entity_type, entity_id, order_id, deadline_at, event_at, payload_json, idempotency_key)
      SELECT
        deadline_id,
        '${escapeSql(DEADLINE_EVENT_TYPE)}',
        'warning',
        'order',
        '${escapeSql(String(fixtureOrderId))}',
        ${fixtureOrderId},
        now() - interval '1 hour',
        now(),
        jsonb_build_object('fixtureKey', '${escapeSql(fixtureKey)}', 'kind', 'final-order'),
        '${escapeSql(finalOutboxKey)}:deadline-event'
      FROM final_deadline
      RETURNING deadline_event_id, deadline_id
    ),
    final_outbox AS (
      INSERT INTO outbox_events
        (event_type, aggregate_type, aggregate_id, payload_json, status, idempotency_key)
      SELECT
        '${escapeSql(DEADLINE_ENVELOPE_EVENT_TYPE)}',
        'deadline',
        deadline_id::text,
        jsonb_build_object(
          'eventType', '${escapeSql(DEADLINE_EVENT_TYPE)}',
          'orderId', ${fixtureOrderId},
          'deadlineEventId', deadline_event_id::text,
          'fixtureKey', '${escapeSql(fixtureKey)}',
          'kind', 'final-order'
        ),
        'pending',
        '${escapeSql(finalOutboxKey)}'
      FROM final_event
      RETURNING outbox_event_id
    ),
    stage_deadline AS (
      INSERT INTO deadline_instances
        (entity_type, entity_id, order_id, responsible_user_id, deadline_at, status, source, metadata_json)
      VALUES (
        'order_stage',
        '${escapeSql(String(fixtureOrderId))}:stage',
        ${fixtureOrderId},
        ${managerUserId},
        now() - interval '1 hour',
        'expired',
        'system',
        jsonb_build_object('fixtureKey', '${escapeSql(fixtureKey)}', 'kind', 'order-stage')
      )
      RETURNING deadline_id
    ),
    stage_event AS (
      INSERT INTO deadline_events
        (deadline_id, event_type, severity, entity_type, entity_id, order_id, deadline_at, event_at, payload_json, idempotency_key)
      SELECT
        deadline_id,
        '${escapeSql(DEADLINE_EVENT_TYPE)}',
        'warning',
        'order_stage',
        '${escapeSql(String(fixtureOrderId))}:stage',
        ${fixtureOrderId},
        now() - interval '1 hour',
        now(),
        jsonb_build_object('fixtureKey', '${escapeSql(fixtureKey)}', 'kind', 'order-stage'),
        '${escapeSql(stageOutboxKey)}:deadline-event'
      FROM stage_deadline
      RETURNING deadline_event_id, deadline_id
    ),
    stage_outbox AS (
      INSERT INTO outbox_events
        (event_type, aggregate_type, aggregate_id, payload_json, status, idempotency_key)
      SELECT
        '${escapeSql(DEADLINE_ENVELOPE_EVENT_TYPE)}',
        'deadline',
        deadline_id::text,
        jsonb_build_object(
          'eventType', '${escapeSql(DEADLINE_EVENT_TYPE)}',
          'orderId', ${fixtureOrderId},
          'deadlineEventId', deadline_event_id::text,
          'fixtureKey', '${escapeSql(fixtureKey)}',
          'kind', 'order-stage'
        ),
        'pending',
        '${escapeSql(stageOutboxKey)}'
      FROM stage_event
      RETURNING outbox_event_id
    )
    SELECT json_build_object(
      'finalRuleId', (SELECT notification_rule_id::text FROM final_rule),
      'finalDeadlineId', (SELECT deadline_id::text FROM final_event),
      'finalDeadlineEventId', (SELECT deadline_event_id::text FROM final_event),
      'finalOutboxId', (SELECT outbox_event_id::text FROM final_outbox),
      'stageDeadlineId', (SELECT deadline_id::text FROM stage_event),
      'stageDeadlineEventId', (SELECT deadline_event_id::text FROM stage_event),
      'stageOutboxId', (SELECT outbox_event_id::text FROM stage_outbox)
    )::text;
  `);
}

function createStandingFixture(): CreatedStandingFixture {
  const suffix = crypto.randomBytes(6).toString('hex');
  const finalOutboxKey = `${fixtureKey}-order-${suffix}`;
  const stageOutboxKey = `${fixtureKey}-stage-${suffix}`;

  return psqlJson<CreatedStandingFixture>(`
    WITH real_rule AS (
      SELECT notification_rule_id
      FROM notification_rules
      WHERE rule_code = '${escapeSql(REAL_019_RULE_CODE)}'
        AND is_enabled = true
    ),
    final_deadline AS (
      INSERT INTO deadline_instances
        (entity_type, entity_id, order_id, responsible_user_id, deadline_at, status, source, metadata_json)
      VALUES (
        'order',
        '${escapeSql(String(fixtureOrderId))}',
        ${fixtureOrderId},
        ${managerUserId},
        now() - interval '1 hour',
        'expired',
        'system',
        jsonb_build_object('fixtureKey', '${escapeSql(fixtureKey)}', 'kind', 'standing-final-order')
      )
      RETURNING deadline_id
    ),
    final_event AS (
      INSERT INTO deadline_events
        (deadline_id, event_type, severity, entity_type, entity_id, order_id, deadline_at, event_at, payload_json, idempotency_key)
      SELECT
        deadline_id,
        '${escapeSql(DEADLINE_EVENT_TYPE)}',
        'warning',
        'order',
        '${escapeSql(String(fixtureOrderId))}',
        ${fixtureOrderId},
        now() - interval '1 hour',
        now(),
        jsonb_build_object('fixtureKey', '${escapeSql(fixtureKey)}', 'kind', 'standing-final-order'),
        '${escapeSql(finalOutboxKey)}:deadline-event'
      FROM final_deadline
      RETURNING deadline_event_id, deadline_id
    ),
    final_outbox AS (
      INSERT INTO outbox_events
        (event_type, aggregate_type, aggregate_id, payload_json, status, idempotency_key)
      SELECT
        '${escapeSql(DEADLINE_ENVELOPE_EVENT_TYPE)}',
        'deadline',
        deadline_id::text,
        jsonb_build_object(
          'eventType', '${escapeSql(DEADLINE_EVENT_TYPE)}',
          'orderId', ${fixtureOrderId},
          'deadlineEventId', deadline_event_id::text,
          'fixtureKey', '${escapeSql(fixtureKey)}',
          'kind', 'standing-final-order'
        ),
        'pending',
        '${escapeSql(finalOutboxKey)}'
      FROM final_event
      RETURNING outbox_event_id
    ),
    stage_deadline AS (
      INSERT INTO deadline_instances
        (entity_type, entity_id, order_id, responsible_user_id, deadline_at, status, source, metadata_json)
      VALUES (
        'order_stage',
        '${escapeSql(String(fixtureOrderId))}:stage',
        ${fixtureOrderId},
        ${managerUserId},
        now() - interval '1 hour',
        'expired',
        'system',
        jsonb_build_object('fixtureKey', '${escapeSql(fixtureKey)}', 'kind', 'standing-order-stage')
      )
      RETURNING deadline_id
    ),
    stage_event AS (
      INSERT INTO deadline_events
        (deadline_id, event_type, severity, entity_type, entity_id, order_id, deadline_at, event_at, payload_json, idempotency_key)
      SELECT
        deadline_id,
        '${escapeSql(DEADLINE_EVENT_TYPE)}',
        'warning',
        'order_stage',
        '${escapeSql(String(fixtureOrderId))}:stage',
        ${fixtureOrderId},
        now() - interval '1 hour',
        now(),
        jsonb_build_object('fixtureKey', '${escapeSql(fixtureKey)}', 'kind', 'standing-order-stage'),
        '${escapeSql(stageOutboxKey)}:deadline-event'
      FROM stage_deadline
      RETURNING deadline_event_id, deadline_id
    ),
    stage_outbox AS (
      INSERT INTO outbox_events
        (event_type, aggregate_type, aggregate_id, payload_json, status, idempotency_key)
      SELECT
        '${escapeSql(DEADLINE_ENVELOPE_EVENT_TYPE)}',
        'deadline',
        deadline_id::text,
        jsonb_build_object(
          'eventType', '${escapeSql(DEADLINE_EVENT_TYPE)}',
          'orderId', ${fixtureOrderId},
          'deadlineEventId', deadline_event_id::text,
          'fixtureKey', '${escapeSql(fixtureKey)}',
          'kind', 'standing-order-stage'
        ),
        'pending',
        '${escapeSql(stageOutboxKey)}'
      FROM stage_event
      RETURNING outbox_event_id
    )
    SELECT json_build_object(
      'realRuleId', (SELECT notification_rule_id::text FROM real_rule),
      'finalDeadlineId', (SELECT deadline_id::text FROM final_event),
      'finalDeadlineEventId', (SELECT deadline_event_id::text FROM final_event),
      'finalOutboxId', (SELECT outbox_event_id::text FROM final_outbox),
      'stageDeadlineId', (SELECT deadline_id::text FROM stage_event),
      'stageDeadlineEventId', (SELECT deadline_event_id::text FROM stage_event),
      'stageOutboxId', (SELECT outbox_event_id::text FROM stage_outbox)
    )::text;
  `);
}

function restoreFixture(): FixtureResidue {
  const outboxNotificationFilter = fixtureOutboxNotificationFilter();

  return psqlJson<FixtureResidue>(`
    WITH fixture_rules AS (
      SELECT notification_rule_id::text AS notification_rule_id
      FROM notification_rules
      WHERE rule_code = '${escapeSql(SHADOW_FINAL_RULE_CODE)}'
    ),
    fixture_outbox AS (
      SELECT outbox_event_id::text AS outbox_event_id, aggregate_id
      FROM outbox_events
      WHERE idempotency_key LIKE 'E2E-final-order-deadline-${escapeLike(fixtureKey)}-%'
    ),
    fixture_deadlines AS (
      SELECT deadline_id::text AS deadline_id
      FROM deadline_instances
      WHERE metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
    ),
    deleted_notifications AS (
      DELETE FROM notifications
      WHERE (
          source_type = 'notification_rule'
          AND source_id IN (SELECT notification_rule_id FROM fixture_rules)
        )
        OR EXISTS (
          SELECT 1 FROM fixture_outbox fo
          WHERE notifications.idempotency_key LIKE 'notif-rule:' || fo.outbox_event_id || ':%'
        )
        OR (${outboxNotificationFilter})
      RETURNING notification_id
    ),
    deleted_outbox AS (
      DELETE FROM outbox_events
      WHERE outbox_event_id::text IN (SELECT outbox_event_id FROM fixture_outbox)
      RETURNING outbox_event_id
    ),
    deleted_events AS (
      DELETE FROM deadline_events
      WHERE deadline_id::text IN (SELECT deadline_id FROM fixture_deadlines)
         OR payload_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
      RETURNING deadline_event_id
    ),
    deleted_deadlines AS (
      DELETE FROM deadline_instances
      WHERE deadline_id::text IN (SELECT deadline_id FROM fixture_deadlines)
      RETURNING deadline_id
    ),
    deleted_rules AS (
      DELETE FROM notification_rules
      WHERE rule_code = '${escapeSql(SHADOW_FINAL_RULE_CODE)}'
      RETURNING notification_rule_id
    )
    SELECT json_build_object(
      'notifications', (SELECT count(*)::int FROM deleted_notifications),
      'outboxEvents', (SELECT count(*)::int FROM deleted_outbox),
      'deadlineEvents', (SELECT count(*)::int FROM deleted_events),
      'deadlineInstances', (SELECT count(*)::int FROM deleted_deadlines),
      'notificationRules', (SELECT count(*)::int FROM deleted_rules)
    )::text;
  `);
}

function restoreStandingFixture(): FixtureResidue {
  const outboxNotificationFilter = standingFixtureOutboxNotificationFilter();

  return psqlJson<FixtureResidue>(`
    WITH real_rule AS (
      SELECT notification_rule_id::text AS notification_rule_id
      FROM notification_rules
      WHERE rule_code = '${escapeSql(REAL_019_RULE_CODE)}'
    ),
    fixture_outbox AS (
      SELECT outbox_event_id::text AS outbox_event_id, aggregate_id
      FROM outbox_events
      WHERE idempotency_key LIKE '${escapeLike(fixtureKey)}-%'
    ),
    fixture_deadlines AS (
      SELECT deadline_id::text AS deadline_id
      FROM deadline_instances
      WHERE metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
    ),
    deleted_notifications AS (
      DELETE FROM notifications
      WHERE source_type = 'notification_rule'
        AND (
          (
            source_id IN (SELECT notification_rule_id FROM real_rule)
            AND EXISTS (
              SELECT 1 FROM fixture_outbox fo
              WHERE notifications.idempotency_key LIKE 'notif-rule:' || fo.outbox_event_id || ':%'
            )
          )
          OR (${outboxNotificationFilter})
        )
      RETURNING notification_id
    ),
    deleted_outbox AS (
      DELETE FROM outbox_events
      WHERE outbox_event_id::text IN (SELECT outbox_event_id FROM fixture_outbox)
      RETURNING outbox_event_id
    ),
    deleted_events AS (
      DELETE FROM deadline_events
      WHERE deadline_id::text IN (SELECT deadline_id FROM fixture_deadlines)
         OR payload_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
      RETURNING deadline_event_id
    ),
    deleted_deadlines AS (
      DELETE FROM deadline_instances
      WHERE deadline_id::text IN (SELECT deadline_id FROM fixture_deadlines)
      RETURNING deadline_id
    )
    SELECT json_build_object(
      'notifications', (SELECT count(*)::int FROM deleted_notifications),
      'outboxEvents', (SELECT count(*)::int FROM deleted_outbox),
      'deadlineEvents', (SELECT count(*)::int FROM deleted_events),
      'deadlineInstances', (SELECT count(*)::int FROM deleted_deadlines),
      'notificationRules', 0
    )::text;
  `);
}

function expectFixtureResidueZero(_residue: FixtureResidue, label: string) {
  const proof = loadFixtureResidueProof();
  expect(proof.notifications, `${label}: notifications`).toBe(0);
  expect(proof.outboxEvents, `${label}: outbox events`).toBe(0);
  expect(proof.deadlineEvents, `${label}: deadline events`).toBe(0);
  expect(proof.deadlineInstances, `${label}: deadline instances`).toBe(0);
  expect(proof.notificationRules, `${label}: notification rules`).toBe(0);
}

function expectStandingFixtureResidueZero(_residue: FixtureResidue, label: string) {
  const proof = loadStandingFixtureResidueProof();
  expect(proof.notifications, `${label}: notifications`).toBe(0);
  expect(proof.outboxEvents, `${label}: outbox events`).toBe(0);
  expect(proof.deadlineEvents, `${label}: deadline events`).toBe(0);
  expect(proof.deadlineInstances, `${label}: deadline instances`).toBe(0);
  expect(proof.notificationRules, `${label}: notification rules`).toBe(0);
}

function loadFixtureResidueProof(): FixtureResidue {
  const outboxNotificationFilter = fixtureOutboxNotificationFilter();

  return psqlJson<FixtureResidue>(`
    SELECT json_build_object(
      'notifications', (
        SELECT count(*)::int
        FROM notifications
        WHERE source_type = 'notification_rule'
          AND (
            source_id IN (
              SELECT notification_rule_id::text
              FROM notification_rules
              WHERE rule_code = '${escapeSql(SHADOW_FINAL_RULE_CODE)}'
            )
            OR EXISTS (
              SELECT 1 FROM outbox_events oe
              WHERE oe.idempotency_key LIKE 'E2E-final-order-deadline-${escapeLike(fixtureKey)}-%'
                AND notifications.idempotency_key LIKE 'notif-rule:' || oe.outbox_event_id::text || ':%'
            )
            OR (${outboxNotificationFilter})
          )
      ),
      'outboxEvents', (
        SELECT count(*)::int
        FROM outbox_events
        WHERE idempotency_key LIKE 'E2E-final-order-deadline-${escapeLike(fixtureKey)}-%'
      ),
      'deadlineEvents', (
        SELECT count(*)::int
        FROM deadline_events
        WHERE payload_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
      ),
      'deadlineInstances', (
        SELECT count(*)::int
        FROM deadline_instances
        WHERE metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
      ),
      'notificationRules', (
        SELECT count(*)::int
        FROM notification_rules
        WHERE rule_code = '${escapeSql(SHADOW_FINAL_RULE_CODE)}'
      )
    )::text;
  `);
}

function loadStandingFixtureResidueProof(): FixtureResidue {
  const outboxNotificationFilter = standingFixtureOutboxNotificationFilter();

  return psqlJson<FixtureResidue>(`
    SELECT json_build_object(
      'notifications', (
        SELECT count(*)::int
        FROM notifications
        WHERE source_type = 'notification_rule'
          AND source_id IN (
            SELECT notification_rule_id::text
            FROM notification_rules
            WHERE rule_code = '${escapeSql(REAL_019_RULE_CODE)}'
          )
          AND (
            EXISTS (
              SELECT 1 FROM outbox_events oe
              WHERE oe.idempotency_key LIKE '${escapeLike(fixtureKey)}-%'
                AND notifications.idempotency_key LIKE 'notif-rule:' || oe.outbox_event_id::text || ':%'
            )
            OR (${outboxNotificationFilter})
          )
      ),
      'outboxEvents', (
        SELECT count(*)::int
        FROM outbox_events
        WHERE idempotency_key LIKE '${escapeLike(fixtureKey)}-%'
      ),
      'deadlineEvents', (
        SELECT count(*)::int
        FROM deadline_events
        WHERE payload_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
      ),
      'deadlineInstances', (
        SELECT count(*)::int
        FROM deadline_instances
        WHERE metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
      ),
      'notificationRules', 0
    )::text;
  `);
}

function standingFixtureOutboxNotificationFilter(): string {
  if (standingFixtureOutboxIdsForRestore.length === 0) return 'false';
  return standingFixtureOutboxIdsForRestore
    .map((outboxId) => `idempotency_key LIKE 'notif-rule:${escapeSql(outboxId)}:%'`)
    .join(' OR ');
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
      ORDER BY created_at ASC, notification_id ASC
    ) n;
  `);
}

function loadManagerDeliveriesForOutbox(outboxId: string, finalRuleId: string): DeliveredNotification[] {
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
      WHERE user_id = ${managerUserId}
        AND source_type = 'notification_rule'
        AND source_id = '${escapeSql(finalRuleId)}'
        AND idempotency_key LIKE 'notif-rule:${escapeSql(outboxId)}:%'
      ORDER BY created_at ASC, notification_id ASC
    ) n;
  `);
}

function fixtureOutboxNotificationFilter(): string {
  if (fixtureOutboxIdsForRestore.length === 0) return 'false';
  return fixtureOutboxIdsForRestore
    .map((outboxId) => `idempotency_key LIKE 'notif-rule:${escapeSql(outboxId)}:%'`)
    .join(' OR ');
}

function deliveryKey(outboxId: string, ruleId: string, userId: number): string {
  return `notif-rule:${outboxId}:${ruleId}:${userId}`;
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
          2, 'E2E Test Final Order Deadline Stage Canary', true
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

function psql<T = string>(sql: string): T {
  const output = execFileSync(
    'docker',
    ['exec', '-i', postgresContainer, 'psql', '-U', 'erp_user', '-d', 'erpdb', '-qAtX', '-v', 'ON_ERROR_STOP=1', '-c', sql],
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

function escapeLike(value: string): string {
  return escapeSql(value).replace(/[%_]/g, (match) => `\\${match}`);
}
