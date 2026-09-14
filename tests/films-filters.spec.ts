import { expect, test, type Page } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi } from './helpers/mockWorkflowApi';

const filmKey = '00000000-0000-4000-8000-000000000014';

async function choose(page: Page, label: string, option: string) {
  await page.locator('.ant-form-item').filter({ has: page.getByLabel(label, { exact: true }) }).locator('.ant-select-selector').click();
  await page.locator('.ant-select-dropdown:visible').getByText(option, { exact: true }).click();
}

for (const mobile of [false, true]) {
  test(`films combine server search and field filters, restore URL and reset (mobile=${mobile})`, async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const db = createWorkflowMockDb();
    db.vendors = [
      { vendor_id: 1, vendor_name: 'E2E Первый', is_active: true },
      { vendor_id: 2, vendor_name: 'E2E Второй', is_active: false },
    ];
    db.films = Array.from({ length: 12 }, (_, index) => ({
      film_id: index + 1, film_name: `E2E Белая ${index + 1}`, sort_order: index + 1,
      vendor_id: 1, film_type_id: 1, film_texture: false, is_active: true, ref_key_1c: null,
    }));
    db.films.push(
      { film_id: 13, film_name: 'E2E Дуб фактурный', sort_order: 13,
        vendor_id: 1, film_type_id: 1, film_texture: true, is_active: true, ref_key_1c: null },
      { film_id: 14, film_name: 'E2E Дуб гладкий', sort_order: 0,
        vendor_id: 2, film_type_id: 2, film_texture: false, is_active: false, ref_key_1c: filmKey },
    );
    const queries: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await setupWorkflowMockApi(page, db, {
      onGraphqlQuery: (query) => { if (/\bfilms\s*\(/.test(query)) queries.push(query); },
      onGraphqlError: (error) => errors.push(error),
    });
    await page.goto('/films');
    const rows = page.locator('.ant-table-tbody > tr.ant-table-row');
    const search = page.getByRole('combobox', { name: 'Поиск плёнок по названию' });
    await expect(rows).toHaveCount(10, { timeout: 60_000 });
    await expect(page.getByRole('region', { name: 'Фильтры плёнок' })).toHaveCount(0);
    await page.locator('.ant-pagination-item-2').click();
    await expect(rows).toHaveCount(3);
    const suggestions = page.locator('.ant-select-dropdown:visible .ant-select-item-option');
    await search.fill('  дУб  ');
    await expect(suggestions.getByText('E2E Дуб фактурный', { exact: true })).toBeVisible();
    await expect(suggestions.getByText('E2E Дуб гладкий', { exact: true })).toHaveCount(0);
    await expect(rows).toHaveCount(3);
    await page.screenshot({ path: test.info().outputPath('autocomplete.png'), fullPage: true });
    await search.fill('Белая');
    await expect(suggestions.getByText('E2E Белая 1', { exact: true })).toBeVisible();
    await expect(suggestions.getByText('E2E Дуб фактурный', { exact: true })).toHaveCount(0);
    await search.fill('дУб');
    await suggestions.getByText('E2E Дуб фактурный', { exact: true }).click();
    await expect(search).toHaveValue('E2E Дуб фактурный');
    await expect(rows).toHaveCount(1);
    await page.locator('.ant-input-search .ant-input-clear-icon').click();
    await expect(rows).toHaveCount(10);
    await search.fill('Белая 12');
    await expect(suggestions.getByText('E2E Белая 12', { exact: true })).toBeVisible();
    await search.press('ArrowDown');
    await search.press('Enter');
    await expect(search).toHaveValue('E2E Белая 12');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('E2E Белая 12');
    await page.locator('.ant-input-search .ant-input-clear-icon').click();
    await expect(rows).toHaveCount(10);
    await page.locator('.ant-pagination-item-2').click();
    await expect(rows).toHaveCount(3);
    await search.fill('  дУб  ');
    await search.press('Enter');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('E2E Дуб фактурный');
    expect(queries.at(-1)).toMatch(/film_name:\s*\{\s*_ilike:\s*"%дУб%"/);
    expect(queries.at(-1)).toMatch(/offset:\s*0/);

    await page.getByRole('button', { name: 'Фильтры', exact: true }).click();
    await page.screenshot({ path: test.info().outputPath('filters.png'), fullPage: true });
    await choose(page, 'Активность', 'Все');
    await page.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect(rows).toHaveCount(2);
    await search.fill('дуб');
    await expect(suggestions.getByText('E2E Дуб гладкий', { exact: true })).toBeVisible();
    await expect(suggestions.getByText('E2E Дуб фактурный', { exact: true })).toBeVisible();
    await search.fill('дУб');
    await search.press('Escape');
    await expect(search).toHaveValue('дУб');
    await expect(suggestions).toHaveCount(0);
    await choose(page, 'Тип плёнки', 'PET');
    await choose(page, 'Поставщик плёнки', 'E2E Второй');
    await choose(page, 'Фактура', 'Без фактуры');
    await page.getByLabel('ID', { exact: true }).fill('14');
    await page.getByLabel('Порядок', { exact: true }).fill('0');
    await page.getByLabel('Ключ 1С', { exact: true }).fill(filmKey);
    await page.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('E2E Дуб гладкий');
    expect(queries.at(-1)).toMatch(/film_texture:\s*\{\s*_eq:\s*false/);
    expect(queries.at(-1)).toMatch(/sort_order:\s*\{\s*_eq:\s*0/);
    expect(queries.at(-1)).toMatch(/is_active:\s*\{\s*_in:\s*\[true,\s*false\]/);
    await page.getByRole('button', { name: 'Скрыть фильтры' }).click();
    await expect(page.getByRole('button', { name: 'Фильтры активны' })).toBeVisible();
    await expect(rows).toHaveCount(1);

    await page.reload();
    await expect(search).toBeVisible({ timeout: 60_000 });
    await expect(rows).toHaveCount(1);
    await expect(search).toHaveValue('дУб');
    expect(queries.at(-1)).toMatch(/film_texture:\s*\{\s*_eq:\s*false/);
    expect(queries.at(-1)).toMatch(/sort_order:\s*\{\s*_eq:\s*0/);
    expect(queries.at(-1)).toMatch(/is_active:\s*\{\s*_in:\s*\[true,\s*false\]/);
    await page.getByRole('button', { name: 'Фильтры активны' }).click();
    await expect(page.getByLabel('ID', { exact: true })).toHaveValue('14');
    await expect(page.getByLabel('Порядок', { exact: true })).toHaveValue('0');
    await expect(page.getByLabel('Ключ 1С', { exact: true })).toHaveValue(filmKey);
    const requestCount = queries.length;
    await page.getByLabel('Ключ 1С', { exact: true }).fill('invalid-uuid');
    await page.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect(page.getByText('Введите полный UUID ключа 1С')).toBeVisible();
    expect(queries).toHaveLength(requestCount);

    await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
    await expect(search).toHaveValue('');
    await expect(rows).toHaveCount(10);
    await expect(rows.first()).toContainText('E2E Белая 1');
    await page.getByRole('button', { name: 'Скрыть фильтры' }).click();
    await expect(page.getByRole('button', { name: 'Фильтры', exact: true })).toBeVisible();
    await search.fill('E2E нет такой плёнки');
    await expect(suggestions.getByText('Совпадений нет', { exact: true })).toBeVisible();
    await search.press('Enter');
    await expect(rows).toHaveCount(0);
    await page.locator('.ant-input-search .ant-input-clear-icon').click();
    await expect(rows).toHaveCount(10);
    expect(errors).toEqual([]);
  });
}
