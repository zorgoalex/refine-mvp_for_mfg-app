import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const canaryEnabled = process.env.PROJECTS_GENERIC_LINKING_STAGE_CANARY === 'true';
const fixtureKey = process.env.PROJECTS_GENERIC_LINKING_FIXTURE_KEY?.trim() ?? '';
const targetEnv = process.env.PROJECTS_GENERIC_LINKING_TARGET_ENV?.trim() ?? '';
const frontendUrl = trimTrailingSlash(
  process.env.PROJECTS_GENERIC_LINKING_STAGE_FRONTEND_URL ?? 'https://app-test.mebelkz.app',
);
const backendApiUrl = trimTrailingSlash(
  process.env.PROJECTS_GENERIC_LINKING_STAGE_BACKEND_API_URL ??
    'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.PROJECTS_GENERIC_LINKING_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const backendContainer = process.env.PROJECTS_GENERIC_LINKING_STAGE_BACKEND_CONTAINER?.trim() ?? '';
const fixtureOrderId = readNumberEnv('PROJECTS_GENERIC_LINKING_FIXTURE_ORDER_ID');
const fixtureOrderName = process.env.PROJECTS_GENERIC_LINKING_FIXTURE_ORDER_NAME?.trim() ?? '';

const missingPrerequisites = [
  fixtureKey ? null : 'PROJECTS_GENERIC_LINKING_FIXTURE_KEY',
  targetEnv === 'backend-test' ? null : 'PROJECTS_GENERIC_LINKING_TARGET_ENV=backend-test',
  process.env.PROJECTS_GENERIC_LINKING_RESTORE === 'true'
    ? null
    : 'PROJECTS_GENERIC_LINKING_RESTORE=true',
  frontendUrl ? null : 'PROJECTS_GENERIC_LINKING_STAGE_FRONTEND_URL',
  backendApiUrl ? null : 'PROJECTS_GENERIC_LINKING_STAGE_BACKEND_API_URL',
  postgresContainer ? null : 'PROJECTS_GENERIC_LINKING_STAGE_POSTGRES_CONTAINER',
  backendContainer ? null : 'PROJECTS_GENERIC_LINKING_STAGE_BACKEND_CONTAINER',
  fixtureOrderId ? null : 'PROJECTS_GENERIC_LINKING_FIXTURE_ORDER_ID',
  fixtureOrderName ? null : 'PROJECTS_GENERIC_LINKING_FIXTURE_ORDER_NAME',
  dockerContainerExists(postgresContainer) ? null : `docker container ${postgresContainer}`,
  backendContainer && dockerContainerExists(backendContainer)
    ? null
    : `docker container ${backendContainer || '<backend-container>'}`,
].filter((value): value is string => Boolean(value));

let fixture: FixturePreflight | null = null;

test.describe('Projects generic linking + participants stage canary', () => {
  test.skip(
    !canaryEnabled,
    'Set PROJECTS_GENERIC_LINKING_STAGE_CANARY=true to enable this opt-in stage canary.',
  );
  test.skip(
    canaryEnabled && missingPrerequisites.length > 0,
    `Missing Projects generic linking canary prerequisites: ${missingPrerequisites.join(', ')}`,
  );
  test.setTimeout(240000);

  let runtimeFlags: RuntimeFlagSnapshot | null = null;
  let userIds: number[] = [];

  test.beforeAll(() => {
    requireCanaryEnv();
    runtimeFlags = captureRuntimeFlags();
    requireProjectsWriteRuntime(runtimeFlags);
    assertMigration013Applied();
    restoreFixtureRows();
    expectRestored(loadRestoreProof(), 'preflight restore');
    fixture = discoverFixture();
    expect(fixture.orderId).toBe(fixtureOrderId);
    expect(fixture.orderName).toBe(fixtureOrderName);
    expect(fixture.projectOrderLinksBefore).toBeGreaterThanOrEqual(0);
  });

  test.afterAll(() => {
    let restoreError: unknown;
    try {
      if (process.env.PROJECTS_GENERIC_LINKING_RESTORE === 'true') {
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

  test('writes through backend endpoints, proves idempotency, RBAC, overview summaries, and restore-to-zero', async ({
    request,
  }) => {
    expect(fixture).not.toBeNull();
    const currentFixture = fixture!;
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

    const admin = createSmokeUser(`e2e_projects_generic_admin_${runId}`, 2);
    const manager = createSmokeUser(`e2e_projects_generic_manager_${runId}`, 10);
    const topManager = createSmokeUser(`e2e_projects_generic_top_${runId}`, 15);
    userIds = [admin.userId, manager.userId, topManager.userId];

    const adminToken = await loginForApiToken(request, admin.username, admin.password);
    const managerToken = await loginForApiToken(request, manager.username, manager.password);
    const topManagerToken = await loginForApiToken(request, topManager.username, topManager.password);
    await expectFrontendRuntimeConfigIfAvailable(request);

    const project = await createProject(request, adminToken, runId);
    const linksIdempotencyKey = `${fixtureKey}:links:${runId}`;
    const participantsIdempotencyKey = `${fixtureKey}:participants:${runId}`;

    const linkPayload = {
      idempotencyKey: linksIdempotencyKey,
      reason: fixtureKey,
      links: [
        { entityType: 'order', entityId: String(currentFixture.orderId), relationType: 'related', metadata: { fixtureKey } },
        { entityType: 'client', entityId: String(currentFixture.clientId), relationType: 'related', metadata: { fixtureKey } },
        { entityType: 'employee', entityId: String(currentFixture.employeeId), relationType: 'related', metadata: { fixtureKey } },
        { entityType: 'workshop', entityId: String(currentFixture.workshopId), relationType: 'related', metadata: { fixtureKey } },
      ],
    };

    const links = await putJson<ProjectEntityLinksResponse>(
      request,
      `/projects/${project.id}/entity-links`,
      adminToken,
      linkPayload,
    );
    expect(links.projectId).toBe(project.id);
    expect(links.links).toHaveLength(4);
    expect(new Set(links.links.map((link) => link.entityType))).toEqual(
      new Set(['order', 'client', 'employee', 'workshop']),
    );

    const linksReplay = await putJson<ProjectEntityLinksResponse>(
      request,
      `/projects/${project.id}/entity-links`,
      adminToken,
      linkPayload,
    );
    expect(stripVolatileResponseFields(linksReplay)).toEqual(stripVolatileResponseFields(links));

    const participants = await putJson<ProjectParticipantsResponse>(
      request,
      `/projects/${project.id}/participants`,
      adminToken,
      {
        idempotencyKey: participantsIdempotencyKey,
        reason: fixtureKey,
        participants: [
          { participantType: 'user', participantId: String(admin.userId), roleCode: 'manager', metadata: { fixtureKey } },
          { participantType: 'employee', participantId: String(currentFixture.employeeId), roleCode: 'observer', metadata: { fixtureKey } },
        ],
      },
    );
    expect(participants.projectId).toBe(project.id);
    expect(participants.participants).toHaveLength(2);
    expect(participants.participants.map((participant) => participant.role.code).sort()).toEqual([
      'manager',
      'observer',
    ]);

    const participantsReplay = await putJson<ProjectParticipantsResponse>(
      request,
      `/projects/${project.id}/participants`,
      adminToken,
      {
        idempotencyKey: participantsIdempotencyKey,
        reason: fixtureKey,
        participants: [
          { participantType: 'user', participantId: String(admin.userId), roleCode: 'manager', metadata: { fixtureKey } },
          { participantType: 'employee', participantId: String(currentFixture.employeeId), roleCode: 'observer', metadata: { fixtureKey } },
        ],
      },
    );
    expect(stripVolatileResponseFields(participantsReplay)).toEqual(
      stripVolatileResponseFields(participants),
    );

    const listedLinks = await getJson<ProjectEntityLinksResponse>(
      request,
      `/projects/${project.id}/entity-links`,
      adminToken,
    );
    expect(listedLinks.links).toHaveLength(4);

    const listedParticipants = await getJson<ProjectParticipantsResponse>(
      request,
      `/projects/${project.id}/participants`,
      adminToken,
    );
    expect(listedParticipants.participants).toHaveLength(2);

    const overview = await getJson<ProjectOverviewResponse>(
      request,
      `/projects/${project.id}/overview`,
      adminToken,
    );
    expect(countByEntity(overview, 'order')).toBe(1);
    expect(countByEntity(overview, 'client')).toBe(1);
    expect(countByEntity(overview, 'employee')).toBe(1);
    expect(countByEntity(overview, 'workshop')).toBe(1);
    expect(countByRole(overview, 'manager')).toBe(1);
    expect(countByRole(overview, 'observer')).toBe(1);

    await expectStatus(
      request.put(`${backendApiUrl}/projects/${project.id}/entity-links`, {
        headers: authHeaders(managerToken),
        data: { ...linkPayload, idempotencyKey: `${fixtureKey}:no-manage-links:${runId}` },
      }),
      403,
      'manager without projects.manage_links cannot write entity links',
    );
    await expectStatus(
      request.put(`${backendApiUrl}/projects/${project.id}/entity-links`, {
        headers: authHeaders(topManagerToken),
        data: {
          idempotencyKey: `${fixtureKey}:no-users-view:${runId}`,
          reason: fixtureKey,
          links: [{ entityType: 'user', entityId: String(admin.userId), relationType: 'related', metadata: { fixtureKey } }],
        },
      }),
      403,
      'top_manager without users.view cannot link user entities',
    );
    await expectStatus(
      request.put(`${backendApiUrl}/projects/${project.id}/participants`, {
        headers: authHeaders(managerToken),
        data: {
          idempotencyKey: `${fixtureKey}:no-participants-manage:${runId}`,
          reason: fixtureKey,
          participants: [
            { participantType: 'employee', participantId: String(currentFixture.employeeId), roleCode: 'observer', metadata: { fixtureKey } },
          ],
        },
      }),
      403,
      'manager without projects.participants.manage cannot replace participants',
    );

    const proofBeforeRestore = loadRestoreProof();
    expect(proofBeforeRestore.projectRows).toBe(1);
    expect(proofBeforeRestore.projectEntityLinks).toBe(4);
    expect(proofBeforeRestore.projectParticipants).toBe(2);
    expect(proofBeforeRestore.commandIdempotencyKeys).toBeGreaterThanOrEqual(2);
    expect(proofBeforeRestore.projectOrderProjects).toBe(currentFixture.projectOrderLinksBefore);

    restoreFixtureRows();
    expectRestored(loadRestoreProof(), 'explicit restore');
    expectRuntimeFlagsUnchanged(runtimeFlags!);
    await expectPostRestoreProbe(request, adminToken, runtimeFlags!);
  });
});

function requireCanaryEnv() {
  if (process.env.PROJECTS_GENERIC_LINKING_STAGE_CANARY !== 'true') {
    throw new Error('PROJECTS_GENERIC_LINKING_STAGE_CANARY=true is required');
  }
  if (!fixtureKey) {
    throw new Error('PROJECTS_GENERIC_LINKING_FIXTURE_KEY is required');
  }
  if (!fixtureOrderId) {
    throw new Error('PROJECTS_GENERIC_LINKING_FIXTURE_ORDER_ID must be a positive integer');
  }
  if (!fixtureOrderName) {
    throw new Error('PROJECTS_GENERIC_LINKING_FIXTURE_ORDER_NAME is required');
  }
  if (process.env.PROJECTS_GENERIC_LINKING_RESTORE !== 'true') {
    throw new Error('PROJECTS_GENERIC_LINKING_RESTORE=true is required');
  }
  if (targetEnv !== 'backend-test') {
    throw new Error('PROJECTS_GENERIC_LINKING_TARGET_ENV=backend-test is required');
  }
  assertTestTarget(frontendUrl, backendApiUrl, postgresContainer);
}

function assertTestTarget(frontend: string, backend: string, postgres: string) {
  const combined = `${frontend} ${backend} ${postgres} ${backendContainer} ${targetEnv}`;
  if (/prod|production|live/i.test(combined)) {
    throw new Error('Refusing to run Projects generic linking canary against prod/live target');
  }
  const parsedBackend = new URL(backend);
  expect(parsedBackend.hostname, 'Projects generic linking canary must target backend-test').toBe(
    'backend-test.mebelkz.app',
  );
  expect(parsedBackend.pathname.replace(/\/+$/, ''), 'Backend API path must be /api/v1').toBe(
    '/api/v1',
  );
  const parsedFrontend = new URL(frontend);
  expect(parsedFrontend.hostname, 'Projects canary frontend must target app-test').toBe(
    'app-test.mebelkz.app',
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
  };
}

function requireProjectsWriteRuntime(flags: RuntimeFlagSnapshot) {
  if (!flags.projectsEnabled || flags.projectsReadOnly) {
    throw new Error(
      'Projects canary requires backend-test already configured with BACKEND_ENABLE_PROJECTS=true and BACKEND_PROJECTS_READ_ONLY=false. This spec does not mutate runtime flags without a safe restart/reconfigure mechanism.',
    );
  }
}

function expectRuntimeFlagsUnchanged(before: RuntimeFlagSnapshot) {
  const after = captureRuntimeFlags();
  expect(after.projectsEnabled).toBe(before.projectsEnabled);
  expect(after.projectsReadOnly).toBe(before.projectsReadOnly);
}

function assertMigration013Applied() {
  const snapshot = psqlJson<MigrationPrecondition>(`
    SELECT json_build_object(
      'entityTypes', to_regclass('public.project_entity_types') IS NOT NULL,
      'entityLinks', to_regclass('public.project_entity_links') IS NOT NULL,
      'participantRoles', to_regclass('public.project_participant_roles') IS NOT NULL,
      'participants', to_regclass('public.project_participants') IS NOT NULL,
      'participantNumericConstraint', EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_project_participants_participant_id_numeric'
          AND conrelid = 'public.project_participants'::regclass
      )
    )::text;
  `);
  expect(snapshot.entityTypes).toBe(true);
  expect(snapshot.entityLinks).toBe(true);
  expect(snapshot.participantRoles).toBe(true);
  expect(snapshot.participants).toBe(true);
  expect(snapshot.participantNumericConstraint).toBe(true);
}

function discoverFixture(): FixturePreflight {
  const found = psqlJson<FixturePreflight>(`
    WITH fixture_order AS (
      SELECT o.order_id, o.order_name, o.client_id
      FROM public.orders o
      WHERE o.order_id = ${fixtureOrderId}
        AND o.order_name = '${sqlQuote(fixtureOrderName)}'
        AND COALESCE(o.delete_flag, false) = false
      LIMIT 1
    ),
    fixture_workshop AS (
      SELECT ow.workshop_id
      FROM public.order_workshops ow
      JOIN fixture_order fo ON fo.order_id = ow.order_id
      WHERE COALESCE(ow.delete_flag, false) = false
      ORDER BY ow.order_workshop_id
      LIMIT 1
    ),
    fixture_employee AS (
      SELECT COALESCE(
        (
          SELECT ow.responsible_employee_id
          FROM public.order_workshops ow
          JOIN fixture_order fo ON fo.order_id = ow.order_id
          WHERE COALESCE(ow.delete_flag, false) = false
            AND ow.responsible_employee_id IS NOT NULL
          ORDER BY ow.order_workshop_id
          LIMIT 1
        ),
        (
          SELECT e.employee_id
          FROM public.employees e
          WHERE COALESCE(e.is_active, true) = true
          ORDER BY e.employee_id
          LIMIT 1
        )
      ) AS employee_id
    )
    SELECT json_build_object(
      'orderId', fo.order_id,
      'orderName', fo.order_name,
      'clientId', fo.client_id,
      'workshopId', fw.workshop_id,
      'employeeId', fe.employee_id,
      'projectOrderLinksBefore', (
        SELECT count(*)::int
        FROM public.project_order_projects pop
        WHERE pop.order_id = fo.order_id
          AND pop.valid_to IS NULL
      )
    )::text
    FROM fixture_order fo
    CROSS JOIN fixture_workshop fw
    CROSS JOIN fixture_employee fe;
  `);

  expect(found.clientId, 'fixture order must have a client').toBeTruthy();
  expect(found.workshopId, 'fixture order must have at least one current workshop').toBeTruthy();
  expect(found.employeeId, 'fixture must have an employee candidate').toBeTruthy();
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
      code: `pgl_${runId}`,
      name: `Projects generic linking canary ${runId}`,
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

async function expectFrontendRuntimeConfigIfAvailable(request: APIRequestContext) {
  const response = await request.get(`${frontendUrl}/runtime-config.json`);
  if (response.status() === 401 || response.status() === 403 || response.status() === 404) return;
  await expectOk(response);
  const body = await response.json();
  if (body.features?.backendProjects !== undefined) {
    expect(body.features.backendProjects).toBe(true);
  }
}

async function expectPostRestoreProbe(
  request: APIRequestContext,
  token: string,
  flags: RuntimeFlagSnapshot,
) {
  const response = await request.get(`${backendApiUrl}/projects?page=1&pageSize=1`, {
    headers: authHeaders(token),
  });
  if (!flags.projectsEnabled) {
    expect(response.status()).toBe(503);
    return;
  }
  await expectOk(response);
}

async function getJson<T>(
  request: APIRequestContext,
  path: string,
  token: string,
): Promise<T> {
  const response = await request.get(`${backendApiUrl}${path}`, { headers: authHeaders(token) });
  await expectOk(response);
  return response.json() as Promise<T>;
}

async function putJson<T>(
  request: APIRequestContext,
  path: string,
  token: string,
  data: unknown,
): Promise<T> {
  const response = await request.put(`${backendApiUrl}${path}`, {
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
          'E2E Projects Generic Linking Canary',
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

      IF array_length(fixture_project_ids, 1) IS NULL THEN
        DELETE FROM public.notifications
        WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%';
        DELETE FROM public.outbox_events
        WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%'
           OR payload_json->>'fixtureKey' = '${sqlQuote(fixtureKey)}';
        DELETE FROM public.audit_log
        WHERE request_id LIKE '${sqlQuote(fixtureKey)}:%'
           OR metadata_json->>'idempotencyKey' LIKE '${sqlQuote(fixtureKey)}:%'
           OR metadata_json->>'reason' = '${sqlQuote(fixtureKey)}';
        DELETE FROM public.command_idempotency_keys
        WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%';
        RETURN;
      END IF;

      DELETE FROM public.notifications
      WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%';
      DELETE FROM public.outbox_events
      WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%'
         OR aggregate_id = ANY(ARRAY(SELECT unnest(fixture_project_ids)::text))
         OR payload_json->>'projectId' = ANY(ARRAY(SELECT unnest(fixture_project_ids)::text));
      DELETE FROM public.audit_log
      WHERE entity_type = 'project'
        AND entity_id = ANY(ARRAY(SELECT unnest(fixture_project_ids)::text));
      DELETE FROM public.command_idempotency_keys
      WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%';
      DELETE FROM public.project_participants
      WHERE project_id = ANY(fixture_project_ids);
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
      'projectParticipants', (
        SELECT count(*)::int
        FROM public.project_participants
        WHERE project_id IN (SELECT id FROM fixture_projects)
      ),
      'projectOrderProjects', (
        SELECT count(*)::int
        FROM public.project_order_projects
        WHERE order_id = ${fixtureOrderId}
          AND valid_to IS NULL
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
          AND entity_id IN (SELECT id::text FROM fixture_projects)
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

function expectRestored(proof: RestoreProof, label: string) {
  expect(proof.projectRows, label).toBe(0);
  expect(proof.projectEntityLinks, label).toBe(0);
  expect(proof.projectParticipants, label).toBe(0);
  expect(proof.commandIdempotencyKeys, label).toBe(0);
  expect(proof.auditLogRows, label).toBe(0);
  expect(proof.outboxEvents, label).toBe(0);
  expect(proof.notifications, label).toBe(0);
  if (fixture) {
    expect(proof.projectOrderProjects, label).toBe(fixture.projectOrderLinksBefore);
  }
}

function stripVolatileResponseFields<T extends Record<string, unknown>>(value: T): unknown {
  const clone = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  delete clone.requestId;
  delete clone.auditId;
  return clone;
}

function countByEntity(overview: ProjectOverviewResponse, entityType: string): number {
  return overview.linkedEntityCounts.find((entry) => entry.entityType === entityType)?.currentCount ?? 0;
}

function countByRole(overview: ProjectOverviewResponse, roleCode: string): number {
  return (
    overview.participants.currentSummary.find((entry) => entry.roleCode === roleCode)
      ?.participantCount ?? 0
  );
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
}

interface MigrationPrecondition {
  entityTypes: boolean;
  entityLinks: boolean;
  participantRoles: boolean;
  participants: boolean;
  participantNumericConstraint: boolean;
}

interface FixturePreflight {
  orderId: number;
  orderName: string;
  clientId: number;
  workshopId: number;
  employeeId: number;
  projectOrderLinksBefore: number;
}

interface RestoreProof {
  projectRows: number;
  projectEntityLinks: number;
  projectParticipants: number;
  projectOrderProjects: number;
  commandIdempotencyKeys: number;
  auditLogRows: number;
  outboxEvents: number;
  notifications: number;
}

interface SmokeUser {
  userId: number;
  username: string;
  password: string;
}

interface ProjectDto {
  id: string;
}

interface ProjectEntityLinksResponse {
  projectId: string;
  links: Array<{
    entityType: string;
    entityId: string;
    relationType: string;
  }>;
  requestId: string;
  auditId?: string;
}

interface ProjectParticipantsResponse {
  projectId: string;
  participants: Array<{
    participantType: string;
    participantId: string | null;
    role: { code: string; label: string };
  }>;
  requestId: string;
  auditId?: string;
}

interface ProjectOverviewResponse {
  linkedEntityCounts: Array<{
    entityType: string;
    currentCount: number;
  }>;
  participants: {
    currentSummary: Array<{
      roleCode: string;
      roleLabel: string;
      participantCount: number;
    }>;
  };
}
