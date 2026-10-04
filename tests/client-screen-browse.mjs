import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Customer screen in a real browser: the real client-screen.html with its real entry, and a manager
// window with the real presenter, in two tabs of one browser profile. Real BroadcastChannel and Web
// Locks; a made-up order; the runtime config is answered by the script; never touches ERP.
const PORT = 5196;
const directory = await mkdtemp(path.join(os.tmpdir(), 'erp-client-screen-'));
const browser = await chromium.launch({ headless: true });
const html = (entry) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/${entry}"></script></body></html>`;
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'),
  server: { host: '127.0.0.1', port: PORT, strictPort: true },
  optimizeDeps: { entries: ['client-screen.html', 'tests/fixtures/client-screen-presenter.tsx'] },
  plugins: [{ name: 'client-screen-fixture', configureServer(s) { s.middlewares.use((req, res, next) => {
    const url = req.url?.split('?')[0];
    if (url !== '/manager') return next();
    res.setHeader('Content-Type', 'text/html');
    res.end(html('client-screen-presenter.tsx'));
  }); } }],
});

const results = [];
const errors = [];
const requests = [];
try {
  await server.listen();
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const watch = (page, name) => {
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message.split('\n')[0]}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text().split('\n')[0]}`); });
  };
  // What the deployment's runtime config says about the customer screen: 'on', 'off' or 'fail'.
  let runtime = 'off';
  const configRequests = [];
  await context.route(/runtime-config/, (route) => {
    configRequests.push(new URL(route.request().url()).pathname);
    if (runtime === 'fail') return route.fulfill({ status: 503, body: 'unavailable' });
    return route.fulfill({ json: { features: { clientScreen: runtime === 'on' } } });
  });
  const probe = await context.newPage();
  watch(probe, 'probe');
  await probe.goto(`http://127.0.0.1:${PORT}/client-screen.html`);
  await expect(probe.getByText('Экран клиента выключен')).toBeVisible({ timeout: 60000 });
  results.push('flag off → inert "switched off" splash from the real entry');
  runtime = 'fail';
  await probe.reload();
  await expect(probe.getByText('Экран клиента выключен')).toBeVisible({ timeout: 30000 });
  results.push('runtime config unavailable → the same inert splash');
  assert.equal(await probe.evaluate(() => Object.keys(localStorage).length + sessionStorage.length), 0, 'inert window stores nothing');
  await probe.close();
  errors.length = 0; // the 503 above is logged by the browser as a failed resource
  runtime = 'on';

  const viewer = await context.newPage();
  watch(viewer, 'viewer');
  // Everything the customer window asks the network for, besides its own code.
  viewer.on('response', (response) => { if (response.status() >= 400) errors.push(`viewer: HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
  viewer.on('requestfailed', (request) => errors.push(`viewer: failed ${new URL(request.url()).pathname}`));
  viewer.on('request', (request) => { const url = new URL(request.url()); if (!/^\/(src|node_modules|@|client-screen\.html|vite\.svg)/.test(url.pathname) && !/runtime-config/.test(url.pathname)) requests.push(url.pathname); });
  await viewer.goto(`http://127.0.0.1:${PORT}/client-screen.html`);
  await expect(viewer.getByText('Здесь появится ваш заказ')).toBeVisible({ timeout: 60000 });
  results.push('customer window shows the splash');
  assert.equal(await viewer.evaluate(() => sessionStorage.length), 0, 'customer window sessionStorage is empty');

  const manager = await context.newPage();
  watch(manager, 'manager');
  await manager.goto(`http://127.0.0.1:${PORT}/manager`);
  await manager.waitForFunction(() => Boolean(window.cs), null, { timeout: 60000 });
  await manager.evaluate(() => window.cs.present());
  await expect(viewer.getByRole('heading', { name: 'Заказ № 2418' })).toBeVisible({ timeout: 20000 });
  await expect(viewer.getByRole('tab', { selected: true })).toHaveText('Детали заказа (60)');
  await expect(viewer.getByText('Фасад 1', { exact: true })).toBeVisible();
  results.push('order presented: title, summary, active tab, detail rows');
  assert.equal(await viewer.locator('tbody tr[data-row-id]').count(), 50, 'the manager page of 50 rows is shown');
  assert.equal(await manager.evaluate(() => window.cs.view().phase), 'owner');

  const wholePage = async () => viewer.evaluate(() => document.documentElement.outerHTML);
  assert.ok(!(await wholePage()).includes('SECRET'), 'no hidden value in the customer window DOM');
  await expect(viewer.getByRole('columnheader', { name: 'Сумма' })).toHaveCount(0);
  results.push('hidden cost column and hidden note are absent');

  await manager.evaluate(() => window.cs.edit('detail-55', 'Фасад 55 (правка)', '9'));
  await expect(viewer.getByText('Фасад 55 (правка)')).toBeVisible({ timeout: 10000 });
  await expect(viewer.locator('td.client-screen__cell--focused')).toHaveText('9');
  assert.ok(!(await wholePage()).includes('SECRET'), 'the editor value of the hidden field did not arrive');
  results.push('row being edited is mirrored with focus; hidden editor value dropped; page 2 followed');
  if (process.env.SHOT_DIR) await viewer.screenshot({ path: path.join(process.env.SHOT_DIR, 'client-screen-details.png') });

  // A narrow window: the focused cell of a wide table must be scrolled into view, not just its row.
  await viewer.setViewportSize({ width: 520, height: 700 });
  await manager.evaluate(() => window.cs.edit('detail-56', 'Фасад 56', '3'));
  await expect(viewer.locator('td.client-screen__cell--focused')).toHaveText('3');
  const visible = await viewer.locator('td.client-screen__cell--focused').evaluate((cell) => {
    const box = cell.getBoundingClientRect();
    const wrap = cell.closest('.client-screen__table-wrap').getBoundingClientRect();
    return box.left >= wrap.left - 1 && box.right <= wrap.right + 1 && box.top >= 0 && box.bottom <= window.innerHeight;
  });
  assert.ok(visible, 'focused cell is inside the visible part of the table');
  results.push('focused cell of a horizontally overflowing table is in view');
  await viewer.setViewportSize({ width: 1366, height: 768 });

  await manager.evaluate(() => window.cs.tab('basic'));
  await expect(viewer.getByRole('tab', { selected: true })).toHaveText('Основная информация');
  await expect(viewer.locator('.client-screen__field--focused .client-screen__label')).toHaveText('Дата заказа');
  await expect(viewer.getByText('Примечание')).toHaveCount(0);
  results.push('tab switch and field focus mirrored');
  if (process.env.SHOT_DIR) await viewer.screenshot({ path: path.join(process.env.SHOT_DIR, 'client-screen-basic.png') });

  // Settings change: the name column is un-ticked while presenting.
  await manager.evaluate(async () => {
    window.cs.policy.visibleCodes = window.cs.policy.visibleCodes.filter((code) => code !== 'details.name');
    window.cs.policy.version = 2;
    window.cs.tab('details');
    await window.cs.presenter.reloadPolicy();
  });
  await expect(viewer.getByRole('columnheader', { name: 'Название детали' })).toHaveCount(0, { timeout: 10000 });
  results.push('settings change applied to the running presentation');

  // The manager window closes: its lock is released and the customer window blanks.
  await manager.close();
  await expect(viewer.getByText('Здесь появится ваш заказ')).toBeVisible({ timeout: 10000 });
  results.push('manager window closed → splash');

  // A second manager window presents, then switches the workstation off.
  const second = await context.newPage();
  watch(second, 'manager2');
  await second.goto(`http://127.0.0.1:${PORT}/manager`);
  await second.waitForFunction(() => Boolean(window.cs), null, { timeout: 60000 });
  await second.evaluate(() => window.cs.present());
  await expect(viewer.getByRole('heading', { name: 'Заказ № 2418' })).toBeVisible({ timeout: 20000 });
  await second.evaluate(() => window.cs.presenter.disableWorkstation());
  await expect(viewer.getByText('Экран клиента отключён')).toBeVisible({ timeout: 10000 });
  assert.equal(await second.evaluate(() => window.cs.view().workstationDisabled), true);
  results.push('emergency switch-off → "disabled" splash');
  await second.evaluate(() => window.cs.presenter.enableWorkstation());
  await expect(viewer.getByText('Здесь появится ваш заказ')).toBeVisible({ timeout: 10000 });
  await second.evaluate(() => window.cs.present());
  await expect(viewer.getByRole('heading', { name: 'Заказ № 2418' })).toBeVisible({ timeout: 20000 });
  results.push('re-enabled → new press presents again');

  assert.equal(await viewer.evaluate(() => sessionStorage.length), 0, 'customer window sessionStorage stays empty');
  assert.deepEqual(await viewer.evaluate(() => Object.keys(localStorage)), ['erp.clientScreen.workstation'], 'only the workstation record is in localStorage');
  assert.deepEqual([...new Set(requests)], [], 'the customer window made no network request besides its own code and the runtime config');
  assert.ok(configRequests.length >= 3, 'the runtime config was requested by the real entry');
  assert.deepEqual([...new Set(errors)], [], 'no runtime errors');
  console.log(JSON.stringify({ browse: 'passed', results }, null, 1));
} catch (error) {
  try { console.log('viewer body:', (await context.pages()[0]?.evaluate(() => document.body.innerText.slice(0, 300))) ?? 'n/a'); } catch { /* page gone */ }
  console.log(JSON.stringify({ browse: 'failed', results, pageErrors: [...new Set(errors)].slice(0, 5), requests: [...new Set(requests)].slice(0, 5), error: String(error?.message ?? error).slice(0, 900) }, null, 1));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
