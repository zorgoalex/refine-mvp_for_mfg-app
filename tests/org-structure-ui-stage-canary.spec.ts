import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const CANARY_ENABLED = process.env.ORG_STRUCTURE_UI_STAGE_CANARY === 'true';
const targetEnv = process.env.ORG_STRUCTURE_UI_TARGET_ENV?.trim() ?? '';
const restoreEnabled = process.env.ORG_STRUCTURE_UI_FIXTURE_RESTORE === 'true';
const frontendUrl = trimTrailingSlash(process.env.ORG_STRUCTURE_UI_FRONTEND_URL ?? '');
const backendApiUrl = trimTrailingSlash(process.env.ORG_STRUCTURE_UI_BACKEND_API_URL ?? '');
const adminUsername = process.env.ORG_STRUCTURE_UI_ADMIN_USERNAME?.trim() ?? '';
const adminPassword = process.env.ORG_STRUCTURE_UI_ADMIN_PASSWORD ?? '';
const vercelBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ?? '';
const postgresContainer = process.env.ORG_STRUCTURE_UI_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const fixtureName = `E2E-Тест орг структура ${crypto.randomBytes(5).toString('hex')}`;

const missingPrerequisites = [
  targetEnv ? null : 'ORG_STRUCTURE_UI_TARGET_ENV=backend-test',
  targetEnv && targetEnv !== 'backend-test' ? 'ORG_STRUCTURE_UI_TARGET_ENV=backend-test' : null,
  restoreEnabled ? null : 'ORG_STRUCTURE_UI_FIXTURE_RESTORE=true',
  frontendUrl ? null : 'ORG_STRUCTURE_UI_FRONTEND_URL',
  backendApiUrl ? null : 'ORG_STRUCTURE_UI_BACKEND_API_URL',
  adminUsername ? null : 'ORG_STRUCTURE_UI_ADMIN_USERNAME',
  adminPassword ? null : 'ORG_STRUCTURE_UI_ADMIN_PASSWORD',
  dockerContainerExists(postgresContainer) ? null : `docker container ${postgresContainer}`,
].filter((value): value is string => Boolean(value));

test.describe('org structure UI stage canary', () => {
  test.skip(!CANARY_ENABLED, 'Set ORG_STRUCTURE_UI_STAGE_CANARY=true to enable the canary.');
  test.skip(
    CANARY_ENABLED && missingPrerequisites.length > 0,
    `Missing org structure UI stage canary prerequisites: ${missingPrerequisites.join(', ')}`,
  );
  test.setTimeout(300000);

  let createdDirectionId: number | null = null;
  let accessToken: string | null = null;

  test.beforeAll(() => {
    assertTargetEnv(targetEnv);
    assertNonProdUrl('frontend', frontendUrl);
    assertNonProdUrl('backend', backendApiUrl);
    expect(fixtureDirectionResidue(), 'preflight: no leftover E2E direction').toBe(0);
  });

  test.afterAll(async ({ request }) => {
    if (!restoreEnabled) return;
    if (createdDirectionId !== null && accessToken) {
      await deleteDirectionViaApi(request, accessToken, createdDirectionId).catch(() => undefined);
      createdDirectionId = null;
    }
    deleteFixtureDirections();
    expect(fixtureDirectionResidue(), 'afterAll restore-to-zero').toBe(0);
  });

  test('renders Орг-структура tab and creates a direction through the UI', async ({ page, request }) => {
    accessToken = await loginForApiToken(request);

    await loginThroughUi(page);
    await page.goto(`${frontendUrl}/configuration`, { waitUntil: 'networkidle' });

    const tab = page.getByRole('tab', { name: /Орг-структура/ });
    await expect(tab, 'Орг-структура configuration tab must render').toBeVisible();
    await tab.click();

    await expect(page.getByText(/Направления/).first()).toBeVisible();
    await page.getByRole('button', { name: /Добавить направление/ }).click();
    await page.getByPlaceholder(/Название направления/).fill(fixtureName);
    await page.getByRole('button', { name: /^Создать$/ }).click();

    await expect(page.getByText(fixtureName).first(), 'created direction must be visible in the UI').toBeVisible({
      timeout: 30000,
    });

    const direction = await findDirectionByName(request, accessToken, fixtureName);
    createdDirectionId = direction.directionId;
    expect(direction.isActive).toBe(true);
    expect(fixtureDirectionResidue(), 'direction must exist after UI create').toBe(1);

    await deleteDirectionViaApi(request, accessToken, createdDirectionId);
    createdDirectionId = null;
    expect(fixtureDirectionResidue(), 'direction must be gone after API restore').toBe(0);
  });
});

interface DirectionDto {
  directionId: number;
  directionName: string;
  isActive: boolean;
}

interface DirectionListResponse {
  directions: DirectionDto[];
}

async function loginForApiToken(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${backendApiUrl}/auth/login`, {
    data: { username: adminUsername, password: adminPassword },
    headers: vercelBypass ? { 'x-vercel-protection-bypass': vercelBypass } : undefined,
  });
  await expectOk(response);
  const body = await response.json();
  expect(typeof body.accessToken).toBe('string');
  return body.accessToken;
}

async function findDirectionByName(
  request: APIRequestContext,
  token: string,
  directionName: string,
): Promise<DirectionDto> {
  const response = await request.get(`${backendApiUrl}/org/directions`, { headers: authHeaders(token) });
  await expectOk(response);
  const body = (await response.json()) as DirectionListResponse;
  const direction = body.directions.find((item) => item.directionName === directionName);
  expect(direction, `direction ${directionName} must be returned by /org/directions`).toBeTruthy();
  return direction as DirectionDto;
}

async function deleteDirectionViaApi(request: APIRequestContext, token: string, directionId: number): Promise<void> {
  const response = await request.delete(`${backendApiUrl}/org/directions/${directionId}?confirm=true`, {
    headers: authHeaders(token),
  });
  await expectOk(response);
}

function authHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (vercelBypass) headers['x-vercel-protection-bypass'] = vercelBypass;
  return headers;
}

async function loginThroughUi(page: Page): Promise<void> {
  if (vercelBypass) {
    await page.context().setExtraHTTPHeaders({ 'x-vercel-protection-bypass': vercelBypass });
  }
  await page.goto(`${frontendUrl}/login`, { waitUntil: 'domcontentloaded' });
  const loginResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/v1/auth/login') &&
      response.request().method() === 'POST',
  );
  await page.locator('input[autocomplete="username"], input#username').fill(adminUsername);
  await page.locator('input[autocomplete="current-password"], input#password').fill(adminPassword);
  await page.getByRole('button', { name: 'Войти' }).click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.ok()).toBe(true);
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30000 });
}

async function expectOk(response: APIResponse): Promise<void> {
  const body = response.ok() ? '' : await response.text();
  expect(response.ok(), body).toBe(true);
}

function fixtureDirectionResidue(): number {
  return Number(
    psql(`SELECT count(*)::int FROM directions WHERE direction_name = '${escapeSql(fixtureName)}';`),
  );
}

function deleteFixtureDirections(): void {
  const escaped = escapeSql(fixtureName);
  psql(`
    DELETE FROM direction_heads WHERE direction_id IN (SELECT direction_id FROM directions WHERE direction_name = '${escaped}');
    DELETE FROM direction_workshops WHERE direction_id IN (SELECT direction_id FROM directions WHERE direction_name = '${escaped}');
    DELETE FROM direction_work_centers WHERE direction_id IN (SELECT direction_id FROM directions WHERE direction_name = '${escaped}');
    DELETE FROM directions WHERE direction_name = '${escaped}';
  `);
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', postgresContainer, 'psql', '-U', 'postgres', '-d', 'erpdb', '-qAtX', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', maxBuffer: 1024 * 1024 },
  ).trim();
}

function assertTargetEnv(env: string): void {
  if (env === 'backend-test') return;
  throw new Error(`Refusing to run org structure UI canary against "${env}". Only backend-test is allowed.`);
}

function assertNonProdUrl(label: string, url: string): void {
  const host = new URL(url).hostname.toLowerCase();
  if (/prod|production|\blive\b/.test(host)) {
    throw new Error(`Refusing ${label} prod/live-looking host: ${host}`);
  }
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
