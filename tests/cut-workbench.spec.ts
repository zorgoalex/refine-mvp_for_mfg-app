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
  await page.route(/\/api\/v1\/cut-jobs\/(1|2|3)$/, (route) => {
    const id = Number(route.request().url().split('/').pop());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(JOBS.find((item) => item.cutJobId === id)) });
  });
  await page.goto('/cut', { waitUntil: 'domcontentloaded' });
  if (uiVariant !== 'workbench') await page.getByRole('tab', { name: 'Раскрои' }).click();
  return pageErrors;
}

test.describe('Cut jobs list in NewLine (mocked-local)', () => {
  test.setTimeout(180000);

  test('jobs are a list on the left; a click opens the job on the right', async ({ page }) => {
    const pageErrors = await openCut(page, 'workbench');

    const cards = page.getByTestId('cut-job-card');
    await expect(cards).toHaveCount(3, { timeout: 60000 });
    await expect(page.locator('.cut-jobs-table')).toHaveCount(0);
    await expect(page.getByTestId('cut-job-empty')).toContainText('Выберите задание в списке слева');

    // левая панель по мокапу: заголовок, «+ Задание», виды со счётчиками, поиск, статусы-чипы
    const rail = page.locator('.wb-cut-rail');
    await expect(rail.locator('.wb-cut-rail__title')).toHaveText('Раскрой');
    await expect(rail.getByTestId('cut-new-job')).toBeVisible();
    await expect(rail.locator('.wb-cut-rail__kinds')).toContainText('Раскрои');
    await expect(rail.locator('.wb-cut-rail__kinds')).toContainText('Ванны');
    const chip = (label: string) => rail.locator('.wb-cut-rail__chip', { hasText: label });
    await expect(chip('Все')).toContainText('3');
    await expect(chip('Черновики')).toContainText('1');
    await expect(chip('Готовы')).toContainText('2');
    await chip('Черновики').click();
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('E2E-Тест раскрой шкаф');
    await chip('Все').click();
    await rail.getByLabel('Поиск задания').fill('фасады');
    await expect(cards).toHaveCount(1);
    await rail.getByLabel('Поиск задания').fill('');
    await expect(cards).toHaveCount(3);
    // прежние действия списка — в меню «⋯», фильтры — в боковой панели
    await rail.getByRole('button', { name: 'Действия со списком заданий' }).click();
    for (const item of ['Загрузить SVG-раскрой', 'Экспорт списка (CSV)', 'Обновить список']) {
      await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await rail.getByRole('button', { name: 'Фильтры заданий' }).click();
    const filtersDrawer = page.locator('.wb-cut-drawer--filters');
    await expect(filtersDrawer.getByText('Показывать удалённые')).toBeVisible();
    await expect(filtersDrawer.getByRole('button', { name: 'Применить' })).toBeVisible();
    await filtersDrawer.locator('.ant-drawer-close').click();

    const first = cards.filter({ hasText: 'E2E-Тест раскрой кухня' });
    for (const label of ['Детали', 'Площадь', 'Листы']) {
      await expect(first.locator('.wb-cut-job__label', { hasText: label }).first()).toBeVisible();
    }
    await expect(first.getByText('Открыть').first()).toBeVisible();
    // карточка не шире своей колонки и ничего не обрезает по горизонтали
    for (const card of await cards.all()) {
      expect(await card.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    }

    // клик по карточке открывает задание справа от списка, на том же экране
    await first.locator('.wb-cut-job__name').click();
    const jobCard = page.locator('.cut-page-modern__job');
    await expect(jobCard).toBeVisible({ timeout: 30000 });
    await expect(jobCard).toContainText('E2E-Тест раскрой кухня');
    await expect(first).toHaveAttribute('data-active', 'true');
    // шапка задания: номер, шаги, вкладки
    await expect(jobCard.locator('.wb-cut-head__title')).toHaveText('Задание #1');
    await expect(jobCard.locator('.wb-cut-step')).toHaveCount(5);
    await expect(jobCard.locator('.wb-cut-tabs__item')).toHaveText([/Листы/, /Детали/, /Версии расчёта/]);
    await expect(jobCard.locator('.wb-cut-kpi')).toContainText('Деталей');
    // параметры — чипами, форма раскрывается по «Изменить»
    await expect(jobCard.locator('.cut-job-operational-fields')).toBeHidden();
    await jobCard.locator('.wb-cut-params__toggle').click();
    await expect(jobCard.locator('.cut-job-operational-fields')).toBeVisible();
    await jobCard.getByRole('tab', { name: /Версии расчёта/ }).click();
    await expect(jobCard.locator('.cut-results-block')).toBeVisible();
    await expect(jobCard.locator('.cut-job-overview__main')).toBeHidden();
    await jobCard.getByRole('tab', { name: /Детали/ }).click();
    await expect(page.locator('.cut-page-modern__details')).toBeVisible();
    await jobCard.getByRole('tab', { name: /Листы/ }).click();
    const layout = await page.evaluate(() => {
      const rail = document.querySelector('.cut-page-modern__jobs')!.getBoundingClientRect();
      const job = document.querySelector('.cut-page-modern__job')!.getBoundingClientRect();
      return { right: job.left >= rail.right, inView: job.top < window.innerHeight };
    });
    expect(layout).toEqual({ right: true, inView: true });
    if (shotsDir) {
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${shotsDir}/cut-page-split.png` });
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
