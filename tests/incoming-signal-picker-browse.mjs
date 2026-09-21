import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Run under rtk-heavy-guard. Native AntD interactions with fixture HTTP, no ERP writes.
const directory = await mkdtemp(path.join(os.tmpdir(), 'erp-signal-picker-'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let fail = false;
let signals = [{ code: 'goods.ready', name: 'Тест: заказ готов' }, { code: 'goods.packed', name: 'Тест: упакован' }];
await page.route('**/fixture-signals', route => route.fulfill({ status: fail ? 503 : 200, contentType: 'application/json', body: JSON.stringify(fail ? {} : signals) }));
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'),
  server: { host: '127.0.0.1', port: 5195, strictPort: true },
  optimizeDeps: { entries: ['tests/fixtures/incoming-signal-picker.tsx'] },
  plugins: [{ name: 'signal-picker-fixture', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== '/fixture') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/incoming-signal-picker.tsx"></script></body></html>');
    });
  } }],
});
try {
  await server.listen();
  await page.goto('http://127.0.0.1:5195/fixture');
  const select = page.getByRole('combobox', { name: 'Входящий сигнал — один из' });
  const refresh = page.getByRole('button', { name: 'Обновить список сигналов' });
  await expect(select).toBeEnabled();
  await select.click();
  await page.locator('.ant-select-item-option').filter({ hasText: 'Тест: заказ готов (goods.ready)' }).click();
  await page.locator('.ant-select-item-option').filter({ hasText: 'Тест: упакован (goods.packed)' }).click();
  await expect(page.getByLabel('Выбранные коды')).toHaveText('goods.ready,goods.packed');
  await select.fill('несуществующий-код');
  await select.press('Enter');
  await expect(page.getByLabel('Выбранные коды')).toHaveText('goods.ready,goods.packed');
  await select.fill('goods.ready');
  await expect(page.locator('.ant-select-item-option')).toHaveCount(1);
  await select.press('Escape');
  await page.locator('.ant-select-selection-item').filter({ hasText: 'Тест: упакован' }).locator('.ant-select-selection-item-remove').click();
  await expect(page.getByLabel('Выбранные коды')).toHaveText('goods.ready');
  fail = true; await refresh.click();
  await expect(page.getByText(/Не удалось загрузить список сигналов/)).toBeVisible();
  await expect(select).toBeDisabled();
  fail = false; signals = []; await refresh.click();
  await expect(page.getByText(/Сначала добавьте и сохраните сигналы/)).toBeVisible();
  await expect(page.getByText(/В справочнике больше нет выбранных сигналов/)).toBeVisible();
  await expect(page.getByLabel('Выбранные коды')).toHaveText('goods.ready');
  await page.locator('.ant-select-selection-item').filter({ hasText: 'goods.ready — нет в справочнике' }).locator('.ant-select-selection-item-remove').click();
  await expect(page.getByLabel('Выбранные коды')).toHaveText('');
  signals = [{ code: 'goods.ready', name: 'Тест: заказ готов' }]; await refresh.click();
  await expect(page.getByText(/В справочнике больше нет выбранных сигналов/)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await select.click();
  await page.screenshot({ path: path.join(directory, 'mobile.png'), fullPage: true });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`SIGNAL PICKER BROWSER PASS: ${directory}`);
} finally {
  await browser.close(); await server.close();
}
