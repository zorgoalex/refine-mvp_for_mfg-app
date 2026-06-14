import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

/**
 * Track A Task 7 (optional follow-up) — Notification Rules Admin UI stage canary.
 *
 * Opt-in, `backend-test`/stage only. Asserts (1) the `/configuration`
 * "Уведомления" tab renders the rules table for a user with
 * `notifications.view_rules`, and (2) a full create → edit → delete round-trip
 * over an `E2E-`-prefixed rule succeeds through the SAME backend API the UI
 * calls (`/api/v1/notification-rules`), with restore-to-zero proven in the DB.
 *
 * The CRUD round-trip is driven via the backend API (the contract the screen
 * depends on) rather than fragile modal-selector scripting; the UI assertion
 * proves the tab mounts and lists rules. Deeper modal-interaction coverage is
 * a follow-up. Engine must be enabled on the target (coordinate with the
 * Track B operator window). No flags are flipped here.
 *
 * Operator must provide admin credentials (with `notifications.manage_rules`)
 * via env — this spec never fabricates permissions.
 */

const CANARY_ENABLED = process.env.NOTIFICATION_RULES_UI_STAGE_CANARY === 'true';
const targetEnv = process.env.NOTIFICATION_RULES_UI_TARGET_ENV?.trim() ?? '';
const restoreEnabled = process.env.NOTIFICATION_RULES_UI_FIXTURE_RESTORE === 'true';
const frontendUrl = trimTrailingSlash(process.env.NOTIFICATION_RULES_UI_FRONTEND_URL ?? '');
const backendApiUrl = trimTrailingSlash(process.env.NOTIFICATION_RULES_UI_BACKEND_API_URL ?? '');
const adminUsername = process.env.NOTIFICATION_RULES_UI_ADMIN_USERNAME?.trim() ?? '';
const adminPassword = process.env.NOTIFICATION_RULES_UI_ADMIN_PASSWORD ?? '';
const vercelBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ?? '';
const postgresContainer = process.env.NOTIFICATION_RULES_UI_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const eventTypeForRule = process.env.NOTIFICATION_RULES_UI_EVENT_TYPE?.trim() ?? 'order.production_status_changed';

const ruleCode = `E2E-notif-ui-canary-${crypto.randomBytes(5).toString('hex')}`;

const missingPrerequisites = [
  targetEnv ? null : 'NOTIFICATION_RULES_UI_TARGET_ENV=backend-test',
  targetEnv && targetEnv !== 'backend-test' ? 'NOTIFICATION_RULES_UI_TARGET_ENV=backend-test' : null,
  restoreEnabled ? null : 'NOTIFICATION_RULES_UI_FIXTURE_RESTORE=true',
  frontendUrl ? null : 'NOTIFICATION_RULES_UI_FRONTEND_URL',
  backendApiUrl ? null : 'NOTIFICATION_RULES_UI_BACKEND_API_URL',
  adminUsername ? null : 'NOTIFICATION_RULES_UI_ADMIN_USERNAME',
  adminPassword ? null : 'NOTIFICATION_RULES_UI_ADMIN_PASSWORD',
  dockerContainerExists(postgresContainer) ? null : `docker container ${postgresContainer}`,
].filter((value): value is string => Boolean(value));

test.describe('notification rules admin UI stage canary', () => {
  test.skip(!CANARY_ENABLED, 'Set NOTIFICATION_RULES_UI_STAGE_CANARY=true to enable the admin UI stage canary.');
  test.skip(
    CANARY_ENABLED && missingPrerequisites.length > 0,
    `Missing notification rules UI stage canary prerequisites: ${missingPrerequisites.join(', ')}`,
  );
  test.setTimeout(300000);

  test.beforeAll(() => {
    assertTargetEnv(targetEnv);
    assertBackendApiUrl(backendApiUrl);
    assertFrontendUrl(frontendUrl);
    // No prior fixture rule should exist.
    expect(fixtureRuleResidue(), 'preflight: no leftover E2E rule').toBe(0);
  });

  test.afterAll(() => {
    if (restoreEnabled) {
      deleteFixtureRule();
      expect(fixtureRuleResidue(), 'afterAll restore-to-zero').toBe(0);
    }
  });

  test('renders the Уведомления tab and round-trips a rule via the backend contract', async ({
    page,
    request,
  }) => {
    // 1) UI render: the configuration tab mounts and lists rules.
    if (vercelBypass) {
      await page.context().setExtraHTTPHeaders({ 'x-vercel-protection-bypass': vercelBypass });
    }
    await loginThroughUi(page, adminUsername, adminPassword);
    await page.goto(`${frontendUrl}/configuration`, { waitUntil: 'networkidle' });
    const tab = page.getByRole('tab', { name: /Уведомления/ });
    await expect(tab, 'Уведомления configuration tab must render').toBeVisible();
    await tab.click();
    // The rules table (or a friendly engine-disabled / empty notice) must render —
    // never a React error boundary.
    await expect(
      page.getByRole('table').or(page.getByRole('alert')).first(),
      'rules table or a friendly notice must render',
    ).toBeVisible();

    // 2) API round-trip over the contract the screen calls.
    const token = await loginForApiToken(request, adminUsername, adminPassword);

    const created = await createRule(request, token);
    expect(created.ruleCode).toBe(ruleCode);
    expect(created.isEnabled).toBe(true);
    expect(fixtureRuleResidue(), 'rule must exist after create').toBe(1);

    const current = await getRuleByCode(request, token, ruleCode);
    const edited = await patchRule(request, token, current.notificationRuleId, current.updatedAt);
    expect(edited.priority).toBe(150);
    expect(edited.isEnabled).toBe(false);

    await deleteRuleViaApi(request, token, created.notificationRuleId);
    expect(fixtureRuleResidue(), 'rule must be gone after delete (restore-to-zero)').toBe(0);
  });
});

interface RuleDto {
  notificationRuleId: string;
  ruleCode: string;
  isEnabled: boolean;
  priority: number;
  updatedAt: string;
}

async function createRule(request: APIRequestContext, token: string): Promise<RuleDto> {
  const response = await request.post(`${backendApiUrl}/notification-rules`, {
    headers: authHeaders(token),
    data: {
      ruleCode,
      eventType: eventTypeForRule,
      level: 'info',
      priority: 100,
      isEnabled: true,
      conditions: {},
      recipients: { resolvers: ['order_manager'] },
      titleTemplate: 'E2E {orderId}',
      messageTemplate: 'E2E {orderId} {eventType}',
    },
  });
  if (response.status() === 503) throwIfEngineDisabled(await parseResponseBody(response));
  await expectOk(response);
  return (await response.json()) as RuleDto;
}

async function getRuleByCode(request: APIRequestContext, token: string, expectedRuleCode: string): Promise<RuleDto> {
  const response = await request.get(`${backendApiUrl}/notification-rules`, {
    headers: authHeaders(token),
  });
  await expectOk(response);
  const rules = (await response.json()) as RuleDto[];
  const rule = rules.find((item) => item.ruleCode === expectedRuleCode);
  expect(rule, `rule ${expectedRuleCode} must be returned by /notification-rules`).toBeTruthy();
  return rule as RuleDto;
}

async function patchRule(
  request: APIRequestContext,
  token: string,
  ruleId: string,
  expectedUpdatedAt: string,
): Promise<RuleDto> {
  const response = await request.patch(`${backendApiUrl}/notification-rules/${encodeURIComponent(ruleId)}`, {
    headers: authHeaders(token),
    data: { priority: 150, isEnabled: false, reason: 'E2E canary tuning', expectedUpdatedAt },
  });
  await expectOk(response);
  return (await response.json()) as RuleDto;
}

async function deleteRuleViaApi(request: APIRequestContext, token: string, ruleId: string): Promise<void> {
  const response = await request.delete(`${backendApiUrl}/notification-rules/${encodeURIComponent(ruleId)}`, {
    headers: authHeaders(token),
  });
  await expectOk(response);
}

function authHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (vercelBypass) headers['x-vercel-protection-bypass'] = vercelBypass;
  return headers;
}

async function loginForApiToken(request: APIRequestContext, username: string, password: string): Promise<string> {
  const response = await request.post(`${backendApiUrl}/auth/login`, {
    data: { username, password },
    headers: vercelBypass ? { 'x-vercel-protection-bypass': vercelBypass } : undefined,
  });
  await expectOk(response);
  const body = await response.json();
  expect(typeof body.accessToken).toBe('string');
  return body.accessToken;
}

async function loginThroughUi(page: Page, username: string, password: string): Promise<void> {
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

function throwIfEngineDisabled(body: unknown): void {
  if (errorCode(body) === 'NOTIFICATION_ENGINE_DISABLED') {
    throw new Error(
      'Notification engine is disabled on the target (NOTIFICATION_ENGINE_DISABLED). ' +
        'Enable the engine on backend-test before running this UI canary.',
    );
  }
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

function assertTargetEnv(env: string) {
  if (env === 'backend-test') return;
  throw new Error(
    `Refusing to run notification rules UI stage canary against target env "${env}". ` +
      'Only NOTIFICATION_RULES_UI_TARGET_ENV=backend-test is permitted.',
  );
}

function assertBackendApiUrl(url: string) {
  const host = new URL(url).hostname.toLowerCase();
  if (/prod|production|\blive\b/.test(host)) {
    throw new Error(`Refusing to target a prod/live-looking backend host: ${host}`);
  }
}

function assertFrontendUrl(url: string) {
  const host = new URL(url).hostname.toLowerCase();
  if (/prod|production|\blive\b/.test(host)) {
    throw new Error(`Refusing to target a prod/live-looking frontend host: ${host}`);
  }
}

function fixtureRuleResidue(): number {
  return Number(
    psql(`SELECT count(*)::int FROM notification_rules WHERE rule_code = '${escapeSql(ruleCode)}';`),
  );
}

function deleteFixtureRule(): void {
  psql(`DELETE FROM notification_rules WHERE rule_code = '${escapeSql(ruleCode)}';`);
}

function psql<T = string>(sql: string): T {
  const output = execFileSync(
    'docker',
    ['exec', '-i', postgresContainer, 'psql', '-U', 'erp_user', '-d', 'erpdb', '-qAtX', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
  return output as T;
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
