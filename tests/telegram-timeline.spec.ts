import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: ['tests/fixtures/telegramTimeline.tsx'], bundle: true, write: false,
    format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false}' },
  });
  bundle = result.outputFiles[0].text;
});

for (const empty of [false, true]) {
  test(`expanded native Telegram audit: ${empty ? 'empty history' : 'ordered steps and colors'}`, async ({ page }) => {
    const errors: string[] = [];
    const unexpected: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.href === 'http://telegram-timeline.test/') {
        return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      }
      if (url.pathname === '/api/v1/cnc-telegram/worker-logs' && route.request().method() === 'GET') {
        return route.fulfill({ json: {
          pagination: { page: 1, pageSize: 50, total: 1 }, scans: [], data: [{
            logId: 'log-1', sourceMessageId: '123', sourceChatId: '456',
            sourceCreatedAt: '2026-09-12T12:00:00', messageType: 'svg', status: 'failed',
            filename: 'audit-test.svg', observations: [], operations: [{
              operationId: 'op-1', operationType: 'message_processing', status: 'failed',
              steps: empty ? [] : ['succeeded', 'skipped', 'failed'].map((status, index) => ({
                stepId: `step-${index}`, status, message: `Шаг теста ${index + 1}`,
                at: `2026-09-12T12:00:0${index + 1}`, code: `TEST_${index}`,
              })),
              responses: [{ responseId: 'response-1', kind: 'telegram_reply', status: 'succeeded', text: 'Ответ сохранён' }],
            }],
          }],
        } });
      }
      unexpected.push(route.request().url());
      return route.abort();
    });
    await page.goto('http://telegram-timeline.test/');
    await page.addScriptTag({ content: bundle });
    await expect(page.getByText('audit-test.svg')).toBeVisible();
    await page.locator('.ant-table-row-expand-icon').click();
    await expect(page.getByText('Telegram: Ответ сохранён')).toBeVisible();
    const items = page.locator('.ant-timeline-item');
    await expect(items).toHaveCount(empty ? 0 : 3);
    if (!empty) {
      for (let index = 0; index < 3; index++) {
        await expect(items.nth(index)).toContainText(`Шаг теста ${index + 1}`);
        await expect(items.nth(index)).toContainText(`12.09.2026 12:00:0${index + 1}`);
      }
      await expect(items.nth(0).locator('.ant-timeline-item-head')).toHaveClass(/ant-timeline-item-head-green/);
      await expect(items.nth(1).locator('.ant-timeline-item-head')).toHaveCSS('color', 'rgb(255, 165, 0)');
      await expect(items.nth(2).locator('.ant-timeline-item-head')).toHaveClass(/ant-timeline-item-head-red/);
    }
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}
