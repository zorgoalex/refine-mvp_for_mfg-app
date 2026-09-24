import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Native editors, fixture-only HTTP. Never connects to ERP/WhatsApp or sends a message.
const directory = await mkdtemp(path.join(os.tmpdir(), 'erp-whatsapp-editors-'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
const errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/fixture-*', async route => {
  const request = route.request();
  requests.push({ url: request.url(), body: request.postDataJSON() });
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(request.url().endsWith('fixture-preview')
    ? { matched: true, captures: { order_number: '0022' }, body: 'Заказ 0022. №1', counterIsExample: true, timeZone: 'Asia/Almaty' } : {}) });
});
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'),
  server: { host: '127.0.0.1', port: 5196, strictPort: true },
  optimizeDeps: { entries: ['tests/fixtures/whatsapp-reply-editors.tsx'] },
  plugins: [{ name: 'whatsapp-fixture', configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url !== '/fixture') return next();
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/whatsapp-reply-editors.tsx"></script></body></html>');
  }); } }],
});
try {
  await server.listen(); await page.goto('http://127.0.0.1:5196/fixture');
  await page.getByRole('button', { name: 'Открыть ответ', exact: true }).click();
  await expect(page.getByText('Шаблон с переменными', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const template = requests.find(r => r.url.endsWith('fixture-template')).body;
  assert.equal(template.bodyMode, 'template'); assert.equal(template.version, 1); assert.ok(!('code' in template));
  await page.getByRole('button', { name: 'Открыть правило', exact: true }).click();
  await expect(page.getByText('По шаблону: сообщение целиком', { exact: true })).toBeVisible();
  await page.getByLabel('Пример входящего сообщения').fill('Заказ 0022 готов');
  await page.getByRole('button', { name: 'Проверить шаблон', exact: true }).click();
  await expect(page.getByText('Заказ 0022. №1', { exact: true })).toBeVisible();
  await page.getByLabel('Шаблоны входящего сообщения').fill('Заказ {order_number:number}, готов');
  await expect(page.getByText('Заказ 0022. №1', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(directory, 'mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const rule = requests.find(r => r.url.endsWith('fixture-rule')).body;
  assert.equal(rule.replyMode, 'quote'); assert.equal(rule.matchMode, 'pattern_exact');
  assert.deepEqual(rule.keywords, ['Заказ {order_number:number}, готов']); assert.ok(!('code' in rule));
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`WHATSAPP EDITORS BROWSER PASS: ${directory}`);
} finally { await browser.close(); await server.close(); }
