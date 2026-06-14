import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const canaryEnabled = process.env.PROJECTS_BATCH_LINK_WRITE_STAGE_CANARY === 'true';
const fixtureKey = process.env.PROJECTS_BATCH_LINK_WRITE_FIXTURE_KEY?.trim() ?? '';
const targetEnv = process.env.PROJECTS_BATCH_LINK_WRITE_TARGET_ENV?.trim() ?? '';
const backendApiUrl = trimTrailingSlash(
  process.env.PROJECTS_BATCH_LINK_WRITE_BACKEND_API_URL ?? 'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.PROJECTS_BATCH_LINK_WRITE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const backendContainer = process.env.PROJECTS_BATCH_LINK_WRITE_BACKEND_CONTAINER?.trim() ?? '';
const fixtureOrderId = readNumberEnv('PROJECTS_BATCH_LINK_WRITE_FIXTURE_ORDER_ID');
const fixtureOrderName = process.env.PROJECTS_BATCH_LINK_WRITE_FIXTURE_ORDER_NAME?.trim() ?? '';

const missingPrerequisites = [
  fixtureKey ? null : 'PROJECTS_BATCH_LINK_WRITE_FIXTURE_KEY',
  targetEnv === 'backend-test' ? null : 'PROJECTS_BATCH_LINK_WRITE_TARGET_ENV=backend-test',
  process.env.PROJECTS_BATCH_LINK_WRITE_RESTORE === 'true'
    ? null
    : 'PROJECTS_BATCH_LINK_WRITE_RESTORE=true',
  backendApiUrl ? null : 'PROJECTS_BATCH_LINK_WRITE_BACKEND_API_URL',
  postgresContainer ? null : 'PROJECTS_BATCH_LINK_WRITE_POSTGRES_CONTAINER',
  backendContainer ? null : 'PROJECTS_BATCH_LINK_WRITE_BACKEND_CONTAINER',
  fixtureOrderId ? null : 'PROJECTS_BATCH_LINK_WRITE_FIXTURE_ORDER_ID',
  fixtureOrderName ? null : 'PROJECTS_BATCH_LINK_WRITE_FIXTURE_ORDER_NAME',
  dockerContainerExists(postgresContainer) ? null : `docker container ${postgresContainer}`,
  backendContainer && dockerContainerExists(backendContainer)
    ? null
    : `docker container ${backendContainer || '<backend-container>'}`,
].filter((value): value is string => Boolean(value));

test.describe('Projects batch-link write mode stage canary', () => {
  test.skip(
    !canaryEnabled,
    'Set PROJECTS_BATCH_LINK_WRITE_STAGE_CANARY=true to enable this opt-in stage canary.',
  );
  test.skip(
    canaryEnabled && missingPrerequisites.length > 0,
    `Missing Projects batch-link write canary prerequisites: ${missingPrerequisites.join(', ')}`,
  );
  test.setTimeout(240000);

  let runtimeFlags: RuntimeFlagSnapshot | null = null;
  let userIds: number[] = [];

  test.beforeAll(() => {
    requireCanaryEnv();
    runtimeFlags = captureRuntimeFlags();
    requireProjectsBatchWriteRuntime(runtimeFlags);
    assertMigration013Applied();
    restoreFixtureRows();
    expectRestored(loadRestoreProof(), 'preflight restore');
    const fixture = discoverFixture();
    expect(fixture.orderId).toBe(fixtureOrderId);
    expect(fixture.orderName).toBe(fixtureOrderName);
  });

  test.afterAll(() => {
    let restoreError: unknown;
    try {
      if (process.env.PROJECTS_BATCH_LINK_WRITE_RESTORE === 'true') {
        restoreFixtureRows();
        expectRestored(loadRestoreProof(), 'afterAll restore');
      }
    } catch (error) {
      restoreError = error;
    } finally {
      for (const id of userIds) {
        cleanupUser(id);
      }
      if (runtimeFlags) {
        expectRuntimeFlagsUnchanged(runtimeFlags);
      }
      if (restoreError) throw restoreError;
    }
  });

  test('proves dry-run no-write, write idempotency, stale 409, audit/outbox dimensions, and restore-to-zero', async ({
    request,
  }) => {
    const fixture = discoverFixture();
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const admin = createSmokeUser(`e2e_projects_batch_write_admin_${runId}`, 1);
    userIds = [admin.userId];

    const token = await loginForApiToken(request, admin.username, admin.password);
    const project = await createProject(request, token, runId);
    const idempotencyKey = `${fixtureKey}:write:${runId}`;
    const dryRunPayload = batchPayload('dry-run', idempotencyKey, fixture);

    const dryRun = await postJson<ProjectBatchLinkResponse>(
      request,
      `/projects/${project.id}/batch-link`,
      token,
      dryRunPayload,
    );
    expect(dryRun.mode).toBe('dry-run');
    expect(dryRun.writeEnabled).toBe(false);
    expect(dryRun.summary.proposed).toBe(1);
    expect(loadProjectProof(project.id, idempotencyKey)).toMatchObject({
      projectEntityLinks: 0,
      commandIdempotencyKeys: 0,
      auditLogRows: 0,
      outboxEvents: 0,
    });

    const writePayload = batchPayload('write', idempotencyKey, fixture);
    const created = await postJson<ProjectBatchLinkResponse>(
      request,
      `/projects/${project.id}/batch-link`,
      token,
      writePayload,
    );
    expect(created.mode).toBe('write');
    expect(created.writeEnabled).toBe(true);
    expect(created.summary.created).toBe(1);
    expect(created.summary.existing).toBe(0);
    expect(created.changed).toBe(true);
    expect(created.auditId).toBeTruthy();
    expect(created.outboxEventId).toBeTruthy();
    expect(created.requestId).toBeTruthy();

    const replay = await postJson<ProjectBatchLinkResponse>(
      request,
      `/projects/${project.id}/batch-link`,
      token,
      writePayload,
    );
    expect(stripVolatileResponseFields(replay)).toEqual(stripVolatileResponseFields(created));

    await expectStatus(
      request.post(`${backendApiUrl}/projects/${project.id}/batch-link`, {
        headers: authHeaders(token),
        data: batchPayload('write', idempotencyKey, {
          ...fixture,
          orderId: fixture.orderId + 1,
        }),
      }),
      409,
      'reusing idempotency key with different explicit selection must fail',
    );

    const existingPayload = batchPayload('write', `${fixtureKey}:existing:${runId}`, fixture);
    const existing = await postJson<ProjectBatchLinkResponse>(
      request,
      `/projects/${project.id}/batch-link`,
      token,
      existingPayload,
    );
    expect(existing.summary.created).toBe(0);
    expect(existing.summary.existing).toBe(1);
    expect(existing.changed).toBe(false);
    expect(existing.auditId ?? null).toBeNull();
    expect(existing.outboxEventId ?? null).toBeNull();

    const proofBeforeRestore = loadProjectProof(project.id, idempotencyKey);
    expect(proofBeforeRestore).toMatchObject({
      projectEntityLinks: 1,
      commandIdempotencyKeys: 2,
      auditLogRows: 1,
      outboxEvents: 1,
    });
    expect(proofBeforeRestore.auditRequestId).toBe(created.requestId);
    expect(proofBeforeRestore.outboxRequestId).toBe(created.requestId);
    expect(proofBeforeRestore.auditFixtureKey).toBe(fixtureKey);
    expect(proofBeforeRestore.auditBatchSourceType).toBe('operator_csv');
    expect(proofBeforeRestore.outboxSource).toBe('projects-batch-link');
    expect(proofBeforeRestore.outboxIdempotencyKey).toBe(`${idempotencyKey}:project_entity_links_changed`);

    restoreFixtureRows();
    expectRestored(loadRestoreProof(), 'explicit restore');
    expectRuntimeFlagsUnchanged(runtimeFlags!);
  });
});

function requireCanaryEnv() {
  if (process.env.PROJECTS_BATCH_LINK_WRITE_STAGE_CANARY !== 'true') {
    throw new Error('PROJECTS_BATCH_LINK_WRITE_STAGE_CANARY=true is required');
  }
  if (!fixtureKey) {
    throw new Error('PROJECTS_BATCH_LINK_WRITE_FIXTURE_KEY is required');
  }
  if (!fixtureOrderId) {
    throw new Error('PROJECTS_BATCH_LINK_WRITE_FIXTURE_ORDER_ID must be a positive integer');
  }
  if (!fixtureOrderName) {
    throw new Error('PROJECTS_BATCH_LINK_WRITE_FIXTURE_ORDER_NAME is required');
  }
  if (process.env.PROJECTS_BATCH_LINK_WRITE_RESTORE !== 'true') {
    throw new Error('PROJECTS_BATCH_LINK_WRITE_RESTORE=true is required');
  }
  if (targetEnv !== 'backend-test') {
    throw new Error('PROJECTS_BATCH_LINK_WRITE_TARGET_ENV=backend-test is required');
  }
  assertTestTarget(backendApiUrl, postgresContainer);
}

function assertTestTarget(backend: string, postgres: string) {
  const combined = `${backend} ${postgres} ${backendContainer} ${targetEnv}`;
  if (/prod|production|live/i.test(combined)) {
    throw new Error('Refusing to run Projects batch-link write canary against prod/live target');
  }
  const parsedBackend = new URL(backend);
  expect(parsedBackend.hostname, 'Projects batch-link write canary must target backend-test').toBe(
    'backend-test.mebelkz.app',
  );
  expect(parsedBackend.pathname.replace(/\/+$/, ''), 'Backend API path must be /api/v1').toBe(
    '/api/v1',
  );
}

function captureRuntimeFlags(): RuntimeFlagSnapshot {
  const envJson = execFileSync(
    'docker',
    ['inspect', backendContainer, '--format', '{{json .Config.Env}}'],
    { encoding: 'utf8' },
  );
  const envList = JSON.parse(envJson) as string[];
  const envMap = new Map(envList.map((entry) => {
    const separator = entry.indexOf('=');
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  return {
    source: 'container-env',
    projectsEnabled: envMap.get('BACKEND_ENABLE_PROJECTS') === 'true',
    projectsReadOnly: envMap.get('BACKEND_PROJECTS_READ_ONLY') !== 'false',
    projectsBatchLinkWriteEnabled: envMap.get('BACKEND_ENABLE_PROJECTS_BATCH_LINK_WRITE') === 'true',
  };
}

function requireProjectsBatchWriteRuntime(flags: RuntimeFlagSnapshot) {
  if (!flags.projectsEnabled || flags.projectsReadOnly || !flags.projectsBatchLinkWriteEnabled) {
    throw new Error(
      'Projects batch-link write canary requires BACKEND_ENABLE_PROJECTS=true, BACKEND_PROJECTS_READ_ONLY=false, and BACKEND_ENABLE_PROJECTS_BATCH_LINK_WRITE=true. This spec does not mutate runtime flags.',
    );
  }
}

function expectRuntimeFlagsUnchanged(before: RuntimeFlagSnapshot) {
  const after = captureRuntimeFlags();
  expect(after.projectsEnabled).toBe(before.projectsEnabled);
  expect(after.projectsReadOnly).toBe(before.projectsReadOnly);
  expect(after.projectsBatchLinkWriteEnabled).toBe(before.projectsBatchLinkWriteEnabled);
}

function assertMigration013Applied() {
  const snapshot = psqlJson<MigrationPrecondition>(`
    SELECT json_build_object(
      'entityTypes', to_regclass('public.project_entity_types') IS NOT NULL,
      'entityLinks', to_regclass('public.project_entity_links') IS NOT NULL,
      'projects', to_regclass('public.project_projects') IS NOT NULL
    )::text;
  `);
  expect(snapshot.entityTypes).toBe(true);
  expect(snapshot.entityLinks).toBe(true);
  expect(snapshot.projects).toBe(true);
}

function discoverFixture(): FixturePreflight {
  const found = psqlJson<FixturePreflight>(`
    SELECT json_build_object(
      'orderId', o.order_id,
      'orderName', o.order_name
    )::text
    FROM public.orders o
    WHERE o.order_id = ${fixtureOrderId}
      AND o.order_name = '${sqlQuote(fixtureOrderName)}'
      AND COALESCE(o.delete_flag, false) = false
    LIMIT 1;
  `);
  expect(found.orderId, 'fixture order must exist').toBe(fixtureOrderId);
  return found;
}

async function createProject(
  request: APIRequestContext,
  token: string,
  runId: string,
): Promise<ProjectDto> {
  const response = await request.post(`${backendApiUrl}/projects`, {
    headers: authHeaders(token),
    data: {
      code: `pbw_${runId}`,
      name: `Projects batch-link write canary ${runId}`,
      status: 'active',
      ownerUserId: null,
      metadata: { fixtureKey, runId },
    },
  });
  await expectOk(response);
  const body = await response.json();
  expect(body.project?.id).toBeTruthy();
  return body.project as ProjectDto;
}

function batchPayload(
  mode: 'dry-run' | 'write',
  idempotencyKey: string,
  fixture: FixturePreflight,
): ProjectBatchLinkRequest {
  return {
    mode,
    ...(mode === 'write' ? { writeIntent: 'explicit-selected-ids' as const } : {}),
    fixtureKey,
    idempotencyKey,
    entityType: 'order',
    relationType: 'related',
    source: { type: 'operator_csv', reference: `${fixtureKey}:reviewed-input` },
    items: [{
      entityId: String(fixture.orderId),
      reason: `explicit reviewed order ${fixture.orderName}`,
      confidence: 'explicit',
      sourceRow: 'row-1',
    }],
  };
}

async function postJson<T>(
  request: APIRequestContext,
  path: string,
  token: string,
  data: unknown,
): Promise<T> {
  const response = await request.post(`${backendApiUrl}${path}`, {
    headers: authHeaders(token),
    data,
  });
  await expectOk(response);
  return response.json() as Promise<T>;
}

async function expectStatus(
  responsePromise: Promise<APIResponse>,
  status: number,
  message: string,
) {
  const response = await responsePromise;
  expect(response.status(), `${message}: ${await safeResponseText(response)}`).toBe(status);
}

async function expectOk(response: APIResponse) {
  expect(response.ok(), await safeResponseText(response)).toBe(true);
}

async function safeResponseText(response: APIResponse): Promise<string> {
  if (response.ok()) return '';
  return response.text();
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

function createSmokeUser(username: string, roleId: number): SmokeUser {
  const password = crypto.randomBytes(24).toString('base64url');
  const email = `${username}@example.invalid`;
  const passwordHash = bcrypt.hashSync(password, 10);
  const userId = Number(
    psql(`
      WITH inserted AS (
        INSERT INTO public.users (username, email, password_hash, role_id, full_name, is_active)
        VALUES (
          '${sqlQuote(username)}',
          '${sqlQuote(email)}',
          '${sqlQuote(passwordHash)}',
          ${roleId},
          'E2E Projects Batch Link Write Canary',
          true
        )
        RETURNING user_id
      )
      SELECT user_id FROM inserted;
    `),
  );
  return { userId, username, password };
}

function cleanupUser(userId: number) {
  psql(`
    DELETE FROM public.refresh_tokens WHERE user_id = ${userId};
    DELETE FROM public.auth_sessions WHERE user_id = ${userId};
    UPDATE public.users
    SET is_active = false,
        edited_by = NULL
    WHERE user_id = ${userId};
  `);
}

function restoreFixtureRows() {
  psql(`
    DO $$
    DECLARE
      fixture_project_ids uuid[];
    BEGIN
      SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
      INTO fixture_project_ids
      FROM public.project_projects
      WHERE metadata->>'fixtureKey' = '${sqlQuote(fixtureKey)}';

      DELETE FROM public.notifications
      WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%';
      DELETE FROM public.outbox_events
      WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%'
         OR aggregate_id = ANY(ARRAY(SELECT unnest(fixture_project_ids)::text))
         OR payload_json->>'projectId' = ANY(ARRAY(SELECT unnest(fixture_project_ids)::text));
      DELETE FROM public.audit_log
      WHERE request_id LIKE '${sqlQuote(fixtureKey)}:%'
         OR metadata_json->>'fixtureKey' = '${sqlQuote(fixtureKey)}'
         OR entity_id = ANY(ARRAY(SELECT unnest(fixture_project_ids)::text));
      DELETE FROM public.command_idempotency_keys
      WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%';
      DELETE FROM public.project_entity_links
      WHERE project_id = ANY(fixture_project_ids);
      DELETE FROM public.project_members
      WHERE project_id = ANY(fixture_project_ids);
      DELETE FROM public.project_projects
      WHERE id = ANY(fixture_project_ids);
    END $$;
  `);
}

function loadRestoreProof(): RestoreProof {
  return psqlJson<RestoreProof>(`
    WITH fixture_projects AS (
      SELECT id
      FROM public.project_projects
      WHERE metadata->>'fixtureKey' = '${sqlQuote(fixtureKey)}'
    )
    SELECT json_build_object(
      'projectRows', (SELECT count(*)::int FROM fixture_projects),
      'projectEntityLinks', (
        SELECT count(*)::int
        FROM public.project_entity_links
        WHERE project_id IN (SELECT id FROM fixture_projects)
      ),
      'commandIdempotencyKeys', (
        SELECT count(*)::int
        FROM public.command_idempotency_keys
        WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%'
      ),
      'auditLogRows', (
        SELECT count(*)::int
        FROM public.audit_log
        WHERE metadata_json->>'fixtureKey' = '${sqlQuote(fixtureKey)}'
           OR entity_id IN (SELECT id::text FROM fixture_projects)
      ),
      'outboxEvents', (
        SELECT count(*)::int
        FROM public.outbox_events
        WHERE aggregate_id IN (SELECT id::text FROM fixture_projects)
           OR idempotency_key LIKE '${sqlQuote(fixtureKey)}:%'
      ),
      'notifications', (
        SELECT count(*)::int
        FROM public.notifications
        WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%'
      )
    )::text;
  `);
}

function loadProjectProof(projectId: string, idempotencyKey: string): ProjectProof {
  return psqlJson<ProjectProof>(`
    SELECT json_build_object(
      'projectEntityLinks', (
        SELECT count(*)::int
        FROM public.project_entity_links
        WHERE project_id = '${sqlQuote(projectId)}'::uuid
      ),
      'commandIdempotencyKeys', (
        SELECT count(*)::int
        FROM public.command_idempotency_keys
        WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%'
      ),
      'auditLogRows', (
        SELECT count(*)::int
        FROM public.audit_log
        WHERE entity_type = 'project'
          AND entity_id = '${sqlQuote(projectId)}'
          AND metadata_json->>'fixtureKey' = '${sqlQuote(fixtureKey)}'
      ),
      'outboxEvents', (
        SELECT count(*)::int
        FROM public.outbox_events
        WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%'
      ),
      'auditRequestId', (
        SELECT request_id
        FROM public.audit_log
        WHERE entity_type = 'project'
          AND entity_id = '${sqlQuote(projectId)}'
          AND metadata_json->>'fixtureKey' = '${sqlQuote(fixtureKey)}'
        ORDER BY created_at DESC
        LIMIT 1
      ),
      'auditFixtureKey', (
        SELECT metadata_json->>'fixtureKey'
        FROM public.audit_log
        WHERE entity_type = 'project'
          AND entity_id = '${sqlQuote(projectId)}'
          AND metadata_json->>'fixtureKey' = '${sqlQuote(fixtureKey)}'
        ORDER BY created_at DESC
        LIMIT 1
      ),
      'auditBatchSourceType', (
        SELECT metadata_json->>'batchSourceType'
        FROM public.audit_log
        WHERE entity_type = 'project'
          AND entity_id = '${sqlQuote(projectId)}'
          AND metadata_json->>'fixtureKey' = '${sqlQuote(fixtureKey)}'
        ORDER BY created_at DESC
        LIMIT 1
      ),
      'outboxRequestId', (
        SELECT payload_json->>'requestId'
        FROM public.outbox_events
        WHERE idempotency_key = '${sqlQuote(idempotencyKey)}:project_entity_links_changed'
        LIMIT 1
      ),
      'outboxSource', (
        SELECT payload_json->>'source'
        FROM public.outbox_events
        WHERE idempotency_key = '${sqlQuote(idempotencyKey)}:project_entity_links_changed'
        LIMIT 1
      ),
      'outboxIdempotencyKey', (
        SELECT idempotency_key
        FROM public.outbox_events
        WHERE idempotency_key = '${sqlQuote(idempotencyKey)}:project_entity_links_changed'
        LIMIT 1
      )
    )::text;
  `);
}

function expectRestored(proof: RestoreProof, label: string) {
  expect(proof.projectRows, label).toBe(0);
  expect(proof.projectEntityLinks, label).toBe(0);
  expect(proof.commandIdempotencyKeys, label).toBe(0);
  expect(proof.auditLogRows, label).toBe(0);
  expect(proof.outboxEvents, label).toBe(0);
  expect(proof.notifications, label).toBe(0);
}

function stripVolatileResponseFields<T extends Record<string, unknown>>(value: T): unknown {
  return stripVolatileObject(JSON.parse(JSON.stringify(value)));
}

function stripVolatileObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripVolatileObject);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'requestId' || key === 'auditId' || key === 'outboxEventId') {
      continue;
    }
    result[key] = stripVolatileObject(entry);
  }
  return result;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function psqlJson<T>(sql: string): T {
  const output = psql(sql);
  if (!output) {
    throw new Error(`Expected JSON SQL output, got empty output for: ${sql.slice(0, 120)}`);
  }
  return JSON.parse(output) as T;
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
      'postgres',
      '-d',
      'erpdb',
      '-qAtX',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    {
      input: sql,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  ).trim();
}

function dockerContainerExists(containerName: string): boolean {
  if (!containerName) return false;
  try {
    execFileSync('docker', ['container', 'inspect', containerName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readNumberEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function sqlQuote(value: string): string {
  return value.replaceAll("'", "''");
}

interface RuntimeFlagSnapshot {
  source: 'container-env';
  projectsEnabled: boolean;
  projectsReadOnly: boolean;
  projectsBatchLinkWriteEnabled: boolean;
}

interface MigrationPrecondition {
  entityTypes: boolean;
  entityLinks: boolean;
  projects: boolean;
}

interface FixturePreflight {
  orderId: number;
  orderName: string;
}

interface RestoreProof {
  projectRows: number;
  projectEntityLinks: number;
  commandIdempotencyKeys: number;
  auditLogRows: number;
  outboxEvents: number;
  notifications: number;
}

interface ProjectProof {
  projectEntityLinks: number;
  commandIdempotencyKeys: number;
  auditLogRows: number;
  outboxEvents: number;
  auditRequestId: string | null;
  auditFixtureKey: string | null;
  auditBatchSourceType: string | null;
  outboxRequestId: string | null;
  outboxSource: string | null;
  outboxIdempotencyKey: string | null;
}

interface SmokeUser {
  userId: number;
  username: string;
  password: string;
}

interface ProjectDto {
  id: string;
}

interface ProjectBatchLinkRequest {
  mode: 'dry-run' | 'write';
  writeIntent?: 'explicit-selected-ids';
  fixtureKey: string;
  idempotencyKey: string;
  entityType: 'order';
  relationType: 'related';
  source: { type: string; reference: string };
  items: Array<{
    entityId: string;
    reason: string;
    confidence: string;
    sourceRow: string;
  }>;
}

interface ProjectBatchLinkResponse {
  projectId: string;
  mode: 'dry-run' | 'write';
  summary: {
    proposed: number;
    created?: number;
    existing?: number;
    skipped: number;
    conflicts: number;
    sampledEvidenceRows: number;
  };
  writeEnabled: boolean;
  changed?: boolean;
  auditId?: string | null;
  outboxEventId?: string | null;
  requestId?: string | null;
}
