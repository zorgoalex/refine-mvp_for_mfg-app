import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const canaryEnabled = process.env.DEADLINE_CREATE_OVERRIDE_STAGE_CANARY === 'true';
const backendApiUrl = trimTrailingSlash(
  process.env.DEADLINE_CREATE_OVERRIDE_BACKEND_API_URL ??
    process.env.DEADLINE_ENGINE_STAGE_BACKEND_API_URL ??
    'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.DEADLINE_CREATE_OVERRIDE_POSTGRES_CONTAINER ??
  process.env.DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER ??
  'erp_test-postgresdb-1';
const fixtureKey =
  process.env.DEADLINE_CREATE_OVERRIDE_FIXTURE_KEY ??
  'deadline-create-override-canary-2026-05-23';
const orderId = readNumberEnv('DEADLINE_CREATE_OVERRIDE_ORDER_ID', 11192);
const createRequestId =
  process.env.DEADLINE_CREATE_OVERRIDE_CREATE_REQUEST_ID ??
  'req-deadline-create-override-canary-create-2026-05-23';
const overrideRequestId =
  process.env.DEADLINE_CREATE_OVERRIDE_OVERRIDE_REQUEST_ID ??
  'req-deadline-create-override-canary-override-2026-05-23';
const createDeadlineAt =
  process.env.DEADLINE_CREATE_OVERRIDE_CREATE_DEADLINE_AT ?? '2026-06-01T10:00:00.000Z';
const overrideDeadlineAt =
  process.env.DEADLINE_CREATE_OVERRIDE_OVERRIDE_DEADLINE_AT ?? '2026-06-02T10:00:00.000Z';

test.describe('deadline engine create override stage canary', () => {
  test.skip(
    !canaryEnabled,
    'Set DEADLINE_CREATE_OVERRIDE_STAGE_CANARY=true to enable the create/override stage canary.',
  );
  test.setTimeout(240000);

  let userId: number | null = null;
  let createdDeadlineId: string | null = null;
  let replacementDeadlineId: string | null = null;

  test.beforeAll(() => {
    requireCanaryEnv();
    assertNonProductionLikeTarget();
    restoreFixtureRows();
    expectResidueEmpty(loadResidueCounts());
    expectOrderExists(orderId);
  });

  test.afterAll(() => {
    let restoreError: unknown;
    try {
      if (process.env.DEADLINE_CREATE_OVERRIDE_RESTORE === 'true') {
        restoreFixtureRows([createdDeadlineId, replacementDeadlineId].filter(isString));
        expectResidueEmpty(loadResidueCounts([createdDeadlineId, replacementDeadlineId].filter(isString)));
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

  test('creates and overrides a deadline idempotently through deployed backend', async ({
    request,
  }) => {
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_test_deadline_create_override_${runId}_${crypto
      .randomBytes(4)
      .toString('hex')}`;
    const password = crypto.randomBytes(24).toString('base64url');

    userId = createSmokeUser(username, password);
    const token = await loginForApiToken(request, username, password);
    await expectDeadlineReadAvailable(request, token);

    const createPayload = {
      entityType: 'order',
      entityId: String(orderId),
      orderId,
      deadlineAt: createDeadlineAt,
      source: 'manual',
      metadata: {
        fixtureKey,
        fixtureRole: 'create-override-canary',
        requestId: createRequestId,
      },
    };

    const createResponse = await request.post(`${backendApiUrl}/deadlines`, {
      data: createPayload,
      headers: {
        Authorization: `Bearer ${token}`,
        'x-request-id': createRequestId,
      },
    });
    await expectOk(createResponse);
    const created = await expectDeadlineResponse(createResponse);
    createdDeadlineId = created.deadline.deadlineId;
    expect(created.deadline.orderId).toBe(orderId);
    expect(created.deadline.metadata?.fixtureKey).toBe(fixtureKey);

    const repeatCreateResponse = await request.post(`${backendApiUrl}/deadlines`, {
      data: createPayload,
      headers: {
        Authorization: `Bearer ${token}`,
        'x-request-id': createRequestId,
      },
    });
    await expectOk(repeatCreateResponse);
    const repeatedCreate = await expectDeadlineResponse(repeatCreateResponse);
    expect(repeatedCreate.deadline.deadlineId).toBe(createdDeadlineId);

    const createEvidence = loadCreateEvidence(createdDeadlineId);
    expect(createEvidence).toEqual({
      status: 'active',
      deadlineAt: createDeadlineAt,
      createEvents: 1,
      auditRows: 1,
      outboxRows: 1,
    });

    const overridePayload = {
      deadlineAt: overrideDeadlineAt,
      reason: 'Deadline create/override stage canary override',
      metadata: {
        fixtureKey,
        fixtureRole: 'create-override-canary-override',
        requestId: overrideRequestId,
      },
    };

    const overrideResponse = await request.post(
      `${backendApiUrl}/deadlines/${createdDeadlineId}/override`,
      {
        data: overridePayload,
        headers: {
          Authorization: `Bearer ${token}`,
          'x-request-id': overrideRequestId,
        },
      },
    );
    await expectOk(overrideResponse);
    const overridden = await expectDeadlineResponse(overrideResponse);
    replacementDeadlineId = overridden.deadline.deadlineId;
    expect(replacementDeadlineId).not.toBe(createdDeadlineId);
    expect(overridden.deadline.isManuallyOverridden).toBe(true);
    expect(overridden.deadline.metadata?.fixtureKey).toBe(fixtureKey);

    const repeatOverrideResponse = await request.post(
      `${backendApiUrl}/deadlines/${createdDeadlineId}/override`,
      {
        data: overridePayload,
        headers: {
          Authorization: `Bearer ${token}`,
          'x-request-id': overrideRequestId,
        },
      },
    );
    await expectOk(repeatOverrideResponse);
    const repeatedOverride = await expectDeadlineResponse(repeatOverrideResponse);
    expect(repeatedOverride.deadline.deadlineId).toBe(replacementDeadlineId);

    const overrideEvidence = loadOverrideEvidence(createdDeadlineId, replacementDeadlineId);
    expect(overrideEvidence).toEqual({
      originalStatus: 'superseded',
      replacementStatus: 'active',
      replacementDeadlineAt: overrideDeadlineAt,
      replacementIsManuallyOverridden: true,
      updatedEvents: 1,
      auditRows: 1,
      outboxRows: 1,
    });

    console.log(
      JSON.stringify({
        fixtureKey,
        orderId,
        createdDeadlineId,
        replacementDeadlineId,
        createRequestId,
        overrideRequestId,
        createEvidence,
        overrideEvidence,
      }),
    );
  });
});

function requireCanaryEnv() {
  if (process.env.DEADLINE_CREATE_OVERRIDE_RESTORE !== 'true') {
    throw new Error('DEADLINE_CREATE_OVERRIDE_RESTORE=true is required');
  }
  if (!fixtureKey.trim()) {
    throw new Error('fixtureKey must not be empty');
  }
  if (!orderId) {
    throw new Error('DEADLINE_CREATE_OVERRIDE_ORDER_ID must be a positive integer');
  }
}

function assertNonProductionLikeTarget() {
  const { hostname, pathname } = new URL(backendApiUrl);
  const safeHost =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.endsWith('.local') ||
    hostname.includes('test') ||
    hostname.includes('stage') ||
    hostname.includes('staging') ||
    hostname.includes('dev');

  if (!safeHost || !pathname.startsWith('/api/v1')) {
    throw new Error(`Refusing to run create/override canary against production-like target: ${backendApiUrl}`);
  }
}

async function expectDeadlineReadAvailable(request: APIRequestContext, token: string) {
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

async function expectDeadlineResponse(response: APIResponse): Promise<DeadlineResponse> {
  const body = (await response.json()) as DeadlineResponse;
  expect(typeof body.deadline.deadlineId).toBe('string');
  expect(typeof body.deadline.deadlineAt).toBe('string');
  return body;
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
          'E2E Test Deadline Create Override Stage Canary',
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

function expectOrderExists(id: number) {
  const exists = psql(`
    SELECT EXISTS (
      SELECT 1
      FROM orders
      WHERE order_id = ${id}
    )::int;
  `);
  expect(Number(exists)).toBe(1);
}

function loadCreateEvidence(deadlineId: string): CreateEvidence {
  return psql<CreateEvidence>(
    `
    WITH fixture_deadline AS (
      SELECT deadline_id, status, deadline_at
      FROM deadline_instances
      WHERE deadline_id = '${escapeSql(deadlineId)}'::uuid
        AND order_id = ${orderId}
        AND metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
        AND idempotency_key = 'deadline-create:${escapeSql(createRequestId)}'
    ),
    fixture_events AS (
      SELECT deadline_event_id
      FROM deadline_events
      WHERE deadline_id IN (SELECT deadline_id FROM fixture_deadline)
        AND event_type = 'DEADLINE_CREATED'
        AND payload_json->>'requestId' = '${escapeSql(createRequestId)}'
    )
    SELECT json_build_object(
      'status', (SELECT status FROM fixture_deadline),
      'deadlineAt', (
        SELECT to_char(deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        FROM fixture_deadline
      ),
      'createEvents', (SELECT count(*)::int FROM fixture_events),
      'auditRows', (
        SELECT count(*)::int
        FROM audit_log
        WHERE entity_type = 'deadline'
          AND entity_id = '${escapeSql(deadlineId)}'
          AND event = 'deadlines.deadline_created'
          AND request_id = '${escapeSql(createRequestId)}'
          AND source = 'backend-deadline-command'
      ),
      'outboxRows', (
        SELECT count(*)::int
        FROM outbox_events
        WHERE aggregate_type = 'deadline'
          AND aggregate_id = '${escapeSql(deadlineId)}'
          AND event_type = 'deadline.event.created'
          AND payload_json->>'requestId' = '${escapeSql(createRequestId)}'
          AND (payload_json->>'deadlineEventId')::uuid IN (SELECT deadline_event_id FROM fixture_events)
      )
    )::text;
    `,
    { json: true },
  );
}

function loadOverrideEvidence(originalDeadlineId: string, replacementId: string): OverrideEvidence {
  return psql<OverrideEvidence>(
    `
    WITH original_deadline AS (
      SELECT deadline_id, status
      FROM deadline_instances
      WHERE deadline_id = '${escapeSql(originalDeadlineId)}'::uuid
        AND order_id = ${orderId}
        AND metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
    ),
    replacement_deadline AS (
      SELECT deadline_id, status, deadline_at, is_manually_overridden
      FROM deadline_instances
      WHERE deadline_id = '${escapeSql(replacementId)}'::uuid
        AND order_id = ${orderId}
        AND metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
        AND metadata_json->>'overriddenDeadlineId' = '${escapeSql(originalDeadlineId)}'
        AND idempotency_key = 'deadline-override:${escapeSql(originalDeadlineId)}:${escapeSql(overrideRequestId)}'
    ),
    fixture_events AS (
      SELECT deadline_event_id
      FROM deadline_events
      WHERE deadline_id IN (SELECT deadline_id FROM replacement_deadline)
        AND event_type = 'DEADLINE_UPDATED'
        AND payload_json->>'requestId' = '${escapeSql(overrideRequestId)}'
        AND payload_json->>'previousDeadlineId' = '${escapeSql(originalDeadlineId)}'
    )
    SELECT json_build_object(
      'originalStatus', (SELECT status FROM original_deadline),
      'replacementStatus', (SELECT status FROM replacement_deadline),
      'replacementDeadlineAt', (
        SELECT to_char(deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        FROM replacement_deadline
      ),
      'replacementIsManuallyOverridden', (
        SELECT is_manually_overridden
        FROM replacement_deadline
      ),
      'updatedEvents', (SELECT count(*)::int FROM fixture_events),
      'auditRows', (
        SELECT count(*)::int
        FROM audit_log
        WHERE entity_type = 'deadline'
          AND entity_id = '${escapeSql(replacementId)}'
          AND event = 'deadlines.deadline_updated'
          AND request_id = '${escapeSql(overrideRequestId)}'
          AND source = 'backend-deadline-command'
      ),
      'outboxRows', (
        SELECT count(*)::int
        FROM outbox_events
        WHERE aggregate_type = 'deadline'
          AND aggregate_id = '${escapeSql(replacementId)}'
          AND event_type = 'deadline.event.created'
          AND payload_json->>'requestId' = '${escapeSql(overrideRequestId)}'
          AND (payload_json->>'deadlineEventId')::uuid IN (SELECT deadline_event_id FROM fixture_events)
      )
    )::text;
    `,
    { json: true },
  );
}

function restoreFixtureRows(knownDeadlineIds: string[] = []) {
  psql(`
    WITH scoped_deadline_ids AS (
      SELECT deadline_id::text
      FROM deadline_instances
      WHERE order_id = ${orderId}
        AND (
          metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
          OR idempotency_key = 'deadline-create:${escapeSql(createRequestId)}'
          OR idempotency_key LIKE 'deadline-override:%:${escapeSql(overrideRequestId)}'
        )
      UNION
      ${knownDeadlineIdSql(knownDeadlineIds)}
    ),
    scoped_events AS (
      SELECT deadline_event_id::text
      FROM deadline_events
      WHERE deadline_id::text IN (SELECT deadline_id FROM scoped_deadline_ids)
         OR (
          order_id = ${orderId}
          AND payload_json->>'requestId' IN (
            '${escapeSql(createRequestId)}',
            '${escapeSql(overrideRequestId)}'
          )
        )
    ),
    deleted_action_executions AS (
      DELETE FROM deadline_action_executions
      WHERE deadline_event_id::text IN (SELECT deadline_event_id FROM scoped_events)
      RETURNING 1
    ),
    deleted_notifications AS (
      DELETE FROM notifications
      WHERE source_id IN (SELECT deadline_id FROM scoped_deadlines)
         OR source_id IN (SELECT deadline_event_id FROM scoped_events)
         OR entity_id IN (SELECT deadline_id FROM scoped_deadlines)
      RETURNING 1
    ),
    deleted_outbox AS (
      DELETE FROM outbox_events
      WHERE aggregate_type = 'deadline'
        AND (
          aggregate_id IN (SELECT deadline_id FROM scoped_deadlines)
          OR payload_json->>'deadlineEventId' IN (SELECT deadline_event_id FROM scoped_events)
          OR payload_json->>'requestId' IN (
            '${escapeSql(createRequestId)}',
            '${escapeSql(overrideRequestId)}'
          )
        )
      RETURNING 1
    ),
    deleted_audit AS (
      DELETE FROM audit_log
      WHERE entity_type = 'deadline'
        AND (
          entity_id IN (SELECT deadline_id FROM scoped_deadlines)
          OR request_id IN (
            '${escapeSql(createRequestId)}',
            '${escapeSql(overrideRequestId)}'
          )
          OR metadata_json->>'deadlineEventId' IN (SELECT deadline_event_id FROM scoped_events)
        )
      RETURNING 1
    ),
    deleted_events AS (
      DELETE FROM deadline_events
      WHERE deadline_event_id::text IN (SELECT deadline_event_id FROM scoped_events)
      RETURNING 1
    )
    DELETE FROM deadline_instances
    WHERE deadline_id::text IN (SELECT deadline_id FROM scoped_deadlines);
  `);
}

function loadResidueCounts(knownDeadlineIds: string[] = []): ResidueCounts {
  return psql<ResidueCounts>(
    `
    WITH scoped_deadlines AS (
      SELECT deadline_id::text
      FROM deadline_instances
      WHERE order_id = ${orderId}
        AND (
          metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
          OR idempotency_key = 'deadline-create:${escapeSql(createRequestId)}'
          OR idempotency_key LIKE 'deadline-override:%:${escapeSql(overrideRequestId)}'
        )
      UNION
      ${knownDeadlineIdSql(knownDeadlineIds)}
    ),
    scoped_events AS (
      SELECT deadline_event_id::text
      FROM deadline_events
      WHERE deadline_id::text IN (SELECT deadline_id FROM scoped_deadlines)
         OR (
          order_id = ${orderId}
          AND payload_json->>'requestId' IN (
            '${escapeSql(createRequestId)}',
            '${escapeSql(overrideRequestId)}'
          )
        )
    )
    SELECT json_build_object(
      'deadlineActionExecutions', (
        SELECT count(*)::int
        FROM deadline_action_executions
        WHERE deadline_event_id::text IN (SELECT deadline_event_id FROM scoped_events)
      ),
      'outboxEvents', (
        SELECT count(*)::int
        FROM outbox_events
        WHERE aggregate_type = 'deadline'
          AND (
            aggregate_id IN (SELECT deadline_id FROM scoped_deadline_ids)
            OR payload_json->>'deadlineEventId' IN (SELECT deadline_event_id FROM scoped_events)
            OR payload_json->>'requestId' IN (
              '${escapeSql(createRequestId)}',
              '${escapeSql(overrideRequestId)}'
            )
          )
      ),
      'auditLog', (
        SELECT count(*)::int
        FROM audit_log
        WHERE entity_type = 'deadline'
          AND (
            entity_id IN (SELECT deadline_id FROM scoped_deadline_ids)
            OR request_id IN (
              '${escapeSql(createRequestId)}',
              '${escapeSql(overrideRequestId)}'
            )
            OR metadata_json->>'deadlineEventId' IN (SELECT deadline_event_id FROM scoped_events)
          )
      ),
      'notifications', (
        SELECT count(*)::int
        FROM notifications
        WHERE source_id IN (SELECT deadline_id FROM scoped_deadline_ids)
           OR source_id IN (SELECT deadline_event_id FROM scoped_events)
           OR entity_id IN (SELECT deadline_id FROM scoped_deadline_ids)
      ),
      'deadlineEvents', (SELECT count(*)::int FROM scoped_events),
      'deadlineInstances', (
        SELECT count(*)::int
        FROM deadline_instances
        WHERE deadline_id::text IN (SELECT deadline_id FROM scoped_deadline_ids)
      )
    )::text;
    `,
    { json: true },
  );
}

function expectResidueEmpty(counts: ResidueCounts) {
  expect(counts.deadlineActionExecutions).toBe(0);
  expect(counts.outboxEvents).toBe(0);
  expect(counts.auditLog).toBe(0);
  expect(counts.notifications).toBe(0);
  expect(counts.deadlineEvents).toBe(0);
  expect(counts.deadlineInstances).toBe(0);
}

function knownDeadlineIdSql(ids: string[]): string {
  if (ids.length === 0) {
    return 'SELECT NULL::text AS deadline_id WHERE false';
  }
  return ids.map((id) => `SELECT '${escapeSql(id)}'::text AS deadline_id`).join('\n      UNION\n      ');
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

function readNumberEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function isString(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

interface DeadlineResponse {
  deadline: {
    deadlineId: string;
    orderId: number | null;
    deadlineAt: string;
    status: string;
    source: string;
    isManuallyOverridden: boolean;
    metadata: Record<string, unknown> | null;
  };
}

interface ResidueCounts {
  deadlineActionExecutions: number;
  outboxEvents: number;
  auditLog: number;
  notifications: number;
  deadlineEvents: number;
  deadlineInstances: number;
}

interface CreateEvidence {
  status: 'active';
  deadlineAt: string;
  createEvents: number;
  auditRows: number;
  outboxRows: number;
}

interface OverrideEvidence {
  originalStatus: 'superseded';
  replacementStatus: 'active';
  replacementDeadlineAt: string;
  replacementIsManuallyOverridden: boolean;
  updatedEvents: number;
  auditRows: number;
  outboxRows: number;
}
