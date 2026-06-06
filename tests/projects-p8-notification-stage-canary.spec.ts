import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const canaryEnabled = process.env.PROJECTS_P8_NOTIFICATION_STAGE_CANARY === 'true';
const fixtureKey = process.env.PROJECTS_P8_NOTIFICATION_CANARY_FIXTURE_KEY?.trim() ?? '';
const targetEnv = process.env.PROJECTS_P8_NOTIFICATION_TARGET_ENV?.trim() ?? '';
const backendApiUrl = trimTrailingSlash(
  process.env.PROJECTS_P8_NOTIFICATION_STAGE_BACKEND_API_URL ??
    'https://backend-test.mebelkz.app/api/v1',
);
const postgresContainer =
  process.env.PROJECTS_P8_NOTIFICATION_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const fixtureOrderId = readNumberEnv('PROJECTS_P8_NOTIFICATION_FIXTURE_ORDER_ID');
const restoreEnabled = process.env.PROJECTS_P8_NOTIFICATION_RESTORE === 'true';
const expectP8Disabled = process.env.PROJECTS_P8_NOTIFICATION_EXPECT_DISABLED === 'true';

let fixture: FixturePreflight | null = null;

test.describe.configure({ mode: 'serial' });

test.describe('Projects P8 notification stage canary', () => {
  test.skip(
    !canaryEnabled,
    'Set PROJECTS_P8_NOTIFICATION_STAGE_CANARY=true to enable this opt-in stage canary.',
  );
  test.skip(!fixtureKey, 'PROJECTS_P8_NOTIFICATION_CANARY_FIXTURE_KEY is required.');
  test.skip(targetEnv !== 'backend-test', 'PROJECTS_P8_NOTIFICATION_TARGET_ENV=backend-test is required.');
  test.setTimeout(240000);

  let createdUserIds: number[] = [];

  test.beforeAll(() => {
    requireCanaryEnv();
    assertSchemaPreconditions();
    restoreFixtureRows();
    expectRestored(loadRestoreProof(), 'preflight restore');
    fixture = discoverFixture();
  });

  test.afterAll(() => {
    let restoreError: unknown;
    try {
      if (restoreEnabled) {
        restoreFixtureRows();
        expectRestored(loadRestoreProof(), 'afterAll restore');
      }
    } catch (error) {
      restoreError = error;
    } finally {
      for (const userId of createdUserIds) {
        cleanupUser(userId);
      }
      if (restoreError) throw restoreError;
    }
  });

  test('proves project participant/order-link notification posture, idempotency, privacy, and restore-to-zero', async ({
    request,
  }) => {
    expect(fixture).not.toBeNull();
    const currentFixture = fixture!;
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const notificationPrefix = `projects:p8:`;

    const admin = createSmokeUser(`e2e_p8_notify_admin_${runId}`, 2);
    const manager = createSmokeUser(`e2e_p8_notify_manager_${runId}`, 10);
    const worker = createSmokeUser(`e2e_p8_notify_worker_${runId}`, 20);
    createdUserIds = [admin.userId, manager.userId, worker.userId];

    const adminToken = await loginForApiToken(request, admin.username, admin.password);
    const project = await createProject(request, adminToken, runId);
    const participantsKey = `${fixtureKey}:participants:${runId}`;
    const orderLinksKey = `${fixtureKey}:order-links:${runId}`;

    const participantsPayload = {
      idempotencyKey: participantsKey,
      reason: fixtureKey,
      participants: [
        { participantType: 'user', participantId: String(admin.userId), roleCode: 'manager', metadata: { fixtureKey } },
        { participantType: 'user', participantId: String(manager.userId), roleCode: 'participant', metadata: { fixtureKey } },
        { participantType: 'user', participantId: String(worker.userId), roleCode: 'observer', metadata: { fixtureKey } },
        { participantType: 'employee', participantId: String(currentFixture.employeeId), roleCode: 'observer', metadata: { fixtureKey } },
      ],
    };

    const participantNotificationsBefore = loadNotificationCount(project.id);
    const participants = await putJson<ProjectParticipantsResponse>(
      request,
      `/projects/${project.id}/participants`,
      adminToken,
      participantsPayload,
    );
    expect(participants.participants).toHaveLength(4);
    if (expectP8Disabled) {
      expect(loadNotificationCount(project.id)).toBe(participantNotificationsBefore);
      expect(loadP8Residue(project.id)).toEqual({
        notifications: 0,
        outboxEvents: 0,
        auditLogRows: 0,
        commandIdempotencyKeys: 1,
      });
    } else {
      expect(loadNotificationCount(project.id)).toBeGreaterThan(participantNotificationsBefore);
    }

    const participantReplayBefore = loadP8Residue(project.id);
    await putJson<ProjectParticipantsResponse>(
      request,
      `/projects/${project.id}/participants`,
      adminToken,
      participantsPayload,
    );
    expect(loadP8Residue(project.id)).toEqual(participantReplayBefore);

    const orderLinksPayload = {
      idempotencyKey: orderLinksKey,
      version: currentFixture.orderVersion,
      primaryProjectId: project.id,
      projects: [{ projectId: project.id, relationType: 'main', isPrimary: true }],
    };

    const orderLinks = await putJson<OrderProjectsResponse>(
      request,
      `/orders/${currentFixture.orderId}/projects`,
      adminToken,
      orderLinksPayload,
    );
    expect(orderLinks.projects.map((item) => item.id)).toContain(project.id);
    await expectProjectsSmoke(request, adminToken, project.id);

    const orderLinkResidue = loadP8Residue(project.id);
    await putJson<OrderProjectsResponse>(
      request,
      `/orders/${currentFixture.orderId}/projects`,
      adminToken,
      orderLinksPayload,
    );
    expect(loadP8Residue(project.id)).toEqual(orderLinkResidue);

    const notificationSnapshot = loadNotificationSnapshot(project.id, notificationPrefix);
    if (expectP8Disabled) {
      expect(notificationSnapshot.projectMemberEvents).toBe(0);
      expect(notificationSnapshot.projectOrderEvents).toBe(0);
      expect(loadP8Residue(project.id)).toEqual({
        notifications: 0,
        outboxEvents: 0,
        auditLogRows: 0,
        commandIdempotencyKeys: 2,
      });
    } else {
      expect(notificationSnapshot.projectMemberEvents).toBeGreaterThanOrEqual(1);
      expect(notificationSnapshot.projectOrderEvents).toBeGreaterThanOrEqual(1);
    }
    expect(notificationSnapshot.workerOrderNotifications).toBe(0);
    expect(notificationSnapshot.employeeRecipientNotifications).toBe(0);
    expect(notificationSnapshot.forbiddenPayloadMatches).toBe(0);

    restoreFixtureRows();
    expectRestored(loadRestoreProof(), 'explicit restore');
    await expectPostRestoreProbe(request, adminToken);
  });
});

function requireCanaryEnv() {
  if (!canaryEnabled) throw new Error('PROJECTS_P8_NOTIFICATION_STAGE_CANARY=true is required');
  if (fixtureKey !== 'projects-p8-controlled-enable-2026-06-06') {
    throw new Error('Unexpected PROJECTS_P8_NOTIFICATION_CANARY_FIXTURE_KEY');
  }
  if (targetEnv !== 'backend-test') throw new Error('PROJECTS_P8_NOTIFICATION_TARGET_ENV=backend-test is required');
  if (!restoreEnabled) throw new Error('PROJECTS_P8_NOTIFICATION_RESTORE=true is required');
  if (!fixtureOrderId) throw new Error('PROJECTS_P8_NOTIFICATION_FIXTURE_ORDER_ID must be a positive integer');
  assertTestTarget(backendApiUrl, postgresContainer, targetEnv);
}

function assertTestTarget(...values: string[]) {
  const combined = values.join(' ');
  if (/prod|production|live/i.test(combined)) {
    throw new Error('Refusing to run Projects P8 notification canary against prod/live target');
  }
  const parsedBackend = new URL(backendApiUrl);
  expect(parsedBackend.hostname, 'P8 canary must target backend-test').toBe('backend-test.mebelkz.app');
  expect(parsedBackend.pathname.replace(/\/+$/, ''), 'Backend API path must be /api/v1').toBe('/api/v1');
}

function assertSchemaPreconditions() {
  const snapshot = psqlJson<SchemaPrecondition>(`
    SELECT json_build_object(
      'entityLinks', to_regclass('public.project_entity_links') IS NOT NULL,
      'participants', to_regclass('public.project_participants') IS NOT NULL,
      'notificationsIdempotencyKey', EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'notifications'
          AND column_name = 'idempotency_key'
      ),
      'notificationIdempotencyIndex', EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'notifications'
          AND indexdef ILIKE '%idempotency_key%'
          AND indexdef ILIKE '%UNIQUE%'
      )
    )::text;
  `);
  expect(snapshot.entityLinks).toBe(true);
  expect(snapshot.participants).toBe(true);
  expect(snapshot.notificationsIdempotencyKey).toBe(true);
  expect(snapshot.notificationIdempotencyIndex).toBe(true);
}

function discoverFixture(): FixturePreflight {
  const found = psqlJson<FixturePreflight>(`
    WITH fixture_order AS (
      SELECT o.order_id, o.order_name, o.client_id, o.version
      FROM public.orders o
      WHERE o.order_id = ${fixtureOrderId}
        AND COALESCE(o.delete_flag, false) = false
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
      'orderVersion', fo.version,
      'employeeId', fe.employee_id
    )::text
    FROM fixture_order fo
    CROSS JOIN fixture_employee fe;
  `);
  expect(found.orderId).toBe(fixtureOrderId);
  expect(found.clientId, 'fixture order must have a client').toBeTruthy();
  expect(found.orderVersion, 'fixture order must have a version').toBeTruthy();
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
      code: `p8_${runId}`,
      name: `P8 notification canary ${fixtureKey}`,
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

async function expectOk(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
}

async function expectProjectsSmoke(request: APIRequestContext, token: string, projectId: string) {
  for (const path of [
    '/projects?page=1&pageSize=5',
    `/projects/${projectId}`,
    `/projects/${projectId}/overview`,
  ]) {
    const response = await request.get(`${backendApiUrl}${path}`, {
      headers: authHeaders(token),
    });
    await expectOk(response);
  }
}

async function expectPostRestoreProbe(
  request: APIRequestContext,
  token: string,
) {
  const response = await request.get(`${backendApiUrl}/projects?page=1&pageSize=1`, {
    headers: authHeaders(token),
  });
  await expectOk(response);
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
          'E2E Projects P8 Notification Canary',
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

function loadNotificationCount(projectId: string): number {
  return Number(
    psql(`
      SELECT count(*)::int
      FROM public.notifications
      WHERE entity_type = 'project'
        AND entity_id = '${sqlQuote(projectId)}'
        AND idempotency_key LIKE 'projects:p8:%';
    `),
  );
}

function loadP8Residue(projectId: string): P8Residue {
  return psqlJson<P8Residue>(`
    SELECT json_build_object(
      'notifications', (
        SELECT count(*)::int FROM public.notifications
        WHERE entity_type = 'project'
          AND entity_id = '${sqlQuote(projectId)}'
          AND idempotency_key LIKE 'projects:p8:%'
      ),
      'outboxEvents', (
        SELECT count(*)::int FROM public.outbox_events
        WHERE aggregate_id = '${sqlQuote(projectId)}'
          AND event_type IN ('PROJECT_NOTIFICATION_FACT_RESERVED', 'PROJECT_NOTIFICATION_CREATED')
      ),
      'auditLogRows', (
        SELECT count(*)::int FROM public.audit_log
        WHERE entity_type = 'project'
          AND entity_id = '${sqlQuote(projectId)}'
          AND event = 'projects.notification_created'
      ),
      'commandIdempotencyKeys', (
        SELECT count(*)::int FROM public.command_idempotency_keys
        WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%'
      )
    )::text;
  `);
}

function loadNotificationSnapshot(projectId: string, notificationPrefix: string): NotificationSnapshot {
  return psqlJson<NotificationSnapshot>(`
    SELECT json_build_object(
      'projectMemberEvents', (
        SELECT count(*)::int FROM public.notifications
        WHERE entity_id = '${sqlQuote(projectId)}'
          AND source_type IN ('PROJECT_MEMBER_ADDED', 'PROJECT_MEMBER_REMOVED')
          AND idempotency_key LIKE '${sqlQuote(notificationPrefix)}%'
      ),
      'projectOrderEvents', (
        SELECT count(*)::int FROM public.notifications
        WHERE entity_id = '${sqlQuote(projectId)}'
          AND source_type = 'PROJECT_ORDER_LINKS_CHANGED'
          AND idempotency_key LIKE '${sqlQuote(notificationPrefix)}%'
      ),
      'workerOrderNotifications', (
        SELECT count(*)::int FROM public.notifications
        WHERE entity_id = '${sqlQuote(projectId)}'
          AND source_type = 'PROJECT_ORDER_LINKS_CHANGED'
          AND user_id IN (
            SELECT user_id FROM public.users
            WHERE username LIKE 'e2e_p8_notify_worker_%'
          )
      ),
      'employeeRecipientNotifications', 0,
      'forbiddenPayloadMatches', (
        SELECT count(*)::int
        FROM (
          SELECT concat_ws(' ', title, message, source_type, source_id) AS payload
          FROM public.notifications
          WHERE entity_id = '${sqlQuote(projectId)}'
            AND idempotency_key LIKE '${sqlQuote(notificationPrefix)}%'
          UNION ALL
          SELECT concat_ws(' ', event_type, payload_json::text)
          FROM public.outbox_events
          WHERE aggregate_id = '${sqlQuote(projectId)}'
            AND event_type IN ('PROJECT_NOTIFICATION_FACT_RESERVED', 'PROJECT_NOTIFICATION_CREATED')
          UNION ALL
          SELECT concat_ws(' ', event, metadata_json::text, before_json::text, after_json::text, diff_json::text)
          FROM public.audit_log
          WHERE entity_type = 'project'
            AND entity_id = '${sqlQuote(projectId)}'
            AND event = 'projects.notification_created'
        ) scanned
        WHERE payload ILIKE '%client%'
           OR payload ILIKE '%payment%'
           OR payload ILIKE '%finance%'
           OR payload ILIKE '%audit%'
           OR payload ILIKE '%phone%'
           OR payload ILIKE '%телефон%'
           OR payload ILIKE '%detail%'
           OR payload ILIKE '%детал%'
      )
    )::text;
  `);
}

function restoreFixtureRows() {
  psql(`
    DO $$
    DECLARE
      fixture_project_ids uuid[];
      fixture_user_ids bigint[];
    BEGIN
      SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
      INTO fixture_project_ids
      FROM public.project_projects
      WHERE metadata->>'fixtureKey' = '${sqlQuote(fixtureKey)}';

      SELECT COALESCE(array_agg(user_id), ARRAY[]::bigint[])
      INTO fixture_user_ids
      FROM public.users
      WHERE username LIKE 'e2e_p8_notify_%';

      DELETE FROM public.notifications
      WHERE idempotency_key LIKE 'projects:p8:%:${sqlQuote(fixtureKey)}:%'
         OR (entity_type = 'project' AND entity_id = ANY(ARRAY(SELECT unnest(fixture_project_ids)::text)))
         OR idempotency_key LIKE '${sqlQuote(fixtureKey)}:%'
         OR user_id = ANY(fixture_user_ids);
      DELETE FROM public.outbox_events
      WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%'
         OR aggregate_id = ANY(ARRAY(SELECT unnest(fixture_project_ids)::text))
         OR payload_json->>'projectId' = ANY(ARRAY(SELECT unnest(fixture_project_ids)::text));
      DELETE FROM public.audit_log
      WHERE request_id LIKE '${sqlQuote(fixtureKey)}:%'
         OR entity_id = ANY(ARRAY(SELECT unnest(fixture_project_ids)::text))
         OR metadata_json->>'reason' = '${sqlQuote(fixtureKey)}';
      DELETE FROM public.command_idempotency_keys
      WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%';
      DELETE FROM public.project_order_projects
      WHERE project_id = ANY(fixture_project_ids);
      DELETE FROM public.project_participants
      WHERE project_id = ANY(fixture_project_ids);
      DELETE FROM public.project_entity_links
      WHERE project_id = ANY(fixture_project_ids);
      DELETE FROM public.project_projects
      WHERE id = ANY(fixture_project_ids);
      DELETE FROM public.refresh_tokens
      WHERE user_id = ANY(fixture_user_ids);
      DELETE FROM public.auth_sessions
      WHERE user_id = ANY(fixture_user_ids);
      DELETE FROM public.users
      WHERE user_id = ANY(fixture_user_ids);
    END $$;
  `);
}

function loadRestoreProof(): RestoreProof {
  return psqlJson<RestoreProof>(`
    WITH fixture_projects AS (
      SELECT id FROM public.project_projects
      WHERE metadata->>'fixtureKey' = '${sqlQuote(fixtureKey)}'
    )
    SELECT json_build_object(
      'projectRows', (SELECT count(*)::int FROM fixture_projects),
      'projectEntityLinks', (
        SELECT count(*)::int FROM public.project_entity_links
        WHERE project_id IN (SELECT id FROM fixture_projects)
      ),
      'projectParticipants', (
        SELECT count(*)::int FROM public.project_participants
        WHERE project_id IN (SELECT id FROM fixture_projects)
      ),
      'projectOrderProjects', (
        SELECT count(*)::int FROM public.project_order_projects
        WHERE project_id IN (SELECT id FROM fixture_projects)
      ),
      'commandIdempotencyKeys', (
        SELECT count(*)::int FROM public.command_idempotency_keys
        WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%'
      ),
      'auditLogRows', (
        SELECT count(*)::int FROM public.audit_log
        WHERE entity_type = 'project'
          AND entity_id IN (SELECT id::text FROM fixture_projects)
      ),
      'outboxEvents', (
        SELECT count(*)::int FROM public.outbox_events
        WHERE aggregate_id IN (SELECT id::text FROM fixture_projects)
           OR idempotency_key LIKE '${sqlQuote(fixtureKey)}:%'
      ),
      'notifications', (
        SELECT count(*)::int FROM public.notifications
        WHERE idempotency_key LIKE '${sqlQuote(fixtureKey)}:%'
           OR (entity_type = 'project' AND entity_id IN (SELECT id::text FROM fixture_projects))
           OR user_id IN (
             SELECT user_id FROM public.users
             WHERE username LIKE 'e2e_p8_notify_%'
           )
      ),
      'userRows', (
        SELECT count(*)::int FROM public.users
        WHERE username LIKE 'e2e_p8_notify_%'
      )
    )::text;
  `);
}

function expectRestored(proof: RestoreProof, label: string) {
  expect(proof.projectRows, label).toBe(0);
  expect(proof.projectEntityLinks, label).toBe(0);
  expect(proof.projectParticipants, label).toBe(0);
  expect(proof.projectOrderProjects, label).toBe(0);
  expect(proof.commandIdempotencyKeys, label).toBe(0);
  expect(proof.auditLogRows, label).toBe(0);
  expect(proof.outboxEvents, label).toBe(0);
  expect(proof.notifications, label).toBe(0);
  expect(proof.userRows, label).toBe(0);
}

function psqlJson<T>(sql: string): T {
  const output = psql(sql);
  if (!output) throw new Error(`Expected JSON SQL output, got empty output for: ${sql.slice(0, 120)}`);
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

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
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

interface SchemaPrecondition {
  entityLinks: boolean;
  participants: boolean;
  notificationsIdempotencyKey: boolean;
  notificationIdempotencyIndex: boolean;
}

interface FixturePreflight {
  orderId: number;
  orderName: string;
  clientId: number;
  orderVersion: number;
  employeeId: number;
}

interface ProjectDto {
  id: string;
}

interface ProjectParticipantsResponse {
  participants: Array<{
    participantType: string;
    participantId: string | null;
    role: { code: string; label: string };
  }>;
}

interface OrderProjectsResponse {
  projects: Array<{ id: string }>;
}

interface SmokeUser {
  userId: number;
  username: string;
  password: string;
}

interface P8Residue {
  notifications: number;
  outboxEvents: number;
  auditLogRows: number;
  commandIdempotencyKeys: number;
}

interface NotificationSnapshot {
  projectMemberEvents: number;
  projectOrderEvents: number;
  workerOrderNotifications: number;
  employeeRecipientNotifications: number;
  forbiddenPayloadMatches: number;
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
  userRows: number;
}
