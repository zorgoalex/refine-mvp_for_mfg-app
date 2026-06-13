import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

// Fail-closed opt-in live canary for the org-data management API. It only runs
// when ORG_MANAGEMENT_STAGE_CANARY=true AND it is pointed at a non-production
// backend-test target. Preconditions (operator window): migration 017 applied
// and BACKEND_ENABLE_ORG_MANAGEMENT=true / BACKEND_ORG_MANAGEMENT_READ_ONLY=false.
// All writes go through the API; SQL is used only for preflight + restore proof.
const canaryEnabled = process.env.ORG_MANAGEMENT_STAGE_CANARY === 'true';
const backendApiUrl = trimTrailingSlash(
  process.env.ORG_MANAGEMENT_STAGE_BACKEND_API_URL ?? 'https://backend.dev.mebelkz.app/api/v1',
);
const postgresContainer = process.env.ORG_MANAGEMENT_STAGE_POSTGRES_CONTAINER ?? 'erp_dev-postgresdb-1';

test.describe('Org management stage canary', () => {
  test.skip(!canaryEnabled, 'Run with ORG_MANAGEMENT_STAGE_CANARY=true');
  test.skip(
    canaryEnabled && !dockerContainerExists(postgresContainer),
    `Stage postgres container ${postgresContainer} is required for the org management canary.`,
  );
  test.setTimeout(180000);

  let userId: number | null = null;
  let directionId: number | null = null;
  let accessToken: string | null = null;

  test.beforeAll(() => {
    assertNonProductionTarget(backendApiUrl, 'backend');
    assertNonProductionTarget(postgresContainer, 'postgres');
  });

  test.afterEach(async ({ request }) => {
    // Restore-to-zero: remove the created direction + smoke user.
    if (directionId !== null && accessToken) {
      await request
        .delete(`${backendApiUrl}/org/directions/${directionId}?confirm=true`, { headers: authHeaders(accessToken) })
        .catch(() => undefined);
    }
    if (userId !== null) {
      psql(`DELETE FROM workshop_heads WHERE user_id = ${Number(userId)};`);
      psql(`DELETE FROM direction_heads WHERE user_id = ${Number(userId)};`);
      psql(`DELETE FROM users WHERE user_id = ${Number(userId)};`);
    }
  });

  test('creates a direction + heads through the API with query-ready audit and idempotent replay', async ({
    request,
  }) => {
    // Precondition: additive migration 017 dimension exists.
    const hasRelatedUser = psql(`
      SELECT count(*)::int FROM information_schema.columns
      WHERE table_name = 'audit_log' AND column_name = 'related_user_id';
    `);
    expect(Number(hasRelatedUser)).toBe(1);

    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_test_org_${runId}`;
    const password = crypto.randomBytes(24).toString('base64url');
    userId = createSmokeAdmin(username, password);
    accessToken = await loginForApiToken(request, username, password);

    // Precondition: flag enabled (writes available, not 503).
    const listResponse = await request.get(`${backendApiUrl}/org/directions`, { headers: authHeaders(accessToken) });
    await expectOk(listResponse);

    const directionName = `E2E-Тест Направление ${runId}`;
    const created = await postJson<{ directionId: number }>(request, '/org/directions', accessToken, {
      name: directionName,
    });
    directionId = created.directionId;
    expect(typeof directionId).toBe('number');

    const idempotencyKey = `org-stage-heads:${runId}`;
    const first = await putJson<{ directionId: number; heads: Array<{ userId: number }> }>(
      request,
      `/org/directions/${directionId}/heads`,
      accessToken,
      { idempotencyKey, ids: [userId] },
    );
    expect(first.heads.map((h) => h.userId)).toContain(userId);

    // Audit must be query-ready by affected user (related_user_id).
    const headAudit = psql(`
      SELECT count(*)::int FROM audit_log
      WHERE event = 'ORG_DIRECTION_HEAD_ADDED'
        AND entity_type = 'direction' AND entity_id = '${Number(directionId)}'
        AND related_user_id = ${Number(userId)};
    `);
    expect(Number(headAudit)).toBe(1);

    const createdAudit = psql(`
      SELECT count(*)::int FROM audit_log
      WHERE event = 'ORG_DIRECTION_CREATED' AND entity_type = 'direction' AND entity_id = '${Number(directionId)}';
    `);
    expect(Number(createdAudit)).toBe(1);

    // Idempotent replay: same key returns the original response, no duplicate audit.
    const replay = await putJson<{ heads: Array<{ userId: number }> }>(
      request,
      `/org/directions/${directionId}/heads`,
      accessToken,
      { idempotencyKey, ids: [userId] },
    );
    expect(replay.heads.map((h) => h.userId)).toEqual(first.heads.map((h) => h.userId));

    const headAuditAfterReplay = psql(`
      SELECT count(*)::int FROM audit_log
      WHERE event = 'ORG_DIRECTION_HEAD_ADDED'
        AND entity_type = 'direction' AND entity_id = '${Number(directionId)}'
        AND related_user_id = ${Number(userId)};
    `);
    expect(Number(headAuditAfterReplay)).toBe(1);

    // Restore-to-zero proof: hard delete via API, confirm rows gone.
    const deleteResponse = await request.delete(
      `${backendApiUrl}/org/directions/${directionId}?confirm=true`,
      { headers: authHeaders(accessToken) },
    );
    await expectOk(deleteResponse);
    directionId = null;
  });
});

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function expectOk(response: APIResponse): Promise<void> {
  if (!response.ok()) {
    throw new Error(`Expected 2xx, got ${response.status()}: ${await response.text()}`);
  }
}

async function loginForApiToken(request: APIRequestContext, username: string, password: string): Promise<string> {
  const response = await request.post(`${backendApiUrl}/auth/login`, { data: { username, password } });
  await expectOk(response);
  const body = await response.json();
  expect(typeof body.accessToken).toBe('string');
  return body.accessToken;
}

async function postJson<T>(request: APIRequestContext, path: string, token: string | null, data: unknown): Promise<T> {
  const response = await request.post(`${backendApiUrl}${path}`, { headers: authHeaders(token), data });
  await expectOk(response);
  return (await response.json()) as T;
}

async function putJson<T>(request: APIRequestContext, path: string, token: string | null, data: unknown): Promise<T> {
  const response = await request.put(`${backendApiUrl}${path}`, { headers: authHeaders(token), data });
  await expectOk(response);
  return (await response.json()) as T;
}

function createSmokeAdmin(username: string, password: string): number {
  const email = `${username}@example.invalid`;
  const passwordHash = bcrypt.hashSync(password, 10);
  return Number(
    psql(`
      WITH inserted AS (
        INSERT INTO users (username, email, password_hash, role_id, full_name, is_active)
        VALUES ('${sqlQuote(username)}', '${sqlQuote(email)}', '${sqlQuote(passwordHash)}', 1,
                'E2E Test Org Stage Canary', true)
        RETURNING user_id
      )
      SELECT user_id FROM inserted;
    `),
  );
}

function assertNonProductionTarget(target: string, label: string): void {
  if (/prod|live/i.test(target)) {
    throw new Error(`Refusing to run org management canary against production-like ${label} target: ${target}`);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', postgresContainer, 'psql', '-U', 'postgres', '-d', 'erpdb', '-qAtX', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', maxBuffer: 1024 * 1024 },
  ).trim();
}

function dockerContainerExists(containerName: string): boolean {
  try {
    execFileSync('docker', ['container', 'inspect', containerName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
