import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The real BroadcastEditor in a real antd Form under React.StrictMode. Every API call is answered by
// page.route mocks; never touches ERP/WhatsApp.
const PORT = 5198;
const directory = await mkdtemp(path.join(os.tmpdir(), 'erp-broadcast-editor-'));
const browser = await chromium.launch({ headless: true });
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'),
  server: { host: '127.0.0.1', port: PORT, strictPort: true },
  optimizeDeps: { entries: ['tests/fixtures/broadcast-editor.tsx'] },
  plugins: [{ name: 'broadcast-editor-fixture', configureServer(s) { s.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith('/fixture')) return next();
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/broadcast-editor.tsx"></script></body></html>');
  }); } }],
});

async function open(context, policy) {
  const page = await context.newPage();
  const errors = [];
  const patches = [];
  page.on('pageerror', (e) => allErrors.push(e.message.split('\n')[0]));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && /Cannot read|TypeError/.test(m.text())) errors.push(m.text()); });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = request.url();
    if (url.includes('/whatsapp/groups')) {
      return route.fulfill({ json: { groups: [], truncated: false, fetchedAt: '2026-09-30T00:00:00Z', cached: true } });
    }
    if (request.method() === 'PATCH' && /\/whatsapp\/broadcasts\/1$/.test(url)) {
      const body = request.postDataJSON();
      patches.push(body);
      const { version, duplicateRiskConfirmed, ...rest } = body;
      return route.fulfill({ json: { broadcast: { ...rest, id: 1, version: version + 1, archived: false, scheduleGeneration: 1,
        createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z', updatedBy: null }, todaySchedule: null,
        runtime: { enabled: true, relayAvailable: true, unavailableReason: null } } });
    }
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  await page.goto(`http://127.0.0.1:${PORT}/fixture?policy=${policy}`);
  return { page, errors, patches };
}

const results = [];
const allErrors = [];
try {
  await server.listen();
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });

  // 1-2. An existing broadcast whose catch-up policy hides the deadline field opens without a crash and is not dirty.
  for (const policy of ['skip', 'end_of_day', 'until_deadline']) {
    const { page, errors } = await open(context, policy);
    await expect(page.getByText('Рассылка: Рассылка заказов')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('dirty')).toHaveText('false');
    const deadlineVisible = await page.getByText('Контрольное время', { exact: true }).isVisible();
    assert.equal(deadlineVisible, policy === 'until_deadline', `deadline field visibility for ${policy}`);
    assert.deepEqual(errors, [], `no runtime errors for ${policy}`);
    results.push(`open ${policy}: ok (deadline field ${deadlineVisible ? 'shown' : 'hidden'}, not dirty)`);
    await page.close();
  }

  // 3. Editing and saving a skip-policy broadcast sends the kept deadline and does not crash.
  {
    const { page, errors, patches } = await open(context, 'skip');
    await expect(page.getByText('Рассылка: Рассылка заказов')).toBeVisible({ timeout: 20000 });
    const name = page.getByLabel('Название');
    await name.fill('Рассылка заказов 2');
    await expect(page.getByTestId('dirty')).toHaveText('true');
    await page.getByRole('button', { name: 'Сохранить настройки' }).click();
    await expect(page.getByTestId('saves')).toHaveText('1');
    assert.equal(patches.length, 1);
    assert.equal(patches[0].catchUpPolicy, 'skip');
    assert.equal(patches[0].catchUpDeadline, '10:00');
    assert.equal(patches[0].name, 'Рассылка заказов 2');
    assert.deepEqual(errors, [], 'no runtime errors while saving');
    results.push('save skip: ok (catchUpDeadline 10:00 kept)');
    await page.close();
  }

  // 4. Switching the policy in the editor: until_deadline -> skip -> until_deadline shows/hides the field without a crash.
  {
    const { page, errors } = await open(context, 'until_deadline');
    await expect(page.getByText('Рассылка: Рассылка заказов')).toBeVisible({ timeout: 20000 });
    const policySelect = page.locator('.ant-form-item').filter({ hasText: 'Если сервер пропустил время отправки' }).locator('.ant-select-selector');
    await policySelect.click();
    await page.locator('.ant-select-item-option').filter({ hasText: 'Пропустить рассылку за сегодня' }).click();
    await expect(page.getByText('Контрольное время', { exact: true })).toBeHidden();
    await expect(page.getByTestId('dirty')).toHaveText('true');
    await policySelect.click();
    await page.locator('.ant-select-item-option').filter({ hasText: 'Отправить до контрольного времени' }).click();
    await expect(page.getByText('Контрольное время', { exact: true })).toBeVisible();
    await expect(page.getByTestId('dirty')).toHaveText('false');
    assert.deepEqual(errors, [], 'no runtime errors while switching the policy');
    results.push('switch policy: ok');
    await page.close();
  }
  console.log(JSON.stringify({ browse: 'passed', results }, null, 1));
} catch (error) {
  console.log(JSON.stringify({ browse: 'failed', results, pageErrors: [...new Set(allErrors)].slice(0, 5), error: String(error?.message ?? error).slice(0, 600) }, null, 1));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
