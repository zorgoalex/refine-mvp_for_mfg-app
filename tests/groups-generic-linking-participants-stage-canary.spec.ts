import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const canaryEnabled = process.env.GROUPS_GENERIC_LINKING_STAGE_CANARY === 'true';
const fixtureKey = process.env.GROUPS_GENERIC_LINKING_FIXTURE_KEY?.trim() ?? '';
const targetEnv = process.env.GROUPS_GENERIC_LINKING_TARGET_ENV?.trim() ?? '';
const frontendUrl = trimTrailingSlash(
  process.env.GROUPS_GENERIC_LINKING_STAGE_FRONTEND_URL ?? 'https://app-test.mebelkz.app',
);
const backendApiUrl = trimTrailingSlash(
  process.env.GROUPS_GENERIC_LINKING_STAGE_BACKEND_API_URL ??
    'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.GROUPS_GENERIC_LINKING_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const backendContainer = process.env.GROUPS_GENERIC_LINKING_STAGE_BACKEND_CONTAINER?.trim() ?? '';
const fixtureOrderId = readNumberEnv('GROUPS_GENERIC_LINKING_FIXTURE_ORDER_ID');
const fixtureOrderName = process.env.GROUPS_GENERIC_LINKING_FIXTURE_ORDER_NAME?.trim() ?? '';

const missingPrerequisites = [
  fixtureKey ? null : 'GROUPS_GENERIC_LINKING_FIXTURE_KEY',
  targetEnv === 'backend-test' ? null : 'GROUPS_GENERIC_LINKING_TARGET_ENV=backend-test',
  process.env.GROUPS_GENERIC_LINKING_RESTORE === 'true'
    ? null
    : 'GROUPS_GENERIC_LINKING_RESTORE=true',
  frontendUrl ? null : 'GROUPS_GENERIC_LINKING_STAGE_FRONTEND_URL',
  backendApiUrl ? null : 'GROUPS_GENERIC_LINKING_STAGE_BACKEND_API_URL',
  postgresContainer ? null : 'GROUPS_GENERIC_LINKING_STAGE_POSTGRES_CONTAINER',
  backendContainer ? null : 'GROUPS_GENERIC_LINKING_STAGE_BACKEND_CONTAINER',
  fixtureOrderId ? null : 'GROUPS_GENERIC_LINKING_FIXTURE_ORDER_ID',
  fixtureOrderName ? null : 'GROUPS_GENERIC_LINKING_FIXTURE_ORDER_NAME',
  dockerContainerExists(postgresContainer) ? null : `docker container ${postgresContainer}`,
  backendContainer && dockerContainerExists(backendContainer)
    ? null
    : `docker container ${backendContainer || '<backend-container>'}`,
].filter((value): value is string => Boolean(value));

let fixture: FixturePreflight | null = null;

test.describe('Groups generic linking + participants stage canary', () => {
  test.skip(
    !canaryEnabled,
    'Set GROUPS_GENERIC_LINKING_STAGE_CANARY=true to enable this opt-in stage canary.',
  );
  test.skip(
    canaryEnabled && missingPrerequisites.length > 0,
    `Missing Groups generic linking canary prerequisites: ${missingPrerequisites.join(', ')}`,
  );
  test.setTimeout(240000);

  let runtimeFlags: RuntimeFlagSnapshot | null = null;
  let userIds: number[] = [];

  test.beforeAll(() => {
    requireCanaryEnv();
    runtimeFlags = captureRuntimeFlags();
    requireGroupsWriteRuntime(runtimeFlags);
    assertMigration013Applied();
    restoreFixtureRows();
    expectRestored(loadRestoreProof(), 'preflight restore');
    fixture = discoverFixture();
    expect(fixture.orderId).toBe(fixtureOrderId);
    expect(fixture.orderName).toBe(fixtureOrderName);
    expect(fixture.groupOrderLinksBefore).toBeGreaterThanOrEqual(0);
  });

  test.afterAll(() => {
    let restoreError: unknown;
    try {
      if (process.env.GROUPS_GENERIC_LINKING_RESTORE === 'true') {
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

    const admin = createSmokeUser(`e2e_groups_generic_admin_${runId}`, 2);
    const manager = createSmokeUser(`e2e_groups_generic_manager_${runId}`, 10);
    const topManager = createSmokeUser(`e2e_groups_generic_top_${runId}`, 15);
    userIds = [admin.userId, manager.userId, topManager.userId];

    const adminToken = await loginForApiToken(request, admin.username, admin.password);
    const managerToken = await loginForApiToken(request, manager.username, manager.password);
    const topManagerToken = await loginForApiToken(request, topManager.username, topManager.password);
    await expectFrontendRuntimeConfigIfAvailable(request);

    const group = await createGroup(request, adminToken, runId);
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

    const links = await putJson<GroupEntityLinksResponse>(
      request,
      `/groups/${group.id}/entity-links`,
      adminToken,
      linkPayload,
    );
    expect(links.groupId).toBe(group.id);
    expect(links.links).toHaveLength(4);
    expect(new Set(links.links.map((link) => link.entityType))).toEqual(
      new Set(['order', 'client', 'employee', 'workshop']),
    );

    const linksReplay = await putJson<GroupEntityLinksResponse>(
      request,
      `/groups/${group.id}/entity-links`,
      adminToken,
      linkPayload,
    );
    expect(stripVolatileResponseFields(linksReplay)).toEqual(stripVolatileResponseFields(links));

    const participants = await putJson<GroupParticipantsResponse>(
      request,
      `/groups/${group.id}/participants`,
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
    expect(participants.groupId).toBe(group.id);
    expect(participants.participants).toHaveLength(2);
    expect(participants.participants.map((participant) => participant.role.code).sort()).toEqual([
      'manager',
      'observer',
    ]);

    const participantsReplay = await putJson<GroupParticipantsResponse>(
      request,
      `/groups/${group.id}/participants`,
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

    const listedLinks = await getJson<GroupEntityLinksResponse>(
      request,
      `/groups/${group.id}/entity-links`,
      adminToken,
    );
    expect(listedLinks.links).toHaveLength(4);

    const listedParticipants = await getJson<GroupParticipantsResponse>(
      request,
      `/groups/${group.id}/participants`,
      adminToken,
    );
    expect(listedParticipants.participants).toHaveLength(2);

    const overview = await getJson<GroupOverviewResponse>(
      request,
      `/groups/${group.id}/overview`,
      adminToken,
    );
    expect(countByEntity(overview, 'order')).toBe(1);
    expect(countByEntity(overview, 'client')).toBe(1);
    expect(countByEntity(overview, 'employee')).toBe(1);
    expect(countByEntity(overview, 'workshop')).toBe(1);
    expect(countByRole(overview, 'manager')).toBe(1);
    expect(countByRole(overview, 'observer')).toBe(1);

    await expectStatus(
      request.put(`${backendApiUrl}/groups/${group.id}/entity-links`, {
        headers: authHeaders(managerToken),
        data: { ...linkPayload, idempotencyKey: `${fixtureKey}:no-manage-links:${runId}` },
      }),
      403,
      'manager without groups.manage_links cannot write entity links',
    );
    await expectStatus(
      request.put(`${backendApiUrl}/groups/${group.id}/entity-links`, {
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
      request.put(`${backendApiUrl}/groups/${group.id}/participants`, {
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
      'manager without groups.participants.manage cannot replace participants',
    );

    const proofBeforeRestore = loadRestoreProof();
    expect(proofBeforeRestore.groupRows).toBe(1);
    expect(proofBeforeRestore.groupEntityLinks).toBe(4);
    expect(proofBeforeRestore.groupParticipants).toBe(2);
    expect(proofBeforeRestore.commandIdempotencyKeys).toBeGreaterThanOrEqual(2);
    expect(proofBeforeRestore.groupOrderGroups).toBe(currentFixture.groupOrderLinksBefore);

    restoreFixtureRows();
    expectRestored(loadRestoreProof(), 'explicit restore');
    expectRuntimeFlagsUnchanged(runtimeFlags!);
    await expectPostRestoreProbe(request, adminToken, runtimeFlags!);
  });
});

function requireCanaryEnv() {
  if (process.env.GROUPS_GENERIC_LINKING_STAGE_CANARY !== 'true') {
    throw new Error('GROUPS_GENERIC_LINKING_STAGE_CANARY=true is required');
  }
  if (!fixtureKey) {
    throw new Error('GROUPS_GENERIC_LINKING_FIXTURE_KEY is required');
  }
  if (!fixtureOrderId) {
    throw new Error('GROUPS_GENERIC_LINKING_FIXTURE_ORDER_ID must be a positive integer');
  }
  if (!fixtureOrderName) {
    throw new Error('GROUPS_GENERIC_LINKING_FIXTURE_ORDER_NAME is required');
  }
  if (process.env.GROUPS_GENERIC_LINKING_RESTORE !== 'true') {
    throw new Error('GROUPS_GENERIC_LINKING_RESTORE=true is required');
  }
  if (targetEnv !== 'backend-test') {
    throw new Error('GROUPS_GENERIC_LINKING_TARGET_ENV=backend-test is required');
  }
  assertTestTarget(frontendUrl, backendApiUrl, postgresContainer);
}

function assertTestTarget(frontend: string, backend: string, postgres: string) {
  const combined = `${frontend} ${backend} ${postgres} ${backendContainer} ${targetEnv}`;
  if (/prod|production|live/i.test(combined)) {
    throw new Error('Refusing to run Groups generic linking canary against prod/live target');
  }
  const parsedBackend = new URL(backend);
  expect(parsedBackend.hostname, 'Groups generic linking canary must target backend-test').toBe(
    'backend-test.mebelkz.app',
  );
  expect(parsedBackend.pathname.replace(/\/+$/, ''), 'Backend API path must be /api/v1').toBe(
    '/api/v1',
  );
  const parsedFrontend = new URL(frontend);
  expect(parsedFrontend.hostname, 'Groups canary frontend must target app-test').toBe(
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
    groupsEnabled: envMap.get('BACKEND_ENABLE_GROUPS') === 'true',
    groupsReadOnly: envMap.get('BACKEND_GROUPS_READ_ONLY') !== 'false',
  };
}

function requireGroupsWriteRuntime(flags: RuntimeFlagSnapshot) {
  if (!flags.groupsEnabled || flags.groupsReadOnly) {
    throw new Error(
      'Groups canary requires backend-test already configured with BACKEND_ENABLE_GROUPS=true and BACKEND_GROUPS_READ_ONLY=false. This spec does not mutate runtime flags without a safe restart/reconfigure mechanism.',
    );
  }
}

function expectRuntimeFlagsUnchanged(before: RuntimeFlagSnapshot) {
  const after = captureRuntimeFlags();
  expect(after.groupsEnabled).toBe(before.groupsEnabled);
  expect(after.groupsReadOnly).toBe(before.groupsReadOnly);
}

function assertMigration013Applied() {
  const snapshot = psqlJson<MigrationPrecondition>(`
    SELECT json_build_object(
      'entityTypes', to_regclass('public.group_entity_types') IS NOT NULL,
      'entityLinks', to_regclass('public.group_entity_links') IS NOT NULL,
      'participantRoles', to_regclass('public.group_participant_roles') IS NOT NULL,
      'participants', to_regclass('public.group_participants') IS NOT NULL,
      'participantNumericConstraint', EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_group_participants_participant_id_numeric'
          AND conrelid = 'public.group_participants'::regclass
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
      'groupOrderLinksBefore', (
        SELECT count(*)::int
        FROM public.group_order_groups pop
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

async function createGroup(
  request: APIRequestContext,
  token: string,
  runId: string,
): Promise<GroupDto> {
  const response = await request.post(`${backendApiUrl}/groups`, {
    headers: authHeaders(token),
    data: {
      code: `pgl_${runId}`,
      name: `Groups generic linking canary ${runId}`,
      status: 'active',
      ownerUserId: null,
      metadata: { fixtureKey, runId },
    },
  });
  await expectOk(response);
  const body = await response.json();
  expect(body.group?.id).toBeTruthy();
  return body.group as GroupDto;
}

async function expectFrontendRuntimeConfigIfAvailable(request: APIRequestContext) {
  const response = await request.get(`${frontendUrl}/runtime-config.json`);
  if (response.status() === 401 || response.status() === 403 || response.status() === 404) return;
  await expectOk(response);
  const body = await response.json();
  if (body.features?.backendGroups !== undefined) {
    expect(body.features.backendGroups).toBe(true);
  }
}

async function expectPostRestoreProbe(
  request: APIRequestContext,
  token: string,
  flags: RuntimeFlagSnapshot,
) {
  const response = await request.get(`${backendApiUrl}/groups?page=1&pageSize=1`, {
    headers: authHeaders(token),
  });
  if (!flags.groupsEnabled) {
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
          'E2E Groups Generic Linking Canary',
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
      fixture_group_ids uuid[];
    BEGIN
      SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
      INTO fixture_group_ids
      FROM public.group_groups
      WHERE metadata->>'fixtureKey' = '${sqlQuote(fixtureKey)}';

      IF array_length(fixture_group_ids, 1) IS NULL THEN
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
         OR aggregate_id = ANY(ARRAY(SELECT unnest(fixture_group_ids)::text))
         OR payload_json->>'groupId' = ANY(ARRAY(SELECT unnest(fixture_group_ids)::text));
      DELETE FROM public.audit_log
      WHERE entity_type = 'group'
        AND entity_id = ANY(ARRAY(SELECT unnest(fixture_group_ids)::text));
      DELETE FROM public.command_idempotency_keys
      WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%';
      DELETE FROM public.group_participants
      WHERE group_id = ANY(fixture_group_ids);
      DELETE FROM public.group_entity_links
      WHERE group_id = ANY(fixture_group_ids);
      DELETE FROM public.group_members
      WHERE group_id = ANY(fixture_group_ids);
      DELETE FROM public.group_groups
      WHERE id = ANY(fixture_group_ids);
    END $$;
  `);
}

function loadRestoreProof(): RestoreProof {
  return psqlJson<RestoreProof>(`
    WITH fixture_groups AS (
      SELECT id
      FROM public.group_groups
      WHERE metadata->>'fixtureKey' = '${sqlQuote(fixtureKey)}'
    )
    SELECT json_build_object(
      'groupRows', (SELECT count(*)::int FROM fixture_groups),
      'groupEntityLinks', (
        SELECT count(*)::int
        FROM public.group_entity_links
        WHERE group_id IN (SELECT id FROM fixture_groups)
      ),
      'groupParticipants', (
        SELECT count(*)::int
        FROM public.group_participants
        WHERE group_id IN (SELECT id FROM fixture_groups)
      ),
      'groupOrderGroups', (
        SELECT count(*)::int
        FROM public.group_order_groups
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
        WHERE entity_type = 'group'
          AND entity_id IN (SELECT id::text FROM fixture_groups)
      ),
      'outboxEvents', (
        SELECT count(*)::int
        FROM public.outbox_events
        WHERE aggregate_id IN (SELECT id::text FROM fixture_groups)
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
  expect(proof.groupRows, label).toBe(0);
  expect(proof.groupEntityLinks, label).toBe(0);
  expect(proof.groupParticipants, label).toBe(0);
  expect(proof.commandIdempotencyKeys, label).toBe(0);
  expect(proof.auditLogRows, label).toBe(0);
  expect(proof.outboxEvents, label).toBe(0);
  expect(proof.notifications, label).toBe(0);
  if (fixture) {
    expect(proof.groupOrderGroups, label).toBe(fixture.groupOrderLinksBefore);
  }
}

function stripVolatileResponseFields<T extends Record<string, unknown>>(value: T): unknown {
  const clone = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  delete clone.requestId;
  delete clone.auditId;
  return clone;
}

function countByEntity(overview: GroupOverviewResponse, entityType: string): number {
  return overview.linkedEntityCounts.find((entry) => entry.entityType === entityType)?.currentCount ?? 0;
}

function countByRole(overview: GroupOverviewResponse, roleCode: string): number {
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
  groupsEnabled: boolean;
  groupsReadOnly: boolean;
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
  groupOrderLinksBefore: number;
}

interface RestoreProof {
  groupRows: number;
  groupEntityLinks: number;
  groupParticipants: number;
  groupOrderGroups: number;
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

interface GroupDto {
  id: string;
}

interface GroupEntityLinksResponse {
  groupId: string;
  links: Array<{
    entityType: string;
    entityId: string;
    relationType: string;
  }>;
  requestId: string;
  auditId?: string;
}

interface GroupParticipantsResponse {
  groupId: string;
  participants: Array<{
    participantType: string;
    participantId: string | null;
    role: { code: string; label: string };
  }>;
  requestId: string;
  auditId?: string;
}

interface GroupOverviewResponse {
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
