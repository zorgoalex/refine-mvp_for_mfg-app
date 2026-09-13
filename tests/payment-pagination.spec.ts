import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: ['tests/fixtures/paymentPagination.tsx'], bundle: true, write: false,
    format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false}' },
  });
  bundle = result.outputFiles[0].text;
});

for (const width of [320, 390]) {
  test(`native mobile payment pager ${width}px: navigation, size and disabled`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    const requests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (route.request().url() === 'http://payment-pagination.test/') {
        return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      }
      requests.push(route.request().url());
      return route.abort();
    });
    await page.goto('http://payment-pagination.test/');
    await page.addScriptTag({ content: bundle });
    const cards = page.locator('.ant-list-items .ant-card');
    const pager = page.locator('.ant-list-pagination');
    await expect(cards).toHaveCount(10);
    await expect(cards.first()).toContainText('Тест платёж 1');
    await expect(pager).toBeVisible();
    await pager.locator('.ant-pagination-next button').click();
    await expect(cards.first()).toContainText('Тест платёж 11');
    await expect(page.getByTestId('calls')).toHaveText('[[2,10]]');
    await pager.locator('.ant-pagination-prev button').click();
    await expect(cards.first()).toContainText('Тест платёж 1');
    await pager.locator('.ant-pagination-next button').click();
    // AntD intentionally hides the size chooser below its xs breakpoint.
    await page.setViewportSize({ width: 768, height: 844 });
    await pager.locator('.ant-select-selector').click();
    await page.locator('.ant-select-item-option').filter({ hasText: /^20\s*\// }).click();
    await expect(cards).toHaveCount(20);
    await expect(cards.first()).toContainText('Тест платёж 1');
    await expect(page.getByTestId('calls')).toHaveText('[[2,10],[1,10],[2,10],[2,20]]');
    await page.setViewportSize({ width, height: 844 });
    await cards.first().click();
    await expect(page.getByTestId('opened')).toHaveText('1');
    await page.getByRole('button', { name: 'Тест без пагинации' }).click();
    await expect(pager).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
  });
}
