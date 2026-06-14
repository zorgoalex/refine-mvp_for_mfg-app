import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const canaryEnabled = process.env.NOTIFICATION_RULES_PROJECT_SCOPE_STAGE_CANARY === 'true';
const targetEnv = process.env.NOTIFICATION_RULES_PROJECT_SCOPE_TARGET_ENV?.trim() ?? '';
const restoreEnabled = process.env.NOTIFICATION_RULES_PROJECT_SCOPE_RESTORE === 'true';
const fixtureKey = process.env.NOTIFICATION_RULES_PROJECT_SCOPE_FIXTURE_KEY?.trim() ?? '';
const backendApiUrl = trimTrailingSlash(
  process.env.NOTIFICATION_RULES_PROJECT_SCOPE_BACKEND_API_URL ?? 'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.NOTIFICATION_RULES_PROJECT_SCOPE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const adminUsername =
  process.env.NOTIFICATION_RULES_PROJECT_SCOPE_ADMIN_USERNAME?.trim() ||
  process.env.CODEX_PLAYWRIGHT_USERNAME?.trim() ||
  'codex_playwright';
const adminPassword = process.env.NOTIFICATION_RULES_PROJECT_SCOPE_ADMIN_PASSWORD ?? process.env.CODEX_PLAYWRIGHT_PASSWORD ?? '';
const vercelBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ?? '';

const runId = crypto.randomBytes(5).toString('hex');
const projectCode = `E2E-NOTIF-SCOPE-${runId}`;
const globalRuleCode = `${fixtureKey}-global-${runId}`;
const scopedRuleCode = `${fixtureKey}-project-${runId}`;

const missingPrerequisites = [
  targetEnv === 'backend-test' ? null : 'NOTIFICATION_RULES_PROJECT_SCOPE_TARGET_ENV=backend-test',
  restoreEnabled ? null : 'NOTIFICATION_RULES_PROJECT_SCOPE_RESTORE=true',
  fixtureKey ? null : 'NOTIFICATION_RULES_PROJECT_SCOPE_FIXTURE_KEY',
  backendApiUrl ? null : 'NOTIFICATION_RULES_PROJECT_SCOPE_BACKEND_API_URL',
  adminUsername ? null : 'NOTIFICATION_RULES_PROJECT_SCOPE_ADMIN_USERNAME or CODEX_PLAYWRIGHT_USERNAME',
  adminPassword ? null : 'NOTIFICATION_RULES_PROJECT_SCOPE_ADMIN_PASSWORD or CODEX_PLAYWRIGHT_PASSWORD',
  dockerContainerExists(postgresContainer) ? null : `docker container ${postgresContainer}`,
].filter((value): value is string => Boolean(value));

test.describe('notification rules project-scope stage canary', () => {
  test.skip(
    !canaryEnabled,
    'Set NOTIFICATION_RULES_PROJECT_SCOPE_STAGE_CANARY=true to enable this opt-in stage canary.',
  );
  test.skip(
    canaryEnabled && missingPrerequisites.length > 0,
    `Missing notification rules project-scope canary prerequisites: ${missingPrerequisites.join(', ')}`,
  );
  test.setTimeout(180000);

  test.beforeAll(() => {
    assertTargetEnv(targetEnv);
    assertBackendApiUrl(backendApiUrl);
    restoreFixtureRows();
    expect(loadResidueCounts()).toEqual({ projects: 0, rules: 0 });
  });

  test.afterAll(() => {
    if (restoreEnabled) {
      restoreFixtureRows();
      expect(loadResidueCounts()).toEqual({ projects: 0, rules: 0 });
    }
  });

  test('proves create/list/update/delete projectId API contract and restore-to-zero', async ({ request }) => {
    const token = await loginForApiToken(request);
    const project = await createProject(request, token);

    const globalRule = await createRule(request, token, {
      ruleCode: globalRuleCode,
      projectId: null,
    });
    expect(globalRule.projectId).toBeNull();

    const scopedRule = await createRule(request, token, {
      ruleCode: scopedRuleCode,
      projectId: project.id,
    });
    expect(scopedRule.projectId).toBe(project.id);

    const globalRules = await listRules(request, token, 'global');
    expect(globalRules.some((rule) => rule.ruleCode === globalRuleCode)).toBe(true);
    expect(globalRules.some((rule) => rule.ruleCode === scopedRuleCode)).toBe(false);

    const projectRules = await listRules(request, token, project.id);
    expect(projectRules.some((rule) => rule.ruleCode === scopedRuleCode)).toBe(true);
    expect(projectRules.some((rule) => rule.ruleCode === globalRuleCode)).toBe(false);

    const cleared = await patchRule(request, token, scopedRule.notificationRuleId, scopedRule.updatedAt);
    expect(cleared.projectId).toBeNull();

    await deleteRule(request, token, globalRule.notificationRuleId);
    await deleteRule(request, token, scopedRule.notificationRuleId);
    restoreFixtureRows();
    expect(loadResidueCounts()).toEqual({ projects: 0, rules: 0 });
  });
});

interface ProjectDto {
  id: string;
  code: string;
  name: string;
}

interface RuleDto {
  notificationRuleId: string;
  ruleCode: string;
  projectId: string | null;
  updatedAt: string;
}

async function createProject(request: APIRequestContext, token: string): Promise<ProjectDto> {
  const response = await request.post(`${backendApiUrl}/projects`, {
    headers: authHeaders(token),
    data: {
      code: projectCode,
      name: `E2E notification scope ${runId}`,
      status: 'active',
      metadata: { fixtureKey, runId },
    },
  });
  await expectOk(response);
  const body = (await response.json()) as { project: ProjectDto };
  return body.project;
}

async function createRule(
  request: APIRequestContext,
  token: string,
  input: { ruleCode: string; projectId: string | null },
): Promise<RuleDto> {
  const response = await request.post(`${backendApiUrl}/notification-rules`, {
    headers: authHeaders(token),
    data: {
      ruleCode: input.ruleCode,
      eventType: 'DEADLINE_EXPIRED',
      projectId: input.projectId,
      level: 'info',
      priority: 100,
      isEnabled: true,
      conditions: {},
      recipients: { resolvers: ['project_participants'] },
      titleTemplate: 'E2E {orderId}',
      messageTemplate: 'E2E {orderId} {eventType}',
    },
  });
  await expectOk(response);
  return (await response.json()) as RuleDto;
}

async function listRules(
  request: APIRequestContext,
  token: string,
  projectId: string | 'global',
): Promise<RuleDto[]> {
  const response = await request.get(
    `${backendApiUrl}/notification-rules?eventType=DEADLINE_EXPIRED&projectId=${encodeURIComponent(projectId)}`,
    { headers: authHeaders(token) },
  );
  await expectOk(response);
  return (await response.json()) as RuleDto[];
}

async function patchRule(
  request: APIRequestContext,
  token: string,
  ruleId: string,
  expectedUpdatedAt: string,
): Promise<RuleDto> {
  const response = await request.patch(`${backendApiUrl}/notification-rules/${encodeURIComponent(ruleId)}`, {
    headers: authHeaders(token),
    data: {
      projectId: null,
      reason: 'E2E clear project scope',
      expectedUpdatedAt,
    },
  });
  await expectOk(response);
  return (await response.json()) as RuleDto;
}

async function deleteRule(request: APIRequestContext, token: string, ruleId: string): Promise<void> {
  const response = await request.delete(`${backendApiUrl}/notification-rules/${encodeURIComponent(ruleId)}`, {
    headers: authHeaders(token),
  });
  await expectOk(response);
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

function authHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (vercelBypass) headers['x-vercel-protection-bypass'] = vercelBypass;
  return headers;
}

async function expectOk(response: APIResponse): Promise<void> {
  const body = response.ok() ? '' : await response.text();
  expect(response.ok(), body).toBe(true);
}

function restoreFixtureRows(): void {
  psql(`
    DELETE FROM notification_rules
    WHERE rule_code IN ('${escapeSql(globalRuleCode)}', '${escapeSql(scopedRuleCode)}');
    DELETE FROM project_projects
    WHERE code = '${escapeSql(projectCode)}';
  `);
}

function loadResidueCounts(): { projects: number; rules: number } {
  const result = psql(`
    SELECT
      (SELECT count(*)::int FROM project_projects WHERE code = '${escapeSql(projectCode)}') || '|' ||
      (SELECT count(*)::int FROM notification_rules WHERE rule_code IN ('${escapeSql(globalRuleCode)}', '${escapeSql(scopedRuleCode)}'));
  `);
  const [projects, rules] = result.split('|').map((value) => Number(value));
  return { projects, rules };
}

function psql(sql: string): string {
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

function assertTargetEnv(env: string): void {
  if (env === 'backend-test') return;
  throw new Error(`Refusing to run against target env "${env}". Only backend-test is permitted.`);
}

function assertBackendApiUrl(url: string): void {
  const host = new URL(url).hostname.toLowerCase();
  if (!host.includes('backend-test') || /prod|production|\blive\b/.test(host)) {
    throw new Error(`Refusing to target backend host: ${host}`);
  }
}

function dockerContainerExists(container: string): boolean {
  try {
    execFileSync('docker', ['container', 'inspect', container], { stdio: 'ignore' });
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
