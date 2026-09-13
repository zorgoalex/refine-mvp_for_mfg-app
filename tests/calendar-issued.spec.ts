import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

test('native standard and compact DayColumn update the all-issued indicator', async ({ page }) => {
  const result = await build({
    entryPoints: ['tests/fixtures/calendarIssued.tsx'], bundle: true, write: false,
    outfile: 'fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false}' },
  });
  const errors: string[] = [];
  const unexpected: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url() === 'http://calendar-issued.test/') {
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    }
    unexpected.push(route.request().url());
    return route.abort();
  });
  await page.goto('http://calendar-issued.test/');
  await page.addStyleTag({ content: result.outputFiles.find(file => file.path.endsWith('.css'))!.text });
  await page.addScriptTag({ content: result.outputFiles.find(file => file.path.endsWith('.js'))!.text });
  const columns = page.locator('.day-column');
  await expect(columns).toHaveCount(2);
  for (const column of await columns.all()) {
    await expect(column).toHaveClass(/day-column--all-issued/);
    await expect(column).toHaveCSS('box-shadow', /rgba\(82, 196, 26, 0\.45\)/);
  }
  await page.getByRole('button', { name: 'Смешанный день' }).click();
  for (const column of await columns.all()) {
    await expect(column).not.toHaveClass(/day-column--all-issued/);
    await expect(column).not.toHaveCSS('box-shadow', /rgba\(82, 196, 26, 0\.45\)/);
    await expect(column).toContainText('Невыданный заказ');
  }
  await page.getByRole('button', { name: 'Пустой день' }).click();
  for (const column of await columns.all()) {
    await expect(column).not.toHaveClass(/day-column--all-issued/);
    await expect(column).toContainText('Нет заказов');
  }
  await page.getByRole('button', { name: 'Флаг выдачи' }).click();
  for (const column of await columns.all()) await expect(column).toHaveClass(/day-column--all-issued/);
  await page.getByRole('button', { name: 'Все выданы' }).click();
  for (const column of await columns.all()) await expect(column).toHaveClass(/day-column--all-issued/);
  const checkbox = page.locator('.order-card__checkbox input').first();
  await expect(checkbox).toHaveAccessibleName('Отметить как выдан');
  await checkbox.uncheck();
  await expect(page.getByTestId('checkbox-changes')).toHaveText('[[1,false]]');
  await expect(page.getByTestId('current-path')).toHaveText('/');
  await checkbox.check();
  await expect(page.getByTestId('checkbox-changes')).toHaveText('[[1,false],[1,true]]');
  await expect(page.getByTestId('current-path')).toHaveText('/');
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});
