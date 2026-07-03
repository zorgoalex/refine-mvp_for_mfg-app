import { expect, test } from '@playwright/test';
import { setupWorkflowMockApi } from './helpers/mockWorkflowApi';

// Mocked-local /cut page smoke (no live backend): proves the backend-owned cut
// flow renders behind VITE_USE_BACKEND_CUT and that the operator path
// criteria -> draft job -> eligible details (no_sheet_spec surfaced) ->
// basket -> calculate -> per-sheet group works against mocked /api/v1/cut-jobs.

const CUT_PERMISSIONS = [
  'orders.view',
  'payments.view',
  'settings.view',
  'cut.view',
  'cut.manage',
];

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function jobBase() {
  return {
    cutJobId: 42,
    name: 'E2E-Тест раскрой',
    status: 'draft',
    source: 'manual',
    version: 0,
    pdfPrewarmState: 'pending',
    pdfTemplate: 'standard',
    totals: { positions: 0, details: 0, area: 0, sheets: 0, materialsCount: 0, filmsCount: 0 },
    items: [],
    groups: [],
  };
}

test.describe('Cut page (mocked-local)', () => {
  test('runs the criteria -> eligible -> calculate -> sheet flow via the backend API', async ({ page }) => {
    await setupWorkflowMockApi(page, undefined, {
      runtimeConfig: { backendCut: true, backendAuth: true, backendPermissions: true },
    });

    // Override identity to carry cut.* permissions (registered after the helper,
    // so Playwright checks this handler first).
    const identity = {
      id: '1',
      userId: 1,
      username: 'admin',
      role: 'admin',
      roleId: 1,
      permissions: CUT_PERMISSIONS,
    };
    await page.route(/\/api\/v1\/me$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: identity }) }),
    );
    await page.route(/\/api\/v1\/auth\/refresh$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ accessToken: 'mock', accessTokenExpiresAt: '2030-01-01T00:00:00.000Z', user: identity }),
      }),
    );

    await page.route(/\/api\/v1\/cut-jobs$/, (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(jobBase()) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.route(/\/api\/v1\/cut-jobs\/42\/eligible-details(\?.*)?$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          details: [
            { orderDetailId: 1, orderId: 9, quantity: 2, materialId: 5, sheetMaterialTypeId: 7, filmId: null, eligible: true, ineligibleReason: null },
            { orderDetailId: 2, orderId: 9, quantity: 1, materialId: 6, sheetMaterialTypeId: null, filmId: null, eligible: false, ineligibleReason: 'no_sheet_spec' },
          ],
          noSheetSpecCount: 2,
        }),
      }),
    );

    await page.route(/\/api\/v1\/cut-jobs\/42\/items$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...jobBase(), version: 1, items: [{ cutJobItemId: 1, orderDetailId: 1, orderId: 9, qty: 2, cutGroupId: null }] }),
      }),
    );

    await page.route(/\/api\/v1\/cut-jobs\/42\/calculate$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...jobBase(),
          status: 'ready',
          version: 2,
          items: [{ cutJobItemId: 1, orderDetailId: 1, orderId: 9, qty: 2, cutGroupId: 100 }],
          groups: [
            {
              cutGroupId: 100,
              sheetMaterialTypeId: 7,
              filmId: null,
              status: 'ready',
              pdfTemplate: 'standard',
              summary: { used_stock_count: 1, waste_percent: 12 },
              sheets: [
                {
                  cutGroupSheetId: 1,
                  sheetIndex: 0,
                  pngCacheKey: null,
                  placements: { trim_mm: { left: 10, right: 10, top: 10, bottom: 10 }, sheet_width_mm: 2800, sheet_height_mm: 2070, pieces: [] },
                },
              ],
            },
          ],
        }),
      }),
    );

    await page.route(/\/api\/v1\/cut-jobs\/42\/pdf-template$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...jobBase(),
          status: 'ready',
          version: 2,
          pdfTemplate: 'bath_profiles',
          items: [{ cutJobItemId: 1, orderDetailId: 1, orderId: 9, qty: 2, cutGroupId: 100 }],
          groups: [
            {
              cutGroupId: 100,
              sheetMaterialTypeId: 7,
              filmId: null,
              status: 'ready',
              pdfTemplate: 'standard',
              summary: { used_stock_count: 1, waste_percent: 12 },
              sheets: [
                {
                  cutGroupSheetId: 1,
                  sheetIndex: 0,
                  pngCacheKey: null,
                  placements: { trim_mm: { left: 10, right: 10, top: 10, bottom: 10 }, sheet_width_mm: 2800, sheet_height_mm: 2070, pieces: [] },
                },
              ],
            },
          ],
        }),
      }),
    );

    await page.route(/\/api\/v1\/cut-jobs\/42\/groups\/100\/sheets\/0\.png(\?.*)?$/, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG_BYTES }),
    );
    let jobPdfRequestUrl = '';
    await page.route(/\/api\/v1\/cut-jobs\/42\/export\.pdf(\?.*)?$/, (route) => {
      jobPdfRequestUrl = route.request().url();
      return route.fulfill({ status: 200, contentType: 'application/pdf', body: PNG_BYTES });
    });

    await page.goto('/cut');

    await page.getByPlaceholder('Название раскроя').fill('E2E-Тест раскрой');
    await page.getByPlaceholder('Заказы (9,10)').fill('9');
    await page.getByRole('button', { name: 'Создать раскрой' }).click();

    await expect(page.getByText('Раскрой #42')).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: 'Загрузить подходящие детали' }).click();
    await expect(page.getByText(/без раскройной спецификации материала/)).toBeVisible();

    await page.getByRole('button', { name: /Добавить выбранные/ }).click();
    await page.getByRole('button', { name: 'Рассчитать' }).click();

    await expect(page.getByText('Группа #100')).toBeVisible();
    await page.getByRole('button', { name: 'Развернуть' }).click();
    await expect(page.locator('img[alt="Лист 1"]')).toBeVisible();

    await page.getByTestId('pdf-template-select-job').click();
    await page.getByTitle('Профили ванны').click();
    await page.getByTestId('preview-job-pdf-btn').click();
    const pdfModal = page.getByRole('dialog', { name: /Предпросмотр PDF/ });
    await expect(pdfModal).toBeVisible({ timeout: 10000 });
    await expect(pdfModal.locator('iframe[title="Предпросмотр PDF"]')).toBeVisible();
    expect(jobPdfRequestUrl).toContain('template=bath_profiles');
    await pdfModal.getByRole('button', { name: 'Закрыть' }).click();
  });
});
