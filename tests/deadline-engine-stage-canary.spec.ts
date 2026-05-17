import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const canaryEnabled = process.env.DEADLINE_ENGINE_STAGE_CANARY === 'true';
const frontendUrl = trimTrailingSlash(
  process.env.DEADLINE_ENGINE_STAGE_FRONTEND_URL ?? 'https://app-test.mebelkz.app',
);
const backendApiUrl = trimTrailingSlash(
  process.env.DEADLINE_ENGINE_STAGE_BACKEND_API_URL ?? 'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const orderId = readNumberEnv('DEADLINE_ENGINE_STAGE_ORDER_ID', 11166);
const orderName =
  process.env.DEADLINE_ENGINE_STAGE_ORDER_NAME ?? 'TEST-CODEX-STATUS3-DEBUG-20260516192743';
const vercelAutomationBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
const mutatingDeadlinePathPrefixes = [
  '/api/v1/deadlines',
  '/api/v1/deadline-settings',
  '/api/v1/deadline-policies',
];

test.describe('Deadline Engine stage canary', () => {
  test.skip(!canaryEnabled, 'Run with DEADLINE_ENGINE_STAGE_CANARY=true');
  test.setTimeout(180000);

  let userId: number | null = null;

  test.afterEach(() => {
    cleanupUser(userId);
  });

  test('reads order deadlines through backend and renders deployed order panel', async ({
    page,
    request,
  }) => {
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_test_deadlines_${runId}_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(24).toString('base64url');

    const order = loadOrderFixture(orderId);
    expect(order.orderName).toBe(orderName);
    expect(order.deadlineCount + order.eventCount).toBeGreaterThanOrEqual(1);

    userId = createSmokeUser(username, password);
    const token = await loginForApiToken(request, username, password);
    await expectRuntimeConfig(request);

    const summary = await getJson<OrderDeadlineSummary>(request, `/orders/${orderId}/deadline-summary`, token);
    expect(summary.orderId).toBe(orderId);

    const deadlines = await getJson<OrderDeadlinesResponse>(request, `/orders/${orderId}/deadlines`, token);
    const events = await getJson<DeadlineEventsResponse>(request, `/orders/${orderId}/deadline-events`, token);
    expect(deadlines.data.length).toBe(order.deadlineCount);
    expect(events.data.length).toBe(order.eventCount);
    expect(summary.counts).toEqual(countDeadlineStatuses(deadlines.data));
    expectSummaryDeadline(summary.finalDeadline, deadlines.data, 'order');
    expectSummaryDeadline(summary.currentStageDeadline, deadlines.data, 'order_stage');

    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const mutatingDeadlineRequests: string[] = [];
    const mutatingDeadlineGraphqlRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.context().setExtraHTTPHeaders(frontendRequestHeaders());

    await loginThroughUi(page, username, password);
    page.on('request', (request) => {
      if (isMutatingDeadlineRequest(request.method(), request.url())) {
        mutatingDeadlineRequests.push(`${request.method()} ${request.url()}`);
      }

      if (isDeadlineGraphqlMutation(request.method(), request.url(), request.postData())) {
        mutatingDeadlineGraphqlRequests.push(request.postData()?.slice(0, 500) ?? '');
      }
    });
    await page.goto(`${frontendUrl}/orders/show/${orderId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Дедлайны').first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/Активные:/).first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/Финальный:/).first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('Ошибка загрузки дедлайнов')).toHaveCount(0);
    expect(mutatingDeadlineRequests).toEqual([]);
    expect(mutatingDeadlineGraphqlRequests).toEqual([]);
    expect(loadOrderFixture(orderId)).toEqual(order);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors.filter((message) => !message.includes('ResizeObserver'))).toEqual([]);
  });
});

async function expectRuntimeConfig(request: APIRequestContext) {
  const response = await request.get(`${frontendUrl}/runtime-config.json`, {
    headers: frontendRequestHeaders(),
  });
  await expectOk(response);
  const runtimeConfig = await response.json();
  expect(runtimeConfig.features?.backendAuth).toBe(true);
  expect(runtimeConfig.features?.backendOrdersRead).toBe(true);
  expect(runtimeConfig.features?.backendDeadlines).toBe(true);
}

async function loginThroughUi(page: Page, username: string, password: string) {
  await page.goto(`${frontendUrl}/login`, { waitUntil: 'domcontentloaded' });
  const loginResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/v1/auth/login') &&
      response.request().method() === 'POST',
  );
  await page.locator('input[autocomplete="username"], input#username').fill(username);
  await page.locator('input[autocomplete="current-password"], input#password').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.ok()).toBe(true);
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30000 });
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

async function getJson<T>(
  request: APIRequestContext,
  path: string,
  token: string,
): Promise<T> {
  const response = await request.get(`${backendApiUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await expectOk(response);
  return response.json() as Promise<T>;
}

async function expectOk(response: APIResponse) {
  const body = response.ok() ? '' : await response.text();
  expect(response.ok(), body).toBe(true);
}

function frontendRequestHeaders(): Record<string, string> {
  if (!vercelAutomationBypassSecret) return {};
  return { 'x-vercel-protection-bypass': vercelAutomationBypassSecret };
}

function isMutatingDeadlineRequest(method: string, url: string): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) return false;

  const pathname = new URL(url).pathname;
  return (
    mutatingDeadlinePathPrefixes.some((prefix) => pathname.startsWith(prefix)) ||
    /^\/api\/v1\/orders\/\d+\/deadlines$/.test(pathname) ||
    /^\/api\/v1\/orders\/\d+\/deadline-events$/.test(pathname) ||
    /^\/api\/v1\/orders\/\d+\/deadline-summary$/.test(pathname)
  );
}

function isDeadlineGraphqlMutation(method: string, url: string, body: string | null): boolean {
  if (method.toUpperCase() !== 'POST' || !url.includes('/v1/graphql') || !body) return false;

  return normalizeGraphqlPayloads(body).some((payload) => {
    const query = typeof payload.query === 'string' ? payload.query : '';
    const operationName = typeof payload.operationName === 'string' ? payload.operationName : '';
    const searchText = `${operationName}\n${query}`;

    return (
      /\b(?:insert|update|delete)_deadline_\w*(?:\b|_)/i.test(searchText) ||
      /\bmutation\b[\s\S]*\bdeadline_\w*\b/i.test(query)
    );
  });
}

function normalizeGraphqlPayloads(body: string): Array<{ query?: unknown; operationName?: unknown }> {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) return parsed.filter((payload) => payload && typeof payload === 'object');
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    // Some clients send raw GraphQL documents instead of JSON envelopes.
  }

  return [{ query: body }];
}

function loadOrderFixture(orderId: number): OrderFixture {
  return psql<OrderFixture>(
    `
    SELECT json_build_object(
      'orderId', o.order_id,
      'orderName', o.order_name,
      'deadlineCount', (
        SELECT count(*)::int
        FROM deadline_instances d
        WHERE d.order_id = o.order_id
      ),
      'eventCount', (
        SELECT count(*)::int
        FROM deadline_events de
        JOIN deadline_instances d ON d.deadline_id = de.deadline_id
        WHERE d.order_id = o.order_id
      ),
      'deadlineFingerprint', (
        SELECT md5(coalesce(jsonb_agg(to_jsonb(deadline_row) ORDER BY deadline_row.deadline_id), '[]'::jsonb)::text)
        FROM (
          SELECT
            d.deadline_id::text,
            d.policy_id::text,
            d.policy_version_id::text,
            d.entity_type,
            d.entity_id,
            d.parent_entity_type,
            d.parent_entity_id,
            d.order_id,
            d.order_workshop_id,
            d.client_id,
            d.responsible_user_id,
            d.deadline_at,
            d.status,
            d.source,
            d.is_manually_overridden,
            d.policy_snapshot_json,
            d.metadata_json,
            d.started_at,
            d.completed_at,
            d.expired_at,
            d.cancelled_at,
            d.created_by_user_id,
            d.updated_by_user_id,
            d.created_at,
            d.updated_at
          FROM deadline_instances d
          WHERE d.order_id = o.order_id
        ) deadline_row
      ),
      'eventFingerprint', (
        SELECT md5(coalesce(jsonb_agg(to_jsonb(event_row) ORDER BY event_row.event_at, event_row.deadline_event_id), '[]'::jsonb)::text)
        FROM (
          SELECT
            de.deadline_event_id::text,
            de.deadline_id::text,
            de.event_type,
            de.severity,
            de.entity_type,
            de.entity_id,
            de.order_id,
            de.order_workshop_id,
            de.client_id,
            de.deadline_at,
            de.event_at,
            de.delay_minutes,
            de.payload_json,
            de.created_at
          FROM deadline_events de
          JOIN deadline_instances d ON d.deadline_id = de.deadline_id
          WHERE d.order_id = o.order_id
        ) event_row
      ),
      'pauseFingerprint', (
        SELECT md5(coalesce(jsonb_agg(to_jsonb(pause_row) ORDER BY pause_row.paused_at, pause_row.deadline_pause_id), '[]'::jsonb)::text)
        FROM (
          SELECT
            dp.deadline_pause_id::text,
            dp.deadline_id::text,
            dp.pause_reason,
            dp.pause_mode,
            dp.paused_at,
            dp.resumed_at,
            dp.paused_by_user_id,
            dp.resumed_by_user_id,
            dp.notes
          FROM deadline_pauses dp
          JOIN deadline_instances d ON d.deadline_id = dp.deadline_id
          WHERE d.order_id = o.order_id
        ) pause_row
      )
    )::text
    FROM orders o
    WHERE o.order_id = ${orderId}
      AND o.delete_flag = false;
    `,
    { json: true },
  );
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
          1,
          'E2E Test Deadline Engine Stage Canary',
          true
        )
        RETURNING user_id
      )
      SELECT user_id FROM inserted;
    `),
  );
}

function cleanupUser(userId: number | null) {
  if (!userId) return;
  psql(`
    DELETE FROM refresh_tokens WHERE user_id = ${userId};
    DELETE FROM auth_sessions WHERE user_id = ${userId};
    UPDATE users
    SET is_active = false,
        edited_by = NULL
    WHERE user_id = ${userId};
  `);
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
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

interface OrderFixture {
  orderId: number;
  orderName: string;
  deadlineCount: number;
  eventCount: number;
  deadlineFingerprint: string;
  eventFingerprint: string;
  pauseFingerprint: string;
}

interface OrderDeadlineSummary {
  orderId: number;
  finalDeadline: DeadlineSummaryItem | null;
  currentStageDeadline: DeadlineSummaryItem | null;
  counts: {
    active: number;
    expired: number;
    completedLate: number;
    completedOnTime: number;
  };
}

interface OrderDeadlinesResponse {
  data: DeadlineItem[];
}

interface DeadlineEventsResponse {
  data: unknown[];
}

interface DeadlineItem {
  deadlineId: string;
  entityType: string;
  status: string;
}

interface DeadlineSummaryItem {
  deadlineId: string;
  status: string;
}

function countDeadlineStatuses(deadlines: DeadlineItem[]) {
  return {
    active: deadlines.filter((deadline) => deadline.status === 'active').length,
    expired: deadlines.filter((deadline) => deadline.status === 'expired').length,
    completedLate: deadlines.filter((deadline) => deadline.status === 'completed_late').length,
    completedOnTime: deadlines.filter((deadline) => deadline.status === 'completed_on_time').length,
  };
}

function expectSummaryDeadline(
  summaryDeadline: DeadlineSummaryItem | null,
  deadlines: DeadlineItem[],
  entityType: 'order' | 'order_stage',
) {
  if (!summaryDeadline) {
    expect(deadlines.some((deadline) => deadline.entityType === entityType)).toBe(false);
    return;
  }

  const matchingDeadline = deadlines.find(
    (deadline) =>
      deadline.deadlineId === summaryDeadline.deadlineId && deadline.entityType === entityType,
  );
  expect(matchingDeadline).toBeDefined();
  expect(summaryDeadline.status).toBe(matchingDeadline?.status);
}
