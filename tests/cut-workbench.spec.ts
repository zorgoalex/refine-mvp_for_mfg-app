import { expect, test, type Page } from '@playwright/test';
import { setupWorkflowMockApi } from './helpers/mockWorkflowApi';

// «NewLine»: the cut jobs list is drawn as cards from the same column renderers as the table.
// Mocked-local (no live backend); other variants keep the table.
const shotsDir = process.env.WORKBENCH_SHOTS_DIR;
test.use({ viewport: { width: 1440, height: 900 } });

const CUT_PERMISSIONS = ['orders.view', 'payments.view', 'settings.view', 'cut.view', 'cut.manage'];

const job = (cutJobId: number, name: string, status: string, totals: Record<string, number>) => ({
  cutJobId,
  displayNumber: String(cutJobId),
  isVacuum: false,
  name,
  status,
  source: 'manual',
  createdAt: `2026-09-${10 + cutJobId}T08:30:00.000Z`,
  version: 1,
  pdfPrewarmState: 'pending',
  paramProfileId: null,
  sheetMaterialTypeId: null,
  pdfTemplate: 'standard',
  combineFilms: false,
  splitByMaterial: true,
  rotationAllowed: true,
  textureDirection: 'none',
  materialNames: ['МДФ 16 мм'],
  totals: { positions: 0, details: 0, area: 0, sheets: 0, materialsCount: 1, filmsCount: 1, ...totals },
  items: [],
  groups: [],
});

const JOBS = [
  job(1, 'E2E-Тест раскрой кухня', 'ready', { positions: 4, details: 12, area: 3.4, sheets: 2 }),
  job(2, 'E2E-Тест раскрой шкаф', 'draft', { positions: 9, details: 31, area: 8.15, sheets: 0 }),
  job(3, 'E2E-Тест раскрой фасады', 'ready', { positions: 2, details: 5, area: 1.2, sheets: 1 }),
];

async function openCut(page: Page, uiVariant: 'workbench' | 'evolution') {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await setupWorkflowMockApi(page, undefined, {
    uiVariant,
    runtimeConfig: { backendCut: true, backendAuth: true, backendPermissions: true },
  });
  const identity = { id: '1', userId: 1, username: 'admin', role: 'admin', roleId: 1, permissions: CUT_PERMISSIONS };
  await page.route(/\/api\/v1\/me$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: identity }) }));
  await page.route(/\/api\/v1\/auth\/refresh$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accessToken: 'mock', accessTokenExpiresAt: '2030-01-01T00:00:00.000Z', user: identity }),
    }));
  await page.route(/\/api\/v1\/cut-jobs(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(JOBS) }));
  await page.goto('/cut', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Раскрои' }).click();
  return pageErrors;
}

test.describe('Cut jobs list in NewLine (mocked-local)', () => {
  test.setTimeout(180000);

  test('jobs are cards with every table value and action, sortable', async ({ page }) => {
    const pageErrors = await openCut(page, 'workbench');

    const cards = page.getByTestId('cut-job-card');
    await expect(cards).toHaveCount(3, { timeout: 60000 });
    await expect(page.locator('.cut-jobs-table')).toHaveCount(0);

    const first = cards.filter({ hasText: 'E2E-Тест раскрой кухня' });
    for (const label of ['Позиции', 'Детали', 'Площадь', 'Листы']) {
      await expect(first.locator('.wb-cut-job__label', { hasText: label }).first()).toBeVisible();
    }
    await expect(first.getByText('Открыть').first()).toBeVisible();
    // карточка не шире своей колонки и ничего не обрезает по горизонтали
    for (const card of await cards.all()) {
      expect(await card.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    }

    await page.locator('.wb-cut-jobs__toolbar .ant-select').click();
    await page.getByTitle('Деталей ↓').click();
    await page.mouse.move(0, 0);
    await expect(cards.first()).toContainText('E2E-Тест раскрой шкаф');

    if (shotsDir) {
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${shotsDir}/cut-jobs-cards.png` });
    }
    expect(pageErrors).toEqual([]);
  });

  test('other variants keep the jobs table', async ({ page }) => {
    await openCut(page, 'evolution');
    await expect(page.locator('.cut-jobs-table tr[data-row-key="1"]')).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId('cut-job-card')).toHaveCount(0);
  });
});
