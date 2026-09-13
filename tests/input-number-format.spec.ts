import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

test('native InputNumber preserves legacy clear, retype, bounds and amount display', async ({ page }) => {
  const bundle = await build({ entryPoints: ['tests/fixtures/inputNumberFormat.tsx'], bundle: true, write: false,
    format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url() === 'http://number-format.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }) : route.abort());
  await page.goto('http://number-format.test/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const legacy = page.getByTestId('legacy');
  const current = page.getByTestId('current');
  for (const value of ['', '0', '37', '1 234', '32767', '99999']) {
    for (const section of [legacy, current]) {
      const input = section.getByLabel('Сортировка');
      await input.fill(value);
      await input.blur();
      await section.getByRole('button', { name: 'Сохранить тестовые значения' }).click();
    }
    await expect(current.getByLabel('Сортировка')).toHaveValue(await legacy.getByLabel('Сортировка').inputValue());
    await expect(current.locator('output')).toHaveText(await legacy.locator('output').innerText());
  }
  for (const section of [legacy, current]) {
    await section.getByLabel('Приоритет').fill('101');
    await section.getByLabel('Приоритет').blur();
    await expect(section.getByLabel('Приоритет')).toHaveValue('100');
    await section.getByRole('button', { name: 'Сохранить тестовые значения' }).click();
    await expect(section.locator('output')).toHaveText('{"sort_order":32767,"priority":100}');
  }
  for (const button of ['Нулевая сумма', 'Дробная сумма']) {
    for (const section of [legacy, current]) await section.getByRole('button', { name: button }).click();
    await expect(current.getByLabel('Сумма')).toHaveValue(await legacy.getByLabel('Сумма').inputValue());
    await expect(current.getByLabel('Сумма')).toHaveAttribute('readonly', '');
  }
  expect(errors).toEqual([]);
});
