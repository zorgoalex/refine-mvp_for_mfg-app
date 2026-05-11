import { expect, test, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const canaryEnabled = process.env.CLIENT_PHONES_STAGE_CANARY === 'true';
const frontendUrl = trimTrailingSlash(
  process.env.CLIENT_PHONES_STAGE_FRONTEND_URL ??
    process.env.FRONTEND_STAGE_URL ??
    'https://stage.mebelkz.app',
);
const backendApiUrl = trimTrailingSlash(
  process.env.CLIENT_PHONES_STAGE_BACKEND_API_URL ??
    'https://backend.dev.mebelkz.app/api/v1',
);

test.describe('Client phones stage canary', () => {
  test.skip(!canaryEnabled, 'Run with CLIENT_PHONES_STAGE_CANARY=true');
  test.setTimeout(180000);

  let accessToken: string | null = null;
  let clientId: number | null = null;
  let clientName: string | null = null;
  let firstPhoneId: number | null = null;
  let secondPhoneId: number | null = null;
  let userId: number | null = null;

  test.afterEach(async ({ request }) => {
    await cleanupClientPhones(request, accessToken, [firstPhoneId, secondPhoneId]);
    cleanupClient(clientId, clientName);
    cleanupUser(userId);
  });

  test('creates, updates, demotes, and deletes client phones through backend with audit/outbox checks', async ({
    page,
    request,
  }) => {
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_test_client_phones_${runId}`;
    const password = crypto.randomBytes(24).toString('base64url');
    const startedAt = psql('SELECT now()::text;');
    clientName = `E2E-Тест StageSmoke ClientPhones ${runId}`;
    const firstPhoneCreateNumber = `+7 701 ${runId.slice(6, 9)} ${runId.slice(9, 13)}`;
    const firstPhoneUpdateNumber = `+7 702 ${runId.slice(6, 9)} ${runId.slice(9, 13)}`;
    const secondPhoneNumber = `+7 703 ${runId.slice(6, 9)} ${runId.slice(9, 13)}`;
    const demoteIdempotencyKey = `client-phone-stage-demote:${runId}`;
    const graphqlPhoneMutations: string[] = [];
    const clientPhoneApiCalls: string[] = [];

    await expectRuntimeConfig(request);

    userId = createSmokeUser(username, password);
    accessToken = await loginForApiToken(request, username, password);

    recordClientPhoneNetwork(page, clientPhoneApiCalls, graphqlPhoneMutations);
    await loginThroughUi(page, username, password);

    await page.goto(`${frontendUrl}/clients/create`, { waitUntil: 'domcontentloaded' });
    await page.locator('#client_name').fill(clientName);
    await page.locator('#notes').fill(`E2E-Тест client phones canary ${runId}`);
    await page.locator('#ref_key_1c').fill(`client-phone-stage-${runId}`);
    await openAddPhoneDialog(page);
    const createDialog = page.getByRole('dialog', { name: 'Добавить телефон' });
    await fillTextIn(createDialog, 'phone_number', firstPhoneCreateNumber);
    await selectAntdOption(page, formItem(createDialog, 'Тип телефона'), 'Мобильный');
    await createDialog.getByLabel('Основной номер').check();
    await createDialog.getByRole('button', { name: 'Добавить' }).click();

    const createResponsePromise = waitForClientPhoneApiResponse(page, 'POST');
    await page.getByRole('button', { name: /Сохранить/ }).click();
    const createResponse = await createResponsePromise;
    await expectOk(createResponse);
    const createBody = (await createResponse.json()) as ClientPhoneResponse;
    clientId = createBody.phone.clientId;
    firstPhoneId = createBody.phone.phoneId;
    expect(firstPhoneId).toBeGreaterThan(0);
    expect(clientId).toBeGreaterThan(0);
    expect(loadClientName(clientId)).toBe(clientName);

    await page.goto(`${frontendUrl}/clients/edit/${clientId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(firstPhoneCreateNumber)).toBeVisible({ timeout: 30000 });
    await openEditPhoneDialog(page, firstPhoneCreateNumber);
    const editDialog = page.getByRole('dialog', { name: 'Редактировать телефон' });
    await fillTextIn(editDialog, 'phone_number', firstPhoneUpdateNumber);
    await selectAntdOption(page, formItem(editDialog, 'Тип телефона'), 'Рабочий');
    await expect(editDialog.getByLabel('Основной номер')).toBeChecked();
    await editDialog.getByRole('button', { name: 'Сохранить' }).click();

    const updateResponsePromise = waitForClientPhoneApiResponse(page, 'PATCH', firstPhoneId);
    await page.getByRole('button', { name: /Сохранить/ }).click();
    const updateResponse = await updateResponsePromise;
    await expectOk(updateResponse);
    await expect(page).toHaveURL(new RegExp(`/clients/show/${clientId}`), { timeout: 30000 });

    const demoteRequest = {
      clientId,
      phoneNumber: secondPhoneNumber,
      phoneType: 'home',
      isPrimary: true,
      idempotencyKey: demoteIdempotencyKey,
    };
    const demoteResponse = await postJson<ClientPhoneResponse>(
      request,
      '/client-phones',
      accessToken,
      demoteRequest,
    );
    secondPhoneId = demoteResponse.phone.phoneId;
    expect(demoteResponse.demotedPhoneIds).toContain(firstPhoneId);

    const beforeReplay = loadDemotionSnapshot({
      clientId,
      firstPhoneId,
      secondPhoneId,
      demoteIdempotencyKey,
      startedAt,
    });
    expect(Number(beforeReplay.demoteAuditCount)).toBe(1);
    expect(Number(beforeReplay.demoteOutboxKeyCount)).toBe(1);
    expect(Number(beforeReplay.secondCreateOutboxKeyCount)).toBe(1);
    expect(Number(beforeReplay.completedCommandCount)).toBe(1);

    const replayResponse = await postJson<ClientPhoneResponse>(
      request,
      '/client-phones',
      accessToken,
      demoteRequest,
    );
    expect(replayResponse.phone.phoneId).toBe(secondPhoneId);
    expect(replayResponse.demotedPhoneIds).toEqual(demoteResponse.demotedPhoneIds);

    const afterReplay = loadDemotionSnapshot({
      clientId,
      firstPhoneId,
      secondPhoneId,
      demoteIdempotencyKey,
      startedAt,
    });
    expect(afterReplay).toEqual(beforeReplay);

    const activeSnapshot = loadActivePhonesSnapshot({
      clientId,
      firstPhoneId,
      secondPhoneId,
      startedAt,
    });
    expect(activeSnapshot.firstPhoneNumber).toBe(firstPhoneUpdateNumber);
    expect(activeSnapshot.firstPhoneType).toBe('work');
    expect(activeSnapshot.firstIsPrimary).toBe(false);
    expect(activeSnapshot.firstCreatedBy).toBe(userId);
    expect(activeSnapshot.firstEditedBy).toBe(userId);
    expect(activeSnapshot.secondPhoneNumber).toBe(secondPhoneNumber);
    expect(activeSnapshot.secondPhoneType).toBe('home');
    expect(activeSnapshot.secondIsPrimary).toBe(true);
    expect(activeSnapshot.secondCreatedBy).toBe(userId);
    expect(Number(activeSnapshot.primaryCount)).toBe(1);
    expect(Number(activeSnapshot.createAuditCount)).toBeGreaterThanOrEqual(2);
    expect(Number(activeSnapshot.updateAuditCount)).toBeGreaterThanOrEqual(1);
    expect(Number(activeSnapshot.missingRelatedClientAuditCount)).toBe(0);
    expect(Number(activeSnapshot.createdOutboxCount)).toBeGreaterThanOrEqual(2);
    expect(Number(activeSnapshot.updatedOutboxCount)).toBeGreaterThanOrEqual(1);

    await page.goto(`${frontendUrl}/clients/edit/${clientId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(firstPhoneUpdateNumber)).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(secondPhoneNumber)).toBeVisible({ timeout: 30000 });
    await deletePhoneInUi(page, firstPhoneUpdateNumber);
    await deletePhoneInUi(page, secondPhoneNumber);

    const deleteResponsesPromise = Promise.all([
      waitForClientPhoneApiResponse(page, 'DELETE', firstPhoneId),
      waitForClientPhoneApiResponse(page, 'DELETE', secondPhoneId),
    ]);
    await page.getByRole('button', { name: /Сохранить/ }).click();
    const deleteResponses = await deleteResponsesPromise;
    await Promise.all(deleteResponses.map(expectOk));
    await expect(page).toHaveURL(new RegExp(`/clients/show/${clientId}`), { timeout: 30000 });

    const deletedSnapshot = loadDeletedPhonesSnapshot({
      clientId,
      firstPhoneId,
      secondPhoneId,
      startedAt,
    });
    expect(deletedSnapshot.phoneRowsExist).toBe(false);
    expect(Number(deletedSnapshot.deleteAuditCount)).toBeGreaterThanOrEqual(2);
    expect(Number(deletedSnapshot.deletedOutboxCount)).toBeGreaterThanOrEqual(2);

    firstPhoneId = null;
    secondPhoneId = null;

    expect(clientPhoneApiCalls).toContain('POST /api/v1/client-phones');
    expect(clientPhoneApiCalls).toContain(`PATCH /api/v1/client-phones/${createBody.phone.phoneId}`);
    expect(clientPhoneApiCalls).toContain(`DELETE /api/v1/client-phones/${createBody.phone.phoneId}`);
    expect(clientPhoneApiCalls).toContain(`DELETE /api/v1/client-phones/${demoteResponse.phone.phoneId}`);
    expect(graphqlPhoneMutations).toEqual([]);
  });
});

async function expectRuntimeConfig(request: APIRequestContext) {
  const response = await request.get(`${frontendUrl}/runtime-config.json`);
  await expectOk(response);
  const runtimeConfig = await response.json();
  expect(runtimeConfig.features?.backendAuth).toBe(true);
  expect(runtimeConfig.features?.backendPermissions).toBe(true);
  expect(runtimeConfig.features?.backendPayments).toBe(true);
  expect(runtimeConfig.features?.backendProductionActions).toBe(true);
  expect(runtimeConfig.features?.backendClientPhones).toBe(true);
}

function recordClientPhoneNetwork(
  page: Page,
  clientPhoneApiCalls: string[],
  graphqlPhoneMutations: string[],
) {
  page.on('request', (request) => {
    const url = request.url();
    const method = request.method();

    if (url.includes('/api/v1/client-phones')) {
      clientPhoneApiCalls.push(`${method} ${new URL(url).pathname}`);
    }

    if (url.includes('/v1/graphql') && method === 'POST') {
      const body = request.postData() ?? '';
      if (/\b(?:insert|update|delete)_client_phones\b/.test(body)) {
        graphqlPhoneMutations.push(body.slice(0, 200));
      }
    }
  });
}

async function loginThroughUi(page: Page, username: string, password: string) {
  await page.goto(`${frontendUrl}/login`, { waitUntil: 'domcontentloaded' });
  const loginResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/v1/auth/login') &&
      response.request().method() === 'POST',
  );
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  const loginResponse = await loginResponsePromise;
  await expectOk(loginResponse);
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

function waitForClientPhoneApiResponse(page: Page, method: string, id?: number) {
  return page.waitForResponse((response) => {
    const url = response.url();
    if (!url.includes('/api/v1/client-phones')) return false;
    if (response.request().method() !== method) return false;

    return id === undefined || new URL(url).pathname.endsWith(`/client-phones/${id}`);
  });
}

async function postJson<T>(
  request: APIRequestContext,
  path: string,
  token: string | null,
  data: unknown,
): Promise<T> {
  const response = await request.post(`${backendApiUrl}${path}`, {
    headers: authHeaders(token),
    data,
  });
  await expectOk(response);
  return response.json() as Promise<T>;
}

async function deleteJson<T>(
  request: APIRequestContext,
  path: string,
  token: string | null,
  data: unknown,
): Promise<T | null> {
  const response = await request.delete(`${backendApiUrl}${path}`, {
    headers: authHeaders(token),
    data,
  });
  if (!response.ok()) return null;
  return response.json() as Promise<T>;
}

async function expectOk(response: APIResponse) {
  const body = response.ok() ? '' : await response.text();
  expect(response.ok(), body).toBe(true);
}

function authHeaders(token: string | null) {
  expect(token).toBeTruthy();
  return {
    Authorization: `Bearer ${token}`,
  };
}

async function openAddPhoneDialog(page: Page) {
  const phonesCard = page.locator('.ant-card').filter({ hasText: 'Телефоны' });
  await phonesCard.getByRole('button', { name: 'Добавить' }).click();
}

async function openEditPhoneDialog(page: Page, phoneNumber: string) {
  const phonesCard = page.locator('.ant-card').filter({ hasText: 'Телефоны' });
  await phonesCard.locator('tr').filter({ hasText: phoneNumber }).locator('button').first().click();
}

async function deletePhoneInUi(page: Page, phoneNumber: string) {
  const phonesCard = page.locator('.ant-card').filter({ hasText: 'Телефоны' });
  await phonesCard.locator('tr').filter({ hasText: phoneNumber }).locator('button').nth(1).click();
  await page.getByRole('button', { name: 'Удалить' }).click();
  await expect(phonesCard.getByText(phoneNumber)).toHaveCount(0);
}

async function fillTextIn(scope: Locator, fieldId: string, value: string) {
  const input = scope.locator(`#${fieldId}`);
  await input.click();
  await input.fill(value);
}

function formItem(scope: Locator, label: string) {
  return scope.locator('.ant-form-item').filter({ hasText: label });
}

async function selectAntdOption(page: Page, field: Locator, label: string) {
  await field.locator('.ant-select-selector').click();
  await page.getByTitle(label).last().click();
}

async function cleanupClientPhones(
  request: APIRequestContext,
  token: string | null,
  phoneIds: Array<number | null>,
) {
  for (const phoneId of phoneIds) {
    if (!phoneId || !phoneExists(phoneId)) continue;

    if (token) {
      await deleteJson<DeleteClientPhoneResponse>(
        request,
        `/client-phones/${phoneId}`,
        token,
        {
          idempotencyKey: `client-phone-stage-cleanup:${phoneId}:${Date.now()}`,
        },
      );
    }

    if (phoneExists(phoneId)) {
      psql(`DELETE FROM client_phones WHERE phone_id = ${Number(phoneId)};`);
    }
  }
}

function cleanupClient(id: number | null, name: string | null) {
  if (!id || !name || !isTestClientName(name)) return;

  psql(`
    DELETE FROM client_phones WHERE client_id = ${id};
    DELETE FROM clients
    WHERE client_id = ${id}
      AND client_name = '${sqlQuote(name)}';
  `);
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

function createSmokeUser(username: string, password: string): number {
  const email = `${username}@example.invalid`;
  const passwordHash = bcrypt.hashSync(password, 10);

  return Number(
    psql(`
      WITH inserted AS (
        INSERT INTO users (username, email, password_hash, role_id, full_name, is_active)
        VALUES (
          '${sqlQuote(username)}',
          '${sqlQuote(email)}',
          '${sqlQuote(passwordHash)}',
          1,
          'E2E Test Client Phones Stage Canary',
          true
        )
        RETURNING user_id
      )
      SELECT user_id FROM inserted;
    `),
  );
}

function loadClientName(id: number): string {
  return psql(`
    SELECT client_name
    FROM clients
    WHERE client_id = ${Number(id)};
  `);
}

function loadActivePhonesSnapshot(input: {
  clientId: number;
  firstPhoneId: number;
  secondPhoneId: number;
  startedAt: string;
}): ActivePhonesSnapshot {
  return psql<ActivePhonesSnapshot>(
    `
    SELECT json_build_object(
      'firstPhoneNumber', first_phone.phone_number,
      'firstPhoneType', first_phone.phone_type,
      'firstIsPrimary', first_phone.is_primary,
      'firstCreatedBy', first_phone.created_by,
      'firstEditedBy', first_phone.edited_by,
      'secondPhoneNumber', second_phone.phone_number,
      'secondPhoneType', second_phone.phone_type,
      'secondIsPrimary', second_phone.is_primary,
      'secondCreatedBy', second_phone.created_by,
      'primaryCount', (
        SELECT count(*) FROM client_phones
        WHERE client_id = ${Number(input.clientId)}
          AND is_primary = true
      ),
      'createAuditCount', (
        SELECT count(*) FROM audit_log
        WHERE event = 'client_phones.create'
          AND related_client_id = ${Number(input.clientId)}
          AND created_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
      ),
      'updateAuditCount', (
        SELECT count(*) FROM audit_log
        WHERE event = 'client_phones.update'
          AND entity_id = '${Number(input.firstPhoneId)}'
          AND related_client_id = ${Number(input.clientId)}
          AND created_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
      ),
      'missingRelatedClientAuditCount', (
        SELECT count(*) FROM audit_log
        WHERE event IN (
            'client_phones.create',
            'client_phones.update',
            'client_phones.primary_demote'
          )
          AND entity_id IN ('${Number(input.firstPhoneId)}', '${Number(input.secondPhoneId)}')
          AND related_client_id IS DISTINCT FROM ${Number(input.clientId)}
          AND created_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
      ),
      'createdOutboxCount', (
        SELECT count(*) FROM outbox_events
        WHERE event_type = 'client_phone.created'
          AND aggregate_id IN ('${Number(input.firstPhoneId)}', '${Number(input.secondPhoneId)}')
          AND created_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
      ),
      'updatedOutboxCount', (
        SELECT count(*) FROM outbox_events
        WHERE event_type = 'client_phone.updated'
          AND aggregate_id = '${Number(input.firstPhoneId)}'
          AND created_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
      )
    )::text
    FROM client_phones first_phone
    CROSS JOIN client_phones second_phone
    WHERE first_phone.phone_id = ${Number(input.firstPhoneId)}
      AND second_phone.phone_id = ${Number(input.secondPhoneId)};
    `,
    { json: true },
  );
}

function loadDemotionSnapshot(input: {
  clientId: number;
  firstPhoneId: number;
  secondPhoneId: number;
  demoteIdempotencyKey: string;
  startedAt: string;
}): DemotionSnapshot {
  return psql<DemotionSnapshot>(
    `
    SELECT json_build_object(
      'demoteAuditCount', (
        SELECT count(*) FROM audit_log
        WHERE event = 'client_phones.primary_demote'
          AND entity_id = '${Number(input.firstPhoneId)}'
          AND related_client_id = ${Number(input.clientId)}
          AND created_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
      ),
      'demoteOutboxKeyCount', (
        SELECT count(*) FROM outbox_events
        WHERE event_type = 'client_phone.primary_demoted'
          AND aggregate_id = '${Number(input.firstPhoneId)}'
          AND idempotency_key = '${sqlQuote(input.demoteIdempotencyKey)}:primary-demote:${Number(input.firstPhoneId)}'
      ),
      'secondCreateOutboxKeyCount', (
        SELECT count(*) FROM outbox_events
        WHERE event_type = 'client_phone.created'
          AND aggregate_id = '${Number(input.secondPhoneId)}'
          AND idempotency_key = '${sqlQuote(input.demoteIdempotencyKey)}'
      ),
      'completedCommandCount', (
        SELECT count(*) FROM command_idempotency_keys
        WHERE idempotency_key = '${sqlQuote(input.demoteIdempotencyKey)}'
          AND status = 'completed'
      )
    )::text;
    `,
    { json: true },
  );
}

function loadDeletedPhonesSnapshot(input: {
  clientId: number;
  firstPhoneId: number;
  secondPhoneId: number;
  startedAt: string;
}): DeletedPhonesSnapshot {
  return psql<DeletedPhonesSnapshot>(
    `
    SELECT json_build_object(
      'phoneRowsExist', EXISTS (
        SELECT 1 FROM client_phones
        WHERE phone_id IN (${Number(input.firstPhoneId)}, ${Number(input.secondPhoneId)})
      ),
      'deleteAuditCount', (
        SELECT count(*) FROM audit_log
        WHERE event = 'client_phones.delete'
          AND entity_id IN ('${Number(input.firstPhoneId)}', '${Number(input.secondPhoneId)}')
          AND related_client_id = ${Number(input.clientId)}
          AND created_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
      ),
      'deletedOutboxCount', (
        SELECT count(*) FROM outbox_events
        WHERE event_type = 'client_phone.deleted'
          AND aggregate_id IN ('${Number(input.firstPhoneId)}', '${Number(input.secondPhoneId)}')
          AND created_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
      )
    )::text;
    `,
    { json: true },
  );
}

function phoneExists(phoneId: number): boolean {
  return (
    psql(`
      SELECT EXISTS (
        SELECT 1 FROM client_phones WHERE phone_id = ${Number(phoneId)}
      );
    `) === 't'
  );
}

function isTestClientName(value: string): boolean {
  return value.startsWith('Тест') || value.startsWith('E2E-Тест') || value.startsWith('E2E');
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function psql<T>(sql: string, options: { json: true }): T;
function psql(sql: string, options?: { json?: false }): string;
function psql(sql: string, options: { json?: boolean } = {}): unknown {
  const output = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'erp_dev-postgresdb-1',
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

  if (!options.json) return output;
  if (!output) {
    throw new Error(`Expected JSON from SQL, got empty output for: ${sql.slice(0, 120)}`);
  }

  return JSON.parse(output);
}

interface ClientPhoneDto {
  phoneId: number;
  clientId: number;
  phoneNumber: string;
  phoneType: string;
  isPrimary: boolean;
}

interface ClientPhoneResponse {
  phone: ClientPhoneDto;
  demotedPhoneIds?: number[];
  requestId: string;
}

interface DeleteClientPhoneResponse {
  phoneId: number;
  clientId: number;
  deleted: true;
  requestId: string;
}

interface ActivePhonesSnapshot {
  firstPhoneNumber: string;
  firstPhoneType: string;
  firstIsPrimary: boolean;
  firstCreatedBy: number;
  firstEditedBy: number;
  secondPhoneNumber: string;
  secondPhoneType: string;
  secondIsPrimary: boolean;
  secondCreatedBy: number;
  primaryCount: string;
  createAuditCount: string;
  updateAuditCount: string;
  missingRelatedClientAuditCount: string;
  createdOutboxCount: string;
  updatedOutboxCount: string;
}

interface DemotionSnapshot {
  demoteAuditCount: string;
  demoteOutboxKeyCount: string;
  secondCreateOutboxKeyCount: string;
  completedCommandCount: string;
}

interface DeletedPhonesSnapshot {
  phoneRowsExist: boolean;
  deleteAuditCount: string;
  deletedOutboxCount: string;
}
