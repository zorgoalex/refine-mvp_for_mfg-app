import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { setupWorkflowMockApi, type WorkflowMockDb } from './helpers/mockWorkflowApi';

const clientPhonesCutoverEnabled =
  process.env.VITE_USE_BACKEND_CLIENT_PHONES === 'true' &&
  process.env.VITE_USE_BACKEND_PRODUCTION_ACTIONS === 'true';

test.describe('Client phones backend cutover', () => {
  test.beforeEach(() => {
    test.skip(
      !clientPhonesCutoverEnabled,
      'Run with VITE_USE_BACKEND_PRODUCTION_ACTIONS=true VITE_USE_BACKEND_CLIENT_PHONES=true',
    );
  });

  test('uses /api/v1 client phones for create, update, and delete while keeping Hasura reads', async ({
    page,
  }) => {
    const graphqlQueries: string[] = [];
    const db = await setupWorkflowMockApi(page, undefined, {
      onGraphqlQuery(query) {
        graphqlQueries.push(query);
      },
    });
    const backendCalls = await routeClientPhonesApi(page, db);

    await page.goto('/clients/create');
    await fillText(page, 'client_name', 'E2E клиент backend phones');
    await fillText(page, 'notes', 'Проверка backend телефонов');
    await fillText(page, 'ref_key_1c', 'CLIENT-PHONE-BACKEND-E2E');

    const phonesCard = page.locator('.ant-card').filter({ hasText: 'Телефоны' });
    await phonesCard.getByRole('button', { name: 'Добавить' }).click();

    const addDialog = page.getByRole('dialog', { name: 'Добавить телефон' });
    await fillTextIn(addDialog, 'phone_number', '+7 701 123 4567');
    await selectAntdOption(page, formItem(addDialog, 'Тип телефона'), 'Мобильный');
    await addDialog.getByLabel('Основной номер').check();
    await addDialog.getByRole('button', { name: 'Добавить' }).click();

    await page.getByRole('button', { name: /save Сохранить/ }).click();

    await expect
      .poll(() => db.clients.find((row) => row.client_name === 'E2E клиент backend phones')?.client_id)
      .toBeTruthy();
    const client = db.clients.find((row) => row.client_name === 'E2E клиент backend phones')!;
    await expect.poll(() => db.client_phones.find((row) => row.client_id === client.client_id)).toMatchObject({
      phone_number: '+7 701 123 4567',
      phone_type: 'mobile',
      is_primary: true,
    });

    const phone = db.client_phones.find((row) => row.client_id === client.client_id)!;
    await page.goto(`/clients/edit/${client.client_id}`);
    await expect(phonesCard.getByText('+7 701 123 4567')).toBeVisible();

    const editPhonesCard = page.locator('.ant-card').filter({ hasText: 'Телефоны' });
    await editPhonesCard.locator('tr').filter({ hasText: '+7 701 123 4567' }).locator('button').first().click();
    const editDialog = page.getByRole('dialog', { name: 'Редактировать телефон' });
    await fillTextIn(editDialog, 'phone_number', '+7 702 765 4321');
    await selectAntdOption(page, formItem(editDialog, 'Тип телефона'), 'Рабочий');
    await editDialog.getByLabel('Основной номер').uncheck();
    await editDialog.getByRole('button', { name: 'Сохранить' }).click();

    await page.getByRole('button', { name: /save Сохранить/ }).click();
    await expect(page).toHaveURL(new RegExp(`/clients/show/${client.client_id}`));
    await expect.poll(() => db.client_phones.find((row) => row.phone_id === phone.phone_id)).toMatchObject({
      phone_number: '+7 702 765 4321',
      phone_type: 'work',
      is_primary: false,
    });

    await page.goto(`/clients/edit/${client.client_id}`);
    await editPhonesCard.locator('tr').filter({ hasText: '+7 702 765 4321' }).locator('button').nth(1).click();
    await page.getByRole('button', { name: 'Удалить' }).click();
    await page.getByRole('button', { name: /save Сохранить/ }).click();
    await expect.poll(() => db.client_phones.some((row) => row.phone_id === phone.phone_id)).toBe(false);

    expect(backendCalls).toContain('POST /api/v1/client-phones');
    expect(backendCalls).toContain(`PATCH /api/v1/client-phones/${phone.phone_id}`);
    expect(backendCalls).toContain(`DELETE /api/v1/client-phones/${phone.phone_id}`);
    expect(graphqlQueries.join('\n')).not.toMatch(/insert_client_phones|update_client_phones|delete_client_phones/);
  });

  test('does not fallback to Hasura when backend client phone create fails', async ({ page }) => {
    const graphqlQueries: string[] = [];
    await setupWorkflowMockApi(page, undefined, {
      onGraphqlQuery(query) {
        graphqlQueries.push(query);
      },
    });
    await page.route(/\/api\/v1\/client-phones$/, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Client phones API is disabled',
            requestId: 'request-disabled',
          },
        }),
      });
    });

    await page.goto('/clients/create');
    await fillText(page, 'client_name', 'E2E backend phone failure');

    const phonesCard = page.locator('.ant-card').filter({ hasText: 'Телефоны' });
    await phonesCard.getByRole('button', { name: 'Добавить' }).click();
    const addDialog = page.getByRole('dialog', { name: 'Добавить телефон' });
    await fillTextIn(addDialog, 'phone_number', '+7 701 111 2233');
    await addDialog.getByRole('button', { name: 'Добавить' }).click();
    await page.getByRole('button', { name: /save Сохранить/ }).click();

    await expect(page.getByText('Клиент создан, но телефоны не сохранены')).toBeVisible();
    expect(graphqlQueries.join('\n')).not.toMatch(/insert_client_phones|update_client_phones|delete_client_phones/);
  });
});

async function routeClientPhonesApi(page: Page, db: WorkflowMockDb): Promise<string[]> {
  const calls: string[] = [];
  await page.route(/\/api\/v1\/client-phones(?:\/\d+)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const phoneId = Number(url.pathname.match(/\/client-phones\/(\d+)$/)?.[1] ?? 0);
    calls.push(`${method} ${url.pathname}`);

    if (method === 'POST') {
      const body = JSON.parse(request.postData() || '{}');
      if (body.isPrimary === true) {
        for (const phone of db.client_phones.filter((item) => item.client_id === body.clientId)) {
          phone.is_primary = false;
        }
      }
      const phone = {
        phone_id: nextId(db.client_phones, 'phone_id'),
        client_id: body.clientId,
        phone_number: body.phoneNumber,
        phone_type: body.phoneType ?? 'mobile',
        is_primary: body.isPrimary === true,
        ref_key_1c: body.refKey1c ?? null,
        created_by: 1,
        edited_by: null,
        created_at: '2026-05-11T00:00:00.000Z',
        updated_at: null,
      };
      db.client_phones.push(phone);
      await fulfillJson(route, { phone: toBackendPhone(phone), requestId: 'request-create' });
      return;
    }

    if (method === 'PATCH') {
      const body = JSON.parse(request.postData() || '{}');
      const phone = db.client_phones.find((item) => item.phone_id === phoneId);
      if (!phone) {
        await fulfillJson(route, { error: { code: 'CLIENT_PHONE_NOT_FOUND', requestId: 'request-missing' } }, 404);
        return;
      }
      if (body.isPrimary === true) {
        for (const item of db.client_phones.filter((row) => row.client_id === phone.client_id && row.phone_id !== phoneId)) {
          item.is_primary = false;
        }
      }
      phone.phone_number = body.phoneNumber ?? phone.phone_number;
      phone.phone_type = body.phoneType ?? phone.phone_type;
      phone.is_primary = body.isPrimary ?? phone.is_primary;
      phone.ref_key_1c = body.refKey1c ?? phone.ref_key_1c ?? null;
      phone.edited_by = 1;
      phone.updated_at = '2026-05-11T00:00:00.000Z';
      await fulfillJson(route, { phone: toBackendPhone(phone), requestId: 'request-update' });
      return;
    }

    if (method === 'DELETE') {
      const index = db.client_phones.findIndex((item) => item.phone_id === phoneId);
      const [deleted] = index >= 0 ? db.client_phones.splice(index, 1) : [{ client_id: 0 }];
      await fulfillJson(route, {
        phoneId,
        clientId: deleted.client_id,
        deleted: true,
        requestId: 'request-delete',
      });
      return;
    }

    await fulfillJson(route, { error: { code: 'METHOD_NOT_ALLOWED' } }, 405);
  });

  return calls;
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function toBackendPhone(phone: Record<string, any>) {
  return {
    phoneId: phone.phone_id,
    clientId: phone.client_id,
    phoneNumber: phone.phone_number,
    phoneType: phone.phone_type,
    isPrimary: phone.is_primary,
    refKey1c: phone.ref_key_1c ?? null,
    createdBy: phone.created_by ?? null,
    editedBy: phone.edited_by ?? null,
    createdAt: phone.created_at ?? '2026-05-11T00:00:00.000Z',
    updatedAt: phone.updated_at ?? null,
  };
}

function nextId(rows: Record<string, any>[], idColumn: string): number {
  return rows.reduce((max, row) => Math.max(max, Number(row[idColumn] || 0)), 0) + 1;
}

async function fillText(page: Page, fieldId: string, value: string) {
  const input = page.locator(`#${fieldId}`);
  await input.click();
  await input.fill(value);
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
