import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { printableError } from './helpers/redactSecrets.mjs';
import { vercelBypassCookies } from './helpers/vercelBypass.mjs';

// Live check of the manager side in the real application against the stage backend: log in, open a
// test order, present it, follow tabs, hide, emergency switch-off. Nothing is saved in the order.
// The organisation setting is switched on for the run and restored in `finally` (and verified).
// Env: BASE_URL (a built deployment), ORDER_ID (an existing test order), CODEX_PLAYWRIGHT_USERNAME /
// CODEX_PLAYWRIGHT_PASSWORD, optional VERCEL_AUTOMATION_BYPASS_SECRET, optional LAYOUT=legacy.
// Secrets are never printed.
const base = (process.env.BASE_URL ?? '').replace(/\/$/, '');
assert.match(base, /^https:\/\//, 'BASE_URL must be an https URL');
const orderId = Number(process.env.ORDER_ID);
assert.ok(Number.isSafeInteger(orderId) && orderId > 0, 'ORDER_ID is required');
const username = process.env.CODEX_PLAYWRIGHT_USERNAME ?? '';
const password = process.env.CODEX_PLAYWRIGHT_PASSWORD ?? '';
assert.ok(username && password, 'CODEX_PLAYWRIGHT_USERNAME / CODEX_PLAYWRIGHT_PASSWORD are required');
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const secrets = [bypass, password];

const results = [];
const errors = [];
let api = null;
let token = null;
let original = null;
const settingsCall = async (method, body) => {
  const response = await fetch(`${api}/client-screen/settings`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  assert.ok(response.ok, `${method} client-screen settings → ${response.status}`);
  return response.json();
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const cookies = await vercelBypassCookies(base, bypass);
  if (cookies.length) await context.addCookies(cookies);
  // A preview deployment has the customer screen flag off; this run switches it on for its own browser only.
  let runtimeConfig = null;
  await context.route(/runtime-config/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    runtimeConfig = json;
    // LAYOUT=legacy forces the classic layout with a tab bar, whatever the test user prefers.
    const ui = process.env.LAYOUT === 'legacy' ? { ...(json.ui ?? {}), evolutionEnabled: false, forceLegacy: true } : json.ui;
    await route.fulfill({ response, json: { ...json, ui, features: { ...(json.features ?? {}), clientScreen: true } } });
  });

  // The stage backend and Hasura accept browser calls only from the stage site. When the build under
  // test is a preview deployment, its calls to them are relayed by this script as if they came from
  // the stage site; on the stage site itself nothing is relayed.
  const pageOrigin = new URL(base).origin;
  const STAGE_SITE = 'https://app-test.mebelkz.app';
  if (pageOrigin !== STAGE_SITE) {
    const cors = { 'access-control-allow-origin': pageOrigin, 'access-control-allow-credentials': 'true', vary: 'Origin' };
    await context.route((url) => url.hostname.endsWith('.mebelkz.app') && url.origin !== pageOrigin, async (route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? '*', 'access-control-max-age': '600' } });
      }
      // Long-lived streams cannot be relayed; the form works without them.
      if (request.resourceType() === 'eventsource' || (request.headers().accept ?? '').includes('text/event-stream')) return route.abort();
      try {
        const response = await route.fetch({ headers: { ...request.headers(), origin: STAGE_SITE, referer: `${STAGE_SITE}/` }, timeout: 60000 });
        return await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      } catch {
        return route.abort();
      }
    });
  }

  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`manager: ${e.message.split('\n')[0]}`));
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60000 });
  results.push('logged in through the login page');

  api = String(runtimeConfig?.apiUrl ?? '').replace(/\/$/, '');
  assert.match(api, /^https:\/\//, 'runtime config gives the backend URL');
  if (!api.endsWith('/api/v1')) api = `${api}/api/v1`;
  const login = await fetch(`${api}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.ok(login.ok, `API login → ${login.status}`);
  const loginBody = await login.json();
  token = loginBody.accessToken ?? loginBody.access_token ?? loginBody.token;
  assert.ok(token, 'API token');

  // Switch the organisation setting on for the run; cost and note stay hidden.
  original = await settingsCall('GET');
  const codes = original.visibleCodes.filter((code) => code !== 'details.cost' && code !== 'details.note');
  for (const code of ['summary.number', 'summary.client', 'tab.basic', 'basic.client', 'tab.details', 'details.n', 'details.quantity', 'tab.finance', 'finance.final']) {
    if (!codes.includes(code)) codes.push(code);
  }
  await settingsCall('PUT', { enabled: true, visibleCodes: codes, expectedVersion: original.version });
  results.push('organisation switch turned on for the run');

  await page.goto(`${base}/orders/edit/${orderId}`, { waitUntil: 'domcontentloaded' });
  const present = page.getByRole('button', { name: 'Показать клиенту' });
  await expect(present).toBeVisible({ timeout: 120000 });
  results.push('order edit form shows «Показать клиенту»');

  const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 30000 }), present.click()]);
  popup.on('pageerror', (e) => errors.push(`customer: ${e.message.split('\n')[0]}`));
  assert.ok(new URL(popup.url()).pathname.endsWith('/client-screen.html'), 'the customer window is client-screen.html');
  await expect(popup.getByRole('heading', { level: 1 })).toHaveText(/Заказ № |Ваш заказ/, { timeout: 60000 });
  await expect(page.getByText('Клиент видит этот заказ')).toBeVisible({ timeout: 30000 });
  results.push(`customer window opened and shows: ${(await popup.getByRole('heading', { level: 1 }).innerText()).replace(/\d/g, '#')}`);
  assert.equal(await popup.evaluate(() => sessionStorage.length), 0, 'customer window sessionStorage is empty (noopener)');

  const selectedTab = () => popup.getByRole('tab', { selected: true });
  const managerTab = (name) => page.getByRole('tab', { name }).first();
  if (await managerTab(/Детали заказа|Состав/).count()) {
    await managerTab(/Детали заказа|Состав/).click();
    await expect(selectedTab()).toHaveText(/Детали заказа|Состав/, { timeout: 20000 });
    await expect(popup.locator('tbody tr[data-row-id]').first()).toBeVisible({ timeout: 20000 });
    assert.equal(await popup.getByRole('columnheader', { name: 'Сумма', exact: true }).count(), 0, 'hidden cost column is absent');
    assert.equal(await popup.getByRole('columnheader', { name: 'Примечание', exact: true }).count(), 0, 'hidden note column is absent');
    const headers = await popup.getByRole('columnheader').allInnerTexts();
    assert.ok(headers.includes('Кол-во'), `ticked quantity column is present (columns: ${headers.join(' | ')})`);
    results.push(`details tab mirrored with ${await popup.locator('tbody tr[data-row-id]').count()} rows; hidden columns absent`);

    await managerTab(/Финансы/).click();
    await expect(selectedTab()).toHaveText(/Финансы/, { timeout: 20000 });
    await managerTab(/Основная информация|Обзор/).click();
    await expect(selectedTab()).toHaveText(/Основная информация|Обзор/, { timeout: 20000 });
    await expect(popup.locator('.client-screen__field').first()).toBeVisible();
    results.push('tab switches mirrored');

    const unmirrored = managerTab(/ХДФ|Материалы|Дополнительно|Бирки/);
    if (await unmirrored.count() && await unmirrored.isEnabled()) {
      await unmirrored.click();
      await page.waitForTimeout(1500);
      await expect(selectedTab()).toHaveText(/Основная информация|Обзор/);
      results.push('tab that is not mirrored → the customer keeps the last mirrored tab');
    }
  } else {
    results.push('this layout has no tab bar (sections on one page): tab mirroring not exercised');
  }

  await page.getByRole('button', { name: 'Скрыть от клиента' }).click();
  await expect(popup.getByText('Здесь появится ваш заказ')).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('button', { name: 'Показать клиенту' })).toBeVisible();
  results.push('«Скрыть от клиента» → splash');

  await page.getByRole('button', { name: 'Показать клиенту' }).click();
  await expect(popup.getByRole('heading', { level: 1 })).toHaveText(/Заказ № |Ваш заказ/, { timeout: 30000 });

  // Emergency switch-off from ANOTHER app tab, which presents nothing itself.
  const other = await context.newPage();
  other.on('pageerror', (e) => errors.push(`manager-2: ${e.message.split('\n')[0]}`));
  await other.goto(`${base}/orders/edit/${orderId}`, { waitUntil: 'domcontentloaded' });
  const emergency = other.getByRole('button', { name: 'Отключить экран клиента' });
  await expect(emergency).toBeVisible({ timeout: 120000 });
  await expect(other.getByText('Клиент видит этот заказ')).toHaveCount(0);
  await emergency.click();
  await other.getByRole('button', { name: 'Отключить', exact: true }).click();
  await expect(other.getByText('Экран клиента отключён')).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Экран клиента отключён')).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => popup.isClosed() || await popup.getByText('Экран клиента отключён').count() > 0, { timeout: 20000 }).toBe(true);
  results.push(`emergency switch-off from an idle second tab: presenting tab stopped, customer window ${popup.isClosed() ? 'closed' : 'shows the "disabled" splash'}`);
  await other.close();
  await page.getByRole('button', { name: 'Включить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Показать клиенту' })).toBeVisible({ timeout: 20000 });
  results.push('re-enabled: the button is back, nothing is presented');

  assert.deepEqual([...new Set(errors)], [], 'no page errors');
  console.log(JSON.stringify({ live: 'passed', base: new URL(base).host, results }, null, 1));
} catch (error) {
  console.log(JSON.stringify({
    live: 'failed', results,
    pageErrors: [...new Set(errors)].slice(0, 5).map((text) => printableError({ name: 'page', message: text }, secrets)),
    error: printableError(error, secrets),
  }, null, 1));
  process.exitCode = 1;
} finally {
  // Restore the shared stage setting exactly, whatever happened above, and prove it.
  if (api && token && original) {
    try {
      const current = await settingsCall('GET');
      await settingsCall('PUT', { enabled: original.enabled, visibleCodes: original.visibleCodes, expectedVersion: current.version });
      const after = await settingsCall('GET');
      const restored = after.enabled === original.enabled && JSON.stringify(after.visibleCodes) === JSON.stringify(original.visibleCodes);
      console.log(JSON.stringify({ settingsRestored: restored, enabled: after.enabled, codes: after.visibleCodes.length }));
      if (!restored) process.exitCode = 1;
    } catch (error) {
      console.log(JSON.stringify({ settingsRestored: false, error: printableError(error, secrets) }));
      process.exitCode = 1;
    }
  }
  await browser.close();
}
