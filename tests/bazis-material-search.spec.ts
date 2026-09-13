import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

let bundle: string;
let css: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: ['tests/fixtures/bazisMaterialSearch.tsx'], bundle: true, write: false,
    outfile: 'fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false}' },
  });
  bundle = result.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = result.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});
for (const grouped of [false, true]) {
  test(`native PanelsTab material search and selection: grouped=${grouped}`, async ({ page }) => {
    const errors: string[] = [];
    const unexpected: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (route.request().url() === 'http://bazis-search.test/') {
        return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      }
      unexpected.push(route.request().url());
      return route.abort();
    });
    await page.goto('http://bazis-search.test/');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle });
    if (grouped) await page.getByLabel('Группировать по изделию').check();
    const rows = page.locator('.ant-table-tbody > tr.ant-table-row');
    const search = page.getByLabel('Поиск панелей');
    await expect(rows).toHaveCount(3);
    await search.fill('  дУб сЕвЕрНый  ');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Дуб Северный');
    await rows.first().getByRole('checkbox').check();
    await expect(page.getByTestId('selection')).toHaveText('[1]');
    await search.fill('несуществующий материал');
    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId('selection')).toHaveText('[1]');
    await search.fill('');
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: 'Дуб Северный' }).getByRole('checkbox')).toBeChecked();
    await search.fill('Панель 3');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Панель 3');
    await search.fill('Обозначение-2');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Белый');
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}
test('native PanelsTab preserves the genuinely empty revision state', async ({ page }) => {
  const errors: string[] = [];
  const unexpected: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url() === 'http://bazis-search.test/?empty') {
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    }
    unexpected.push(route.request().url());
    return route.abort();
  });
  await page.goto('http://bazis-search.test/?empty');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await expect(page.getByText('В ревизии нет панелей')).toBeVisible();
  await expect(page.getByLabel('Поиск панелей')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});
