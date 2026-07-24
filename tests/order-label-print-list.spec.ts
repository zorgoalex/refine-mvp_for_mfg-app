import { expect, test, type Page } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi, type WorkflowMockDb } from './helpers/mockWorkflowApi';

const ORDER_ID = 101;
const LABEL_COUNT = 22;
const VALID_AUTH_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwidXNlcm5hbWUiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiIsImh0dHBzOi8vaGFzdXJhLmlvL2p3dC9jbGFpbXMiOnsiWC1IYXN1cmEtQWxsb3dlZC1Sb2xlcyI6WyJhZG1pbiJdLCJYLUhhc3VyYS1EZWZhdWx0LVJvbGUiOiJhZG1pbiIsIlgtSGFzdXJhLVVzZXItSWQiOiIxIn0sImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ.test';

test('order latest labels show an explicit 22-item list, navigate, and invoke print', async ({ page }) => {
  const diagnostics: string[] = [];
  page.on('console', (message) => diagnostics.push(`console:${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => diagnostics.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));
  const db = createOrderWithLabelsDb();
  const latestApiCalls: string[] = [];
  await setupWorkflowMockApi(page, db, {
    runtimeConfig: {
      backendAuth: true,
      backendPermissions: true,
      labels: true,
    },
  });
  await setupLabelPermissions(page);
  await setupLatestLabelsApi(page, LABEL_COUNT, latestApiCalls);
  await installIframePrintProbe(page);

  await page.goto(`/orders/show/${ORDER_ID}`);
  await page.getByRole('tab', { name: 'Дополнительная информация' }).click();

  await expect(page.getByText('Последняя генерация: 22 шт.')).toBeVisible({ timeout: 15000 }).catch(async (error) => {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    throw new Error([
      error instanceof Error ? error.message : String(error),
      `url=${page.url()}`,
      `latestApiCalls=${latestApiCalls.join(',') || 'none'}`,
      `body=${bodyText.slice(0, 5000)}`,
      diagnostics.slice(-40).join('\n'),
    ].filter(Boolean).join('\n\n'));
  });
  const listPanel = page.locator('.order-label-pages-viewer__list-panel');
  await expect(listPanel.getByText('Список бирок')).toBeVisible();
  await expect(listPanel.getByText('22 шт.')).toBeVisible();
  await expect(page.locator('.order-label-pages-viewer__list-button')).toHaveCount(22);

  await expect(page.getByText('Бирка 1 из 22')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Предыдущая' })).toBeDisabled();
  await page.getByRole('button', { name: 'Следующая' }).click();
  await expect(page.getByText('Бирка 2 из 22')).toBeVisible();

  await page.locator('.order-label-pages-viewer__list-button', { hasText: 'Бирка 22' }).click();
  await expect(page.getByText('Бирка 22 из 22')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Следующая' })).toBeDisabled();
  await page.getByRole('button', { name: 'Предыдущая' }).click();
  await expect(page.getByText('Бирка 21 из 22')).toBeVisible();

  await page.locator('.order-label-pages-viewer-wrap').getByRole('button', { name: 'Печать' }).click();
  await expect(page.locator('iframe[title="Заказ 101 — последняя генерация бирок #7"]')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __labelPrintCalled?: boolean }).__labelPrintCalled)).toBe(true);
});

test('order edit labels preview follows the clicked detail row', async ({ page }) => {
  const db = createOrderWithLabelsDb();
  db.order_details.push(
    orderDetail({ detail_id: 1001, detail_number: 1, detail_name: 'Планка A', quantity: 2 }),
    orderDetail({ detail_id: 1002, detail_number: 2, detail_name: 'Фасад B', quantity: 1 }),
    orderDetail({ detail_id: 1003, detail_number: 3, detail_name: 'Полка C', quantity: 3 }),
  );
  await setupWorkflowMockApi(page, db, {
    runtimeConfig: {
      backendAuth: true,
      backendPermissions: true,
      labels: true,
      useBackendOrdersRead: true,
      useBackendOrdersWrite: true,
    },
  });
  await setupLabelPermissions(page);
  await setupLabelTemplatesApi(page);
  await setupOrderLabelDataApi(page);
  await setupLatestLabelsApi(page, 6, []);

  await page.goto(`/orders/edit/${ORDER_ID}?tab=additional`);

  await expect(page.getByText('Последняя генерация: 6 шт.')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('SVG detail 1001 copy 1')).toBeVisible();
  await expect(page.getByText('Бирка 1 из 6')).toBeVisible();

  await page.getByRole('row', { name: /Фасад B/ }).click();
  await expect(page.getByText('Выбрана для предпросмотра: Позиция 2: Фасад B')).toBeVisible();
  await expect(page.getByText('SVG detail 1002 copy 1')).toBeVisible();
  await expect(page.getByText('Бирка 3 из 6')).toBeVisible();
  await expect(page.getByText('SVG detail 1001 copy 1')).toBeHidden();

  await page.getByRole('row', { name: /Полка C/ }).click();
  await expect(page.getByText('Выбрана для предпросмотра: Позиция 3: Полка C')).toBeVisible();
  await expect(page.getByText('SVG detail 1003 copy 1')).toBeVisible();
  await expect(page.getByText('Бирка 4 из 6')).toBeVisible();

  await page.getByRole('button', { name: 'Следующая' }).click();
  await expect(page.getByText('SVG detail 1003 copy 2')).toBeVisible();
  await expect(page.getByText('Бирка 5 из 6')).toBeVisible();
});

function createOrderWithLabelsDb(): WorkflowMockDb {
  const db = createWorkflowMockDb();
  db.orders.push({
    order_id: ORDER_ID,
    order_name: 'PW-LABELS-101',
    client_id: 1,
    order_date: '2026-07-24',
    order_status_id: 1,
    payment_status_id: 1,
    production_status_id: 1,
    priority: 100,
    discount: 0,
    surcharge: 0,
    manager_id: 1,
    material_id: null,
    sheet_material_type_id: 1,
    milling_type_id: 1,
    edge_type_id: 1,
    film_id: null,
    notes: null,
    total_amount: 0,
    final_amount: 0,
    paid_amount: 0,
    parts_count: LABEL_COUNT,
    total_area: 0,
    delete_flag: false,
    version: 1,
  });
  return db;
}

function orderDetail(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    order_id: ORDER_ID,
    height: 610,
    width: 100,
    area: 0.061,
    material_id: 1,
    sheet_material_type_id: 1,
    milling_type_id: 1,
    edge_type_id: 1,
    film_id: null,
    milling_cost_per_sqm: 0,
    detail_cost: 0,
    note: null,
    priority: 100,
    production_status_id: 1,
    delete_flag: false,
    version: 1,
    basis_data: null,
    basis_project: null,
    ...overrides,
  };
}

async function setupLabelPermissions(page: Page): Promise<void> {
  const identity = {
    id: '1',
    userId: 1,
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: [
      'orders.view',
      'orders.create',
      'orders.update',
      'orders.export',
      'settings.view',
      'labels.view',
      'labels.generate',
      'labels.manage_templates',
    ],
  };

  await page.addInitScript((user) => {
    localStorage.setItem('user', JSON.stringify(user));
  }, identity);
  await page.route(/\/api\/v1\/me$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: identity }) }),
  );
  await page.route(/\/api\/v1\/auth\/refresh$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accessToken: VALID_AUTH_TOKEN,
        accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
        user: identity,
      }),
    }),
  );
}

async function setupLatestLabelsApi(page: Page, labelCount: number, latestApiCalls: string[]): Promise<void> {
  const rows = buildLabelRows(labelCount);
  const svgPages = rows.map((row) => (
    `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120" viewBox="0 0 180 120"><rect width="180" height="120" fill="white"/><text x="20" y="54">SVG detail ${row.detailId} copy ${row.copyIndex}</text><text x="20" y="84">Бир. № ${row.rowIndex} / ${labelCount}</text></svg>`
  ));
  await page.route(new RegExp(`/api/v1/orders/${ORDER_ID}/labels/latest(?:\\?.*)?$`), (route) => {
    latestApiCalls.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generationId: 7,
        orderId: ORDER_ID,
        templateId: 3,
        templateVersion: 1,
        labelCount,
        generatedAt: '2026-07-24T20:00:00.000Z',
        rows,
        svgPages,
      }),
    });
  });
}

async function setupLabelTemplatesApi(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/label-templates(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          labelTemplateId: 3,
          name: 'Бирка ЧПУ 68x54 - 1 QR',
          version: 1,
          isActive: true,
          canvasWidthMm: 68,
          canvasHeightMm: 54,
          dpi: 203,
          defaultExportFormats: ['png'],
          customFieldSchema: {},
          fieldCatalogSnapshot: {},
          rendererCapabilities: [],
          elements: [],
        },
      ]),
    }),
  );
}

async function setupOrderLabelDataApi(page: Page): Promise<void> {
  await page.route(new RegExp(`/api/v1/orders/${ORDER_ID}/label-data(?:\\?.*)?$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        orderId: ORDER_ID,
        templateId: 3,
        templateVersion: 1,
        customFieldSchema: {},
        details: [
          labelDetail({ detailId: 1001, detailNumber: '1', detailName: 'Планка A', quantity: 2 }),
          labelDetail({ detailId: 1002, detailNumber: '2', detailName: 'Фасад B', quantity: 1 }),
          labelDetail({ detailId: 1003, detailNumber: '3', detailName: 'Полка C', quantity: 3 }),
        ],
      }),
    }),
  );
}

function buildLabelRows(labelCount: number) {
  const physicalRows = labelCount === 6
    ? [
      { detailId: 1001, copyIndex: 1, copyCount: 2 },
      { detailId: 1001, copyIndex: 2, copyCount: 2 },
      { detailId: 1002, copyIndex: 1, copyCount: 1 },
      { detailId: 1003, copyIndex: 1, copyCount: 3 },
      { detailId: 1003, copyIndex: 2, copyCount: 3 },
      { detailId: 1003, copyIndex: 3, copyCount: 3 },
    ]
    : Array.from({ length: labelCount }, (_, index) => ({
      detailId: 10_000 + index,
      copyIndex: 1,
      copyCount: 1,
    }));

  return physicalRows.map((row, index) => ({
    rowIndex: index + 1,
    detailId: row.detailId,
    orderId: ORDER_ID,
    copyIndex: row.copyIndex,
    copyCount: row.copyCount,
    values: {
      'label.counter_text': `Бир. № ${index + 1} / ${labelCount}`,
      'bazis.detail_id': row.detailId,
    },
  }));
}

function labelDetail(overrides: Record<string, unknown>) {
  return {
    orderId: ORDER_ID,
    height: 610,
    width: 100,
    materialName: 'МДФ 16 мм',
    note: null,
    basisProject: null,
    basisData: null,
    detailFields: {},
    orderFields: {},
    bazisFields: {},
    customFields: {},
    version: 1,
    staleCustomFieldIds: [],
    ...overrides,
  };
}

async function installIframePrintProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __labelPrintCalled?: boolean }).__labelPrintCalled = false;
    const originalAppendChild = Element.prototype.appendChild;
    Element.prototype.appendChild = function patchedAppendChild<T extends Node>(child: T): T {
      const result = originalAppendChild.call(this, child) as T;
      if (child instanceof HTMLIFrameElement) {
        const install = () => {
          if (child.contentWindow) {
            child.contentWindow.print = () => {
              (window as unknown as { __labelPrintCalled?: boolean }).__labelPrintCalled = true;
            };
          }
        };
        install();
        window.setTimeout(install, 0);
      }
      return result;
    };
  });
}
