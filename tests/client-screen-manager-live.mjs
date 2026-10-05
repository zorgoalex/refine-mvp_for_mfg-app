import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import {
  createSettingsChange, isForbiddenDataRequest, isStageRelayTarget, settingsRestorePlan, stageTargetProblem, STAGE_SITE,
} from './helpers/clientScreenLiveGuards.mjs';
import { printableError } from './helpers/redactSecrets.mjs';
import { vercelBypassCookies } from './helpers/vercelBypass.mjs';

// Live check of the manager side in the real application against the stage backend: log in, open a
// test order, present it, follow tabs, hide, emergency switch-off. Nothing is saved in the order.
// The organisation setting is switched on for the run and restored in `finally` (and verified): only
// what this run itself changed, and only if nobody changed it since. Runs against the stage backend
// only: a deployment configured for any other backend is refused before logging in.
// Env: BASE_URL (a built deployment), ORDER_ID (an existing test order), CODEX_PLAYWRIGHT_USERNAME /
// CODEX_PLAYWRIGHT_PASSWORD, optional VERCEL_AUTOMATION_BYPASS_SECRET, optional LAYOUT=legacy,
// optional SELF_INTERRUPT=1 | during, optional ROLLBACK=1.
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
// This run's own change of the setting: what was sent and what the server answered.
const change = createSettingsChange();
const settingsRequest = (method, body) => fetch(`${api}/client-screen/settings`, {
  method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const settingsCall = async (method, body) => {
  const response = await settingsRequest(method, body);
  assert.ok(response.ok, `${method} client-screen settings → ${response.status}`);
  return response.json();
};

// Restores the shared stage setting and proves it. Only this run's own change is undone: if the run
// changed nothing there is nothing to restore, and if somebody else changed the setting meanwhile
// the server refuses (409) and their change stays. A backend that is briefly away (a redeploy) is
// retried: the request is conditional on the version, so repeating it is safe.
let restoring = null;
const restoreSettings = () => {
  restoring ??= (async () => {
    // A change that is still on its way is waited for: its answer decides what to undo.
    await change.settle(20000);
    const plan = settingsRestorePlan(original, change.outcome());
    if (plan.action === 'none') {
      console.log(JSON.stringify({ settingsRestored: 'not needed', reason: plan.reason }));
      return;
    }
    if (plan.action !== 'restore') {
      console.log(JSON.stringify({ settingsRestored: false, reconcile: plan.reason }));
      process.exitCode = 1;
      return;
    }
    const restore = plan.request;
    let failure = 'not attempted';
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        const response = await settingsRequest('PUT', restore);
        if (response.status === 409) {
          console.log(JSON.stringify({ settingsRestored: false, reason: 'the setting was changed by someone else during the run; left as it is' }));
          process.exitCode = 1;
          return;
        }
        if (response.ok) {
          const after = await settingsCall('GET');
          const restored = after.enabled === original.enabled && JSON.stringify(after.visibleCodes) === JSON.stringify(original.visibleCodes);
          console.log(JSON.stringify({ settingsRestored: restored, enabled: after.enabled, codes: after.visibleCodes.length, attempt }));
          if (!restored) process.exitCode = 1;
          return;
        }
        failure = `PUT client-screen settings → ${response.status}`;
      } catch (error) {
        failure = printableError(error, secrets);
      }
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    console.log(JSON.stringify({ settingsRestored: false, error: failure }));
    process.exitCode = 1;
  })();
  return restoring;
};
// A run that is stopped from outside (the host's load guard sends SIGINT, then SIGTERM; Ctrl+C)
// still puts the setting back, then closes its browser and ends.
let browserToClose = null;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    void restoreSettings()
      .then(() => browserToClose?.close().catch(() => undefined))
      .finally(() => process.exit(1));
  });
}

// Playwright's own signal handlers end the process at once; here the setting has to be put back
// first, so the signals are handled by this script alone (see restoreSettings above).
const browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
browserToClose = browser;
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const cookies = await vercelBypassCookies(base, bypass);
  if (cookies.length) await context.addCookies(cookies);
  // A preview deployment has the customer screen flag off; this run switches it on for its own browser only.
  let runtimeConfig = null;
  let targetProblem = null;
  await context.route(/runtime-config/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    // A deployment of any backend but stage does not get its configuration: the app cannot start.
    targetProblem = stageTargetProblem(json);
    if (targetProblem) return route.abort();
    runtimeConfig = json;
    // LAYOUT=legacy forces the classic layout with a tab bar, whatever the test user prefers.
    const ui = process.env.LAYOUT === 'legacy' ? { ...(json.ui ?? {}), evolutionEnabled: false, forceLegacy: true } : json.ui;
    await route.fulfill({ response, json: { ...json, ui, features: { ...(json.features ?? {}), clientScreen: true } } });
  });

  // Data calls of the page go to its own site and to the two stage endpoints, and nowhere else:
  // whatever address is built into the bundle, nothing authenticated can reach another backend.
  const pageOriginForData = new URL(base).origin;
  await context.route((url) => url.origin !== pageOriginForData, (route) => (
    isForbiddenDataRequest(route.request().url(), route.request().resourceType(), pageOriginForData) ? route.abort() : route.fallback()
  ));
  await context.routeWebSocket((url) => isForbiddenDataRequest(url.href, 'websocket', pageOriginForData), (socket) => socket.close());

  // The stage backend and Hasura accept browser calls only from the stage site. When the build under
  // test is a preview deployment, its calls to them (and to nothing else) are relayed by this script
  // as if they came from the stage site; on the stage site itself nothing is relayed.
  const pageOrigin = new URL(base).origin;
  if (pageOrigin !== STAGE_SITE) {
    const cors = { 'access-control-allow-origin': pageOrigin, 'access-control-allow-credentials': 'true', vary: 'Origin' };
    await context.route((url) => isStageRelayTarget(url.href), async (route) => {
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
  // No credentials are typed and nothing is written before the deployment's backend is known to be stage.
  await expect.poll(() => runtimeConfig !== null || targetProblem !== null, { timeout: 60000 }).toBe(true);
  assert.equal(targetProblem, null, `refusing to run: ${targetProblem}`);
  assert.equal(stageTargetProblem(runtimeConfig), null, 'the deployment talks to the stage backend');
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
  // CLIENT_PHONE=1: the client's phone is ticked for the run (needs a backend that knows the code).
  if (process.env.CLIENT_PHONE === '1' && !codes.includes('summary.client_phone')) codes.push('summary.client_phone');
  // HEADER=1: the lines of the order header are ticked for the run (needs a backend that knows the codes).
  const headerCodes = ['summary.order_name', 'summary.deadline', 'summary.positions', 'summary.material', 'summary.milling_type', 'summary.edge_type',
    'summary.film', 'summary.paid', 'summary.discount', 'summary.surcharge'];
  if (process.env.HEADER === '1') for (const code of headerCodes) if (!codes.includes(code)) codes.push(code);
  const switching = change.run(async () => {
    const response = await settingsRequest('PUT', { enabled: true, visibleCodes: codes, expectedVersion: original.version });
    return { ok: response.ok, status: response.status, body: response.ok ? await response.json() : null };
  });
  // SELF_INTERRUPT=during proves the interruption path while the change is still on its way.
  if (process.env.SELF_INTERRUPT === 'during') process.kill(process.pid, 'SIGINT');
  const switched = await switching;
  assert.ok(switched.ok, `PUT client-screen settings → ${switched.status}`);
  results.push('organisation switch turned on for the run');
  // SELF_INTERRUPT=1 proves the interruption path: the run stops itself here, as the load guard would.
  if (process.env.SELF_INTERRUPT === '1') process.kill(process.pid, 'SIGINT');

  await page.goto(`${base}/orders/edit/${orderId}`, { waitUntil: 'domcontentloaded' });
  const present = page.getByRole('button', { name: 'Показать клиенту' });
  await expect(present).toBeVisible({ timeout: 120000 });
  results.push('order edit form shows «Показать клиенту»');

  const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 30000 }), present.click()]);
  popup.on('pageerror', (e) => errors.push(`customer: ${e.message.split('\n')[0]}`));
  assert.ok(new URL(popup.url()).pathname.endsWith('/client-screen.html'), 'the customer window is client-screen.html');
  await expect(popup.getByRole('heading', { level: 1 })).toHaveText(/Заказ |Ваш заказ/, { timeout: 60000 });
  await expect(page.getByText('Клиент видит этот заказ')).toBeVisible({ timeout: 30000 });
  results.push(`customer window opened and shows: ${(await popup.getByRole('heading', { level: 1 }).innerText()).replace(/\d/g, '#')}`);
  assert.equal(await popup.evaluate(() => sessionStorage.length), 0, 'customer window sessionStorage is empty (noopener)');
  if (process.env.CLIENT_PHONE === '1') {
    await expect(popup.locator('.client-screen__chip').filter({ hasText: 'Телефон клиента' })).toHaveCount(1, { timeout: 30000 });
    results.push('the client phone is on the customer screen when ticked');
  } else {
    assert.equal(await popup.locator('.client-screen__chip').filter({ hasText: 'Телефон клиента' }).count(), 0, 'the client phone is not shown unless ticked');
  }

  if (process.env.HEADER === '1') {
    const chips = await popup.locator('.client-screen__chip').allInnerTexts();
    for (const label of ['Срок выполнения', 'Позиций', 'Материал', 'Фрезеровка', 'Обкат', 'Плёнка']) {
      assert.ok(chips.some((chip) => chip.startsWith(`${label}:`)), `the header shows «${label}» (header: ${chips.map((chip) => chip.split(':')[0]).join(' | ')})`);
    }
    assert.ok(chips.every((chip) => !/Статус|Приоритет|Проект/i.test(chip)), 'no statuses, priority or project in the customer header');
    await expect(popup.getByRole('heading', { level: 1 })).toHaveText(/^Заказ /);
    results.push(`customer header mirrors the order header: ${chips.map((chip) => chip.split(':')[0]).join(', ')}`);
  }

  // App header: the eye and the emergency button exist only while something is presented; the eye
  // shows a miniature of exactly what the customer sees. The presenting workspace tab is marked.
  const eye = page.getByRole('button', { name: 'Что видит клиент' });
  await expect(eye).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('button', { name: 'Отключить экран клиента' })).toBeVisible();
  await eye.hover();
  const miniature = page.locator('[role="dialog"][aria-label="Экран клиента"] .client-screen-preview');
  await expect(miniature).toBeVisible({ timeout: 10000 });
  await expect(miniature.locator('.client-screen__title')).toHaveText(await popup.getByRole('heading', { level: 1 }).innerText());
  assert.deepEqual(
    await miniature.locator('.client-screen__tab').allInnerTexts(),
    await popup.locator('.client-screen__tab').allInnerTexts(),
    'the miniature has the customer\'s tabs',
  );
  await page.mouse.move(5, 400);
  await expect(miniature).toHaveCount(0, { timeout: 10000 });
  const tabEyes = page.locator('.workspace-tabs .client-screen-tab-eye');
  const hasWorkspaceTabs = await page.locator('.workspace-tabs').count() > 0;
  if (hasWorkspaceTabs) {
    await expect(tabEyes).toHaveCount(1, { timeout: 10000 });
    // The presenting tab stands out: light orange, unlike the other tabs.
    const tabColour = (locator) => locator.evaluate((element) => getComputedStyle(element.closest('.ant-tabs-tab')).backgroundColor);
    assert.equal(await tabColour(tabEyes.first()), 'rgb(255, 231, 186)', 'the presenting workspace tab is light orange');
  }
  results.push(`app header: eye with a live miniature and the emergency button${hasWorkspaceTabs ? '; the presenting workspace tab is marked' : ''}`);

  // Leaving the order (another page of the app) does not take it away from the customer.
  const shownBefore = await popup.getByRole('heading', { level: 1 }).innerText();
  await page.evaluate(() => {
    window.history.pushState({}, '', '/orders');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.waitForURL((url) => url.pathname === '/orders', { timeout: 20000 });
  await page.waitForTimeout(3000);
  await expect(popup.getByRole('heading', { level: 1 })).toHaveText(shownBefore);
  await expect(eye).toBeVisible();
  if (hasWorkspaceTabs) await expect(tabEyes).toHaveCount(1);
  await eye.click();
  await page.locator('[role="dialog"][aria-label="Экран клиента"]').getByRole('button', { name: 'Перейти к заказу' }).click();
  await page.waitForURL((url) => url.pathname === `/orders/edit/${orderId}`, { timeout: 20000 });
  await expect(page.getByText('Клиент видит этот заказ')).toBeVisible({ timeout: 30000 });
  await expect(popup.getByRole('heading', { level: 1 })).toHaveText(shownBefore);
  // The pointer is still over the eye: move it away so that the panel closes.
  await page.mouse.move(5, 400);
  await expect(page.locator('[role="dialog"][aria-label="Экран клиента"]')).toHaveCount(0, { timeout: 10000 });
  results.push('switching to another page keeps the order on the customer screen; «Перейти к заказу» returns to it');

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
    // The row number is always the first column, and the column headers stay in sight while the list scrolls.
    assert.equal(headers[0], '№', `the row number is the first column (columns: ${headers.join(' | ')})`);
    const firstHeader = popup.getByRole('columnheader').first();
    assert.equal(await firstHeader.evaluate((element) => getComputedStyle(element).position), 'sticky', 'column headers are sticky');
    await popup.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const stuck = await popup.evaluate(() => {
      const head = document.querySelector('.client-screen__head').getBoundingClientRect();
      const header = document.querySelector('.client-screen__table th').getBoundingClientRect();
      return { headBottom: Math.round(head.bottom), headerTop: Math.round(header.top), headerBottom: Math.round(header.bottom), viewport: window.innerHeight };
    });
    assert.ok(Math.abs(stuck.headerTop - stuck.headBottom) <= 2 && stuck.headerBottom <= stuck.viewport,
      `with the list scrolled to its end the column headers sit right under the order header (${JSON.stringify(stuck)})`);
    await popup.evaluate(() => window.scrollTo(0, 0));
    results.push(`details tab mirrored with ${await popup.locator('tbody tr[data-row-id]').count()} rows; hidden columns absent`);

    // The manager's page of the table: the customer sees the same rows, not the whole list.
    const customerRows = popup.locator('tbody tr[data-row-id]');
    const managerRows = page.locator('.ant-table-tbody tr[data-row-key]');
    const pageTwo = page.locator('.ant-pagination-item-2');
    if (await pageTwo.count()) {
      const firstPage = await customerRows.count();
      await pageTwo.first().click();
      await expect.poll(() => customerRows.count(), { timeout: 20000 }).not.toBe(firstPage);
      const secondPage = await customerRows.count();
      await page.locator('.ant-pagination-item-1').first().click();
      await expect.poll(() => customerRows.count(), { timeout: 20000 }).toBe(firstPage);
      results.push(`the table page is mirrored: ${firstPage} rows on page 1, ${secondPage} on page 2`);
    }

    // A value being typed is seen at once, in the same cell, and disappears when the edit is cancelled.
    // Nothing is saved: the edit is cancelled with Escape and the order is never submitted.
    const editable = managerRows.first().locator('td[data-order-detail-spreadsheet-cell="true"][aria-keyshortcuts^="Enter"]').first();
    await editable.dblclick();
    await expect(page.locator('.ant-table-tbody input:focus')).toHaveCount(1, { timeout: 20000 });
    await expect(popup.locator('td[data-focused="true"]')).toHaveCount(1, { timeout: 20000 });
    const before = await popup.locator('td[data-focused="true"]').innerText();
    await page.keyboard.type('777');
    // The customer's cell shows what the manager's editor holds (the same digits), marked as being edited.
    const digits = (text) => text.replace(/\D/g, '');
    const typed = digits(await page.locator('.ant-table-tbody input:focus').inputValue());
    assert.ok(typed.includes('777') && typed !== digits(before), 'the editor took the typed digits');
    await expect.poll(async () => digits(await popup.locator('td[data-focused="true"]').innerText()), { timeout: 20000 }).toBe(typed);
    await expect(popup.locator('td[data-focused="true"].client-screen__cell--edited')).toHaveCount(1);
    const editedCells = await popup.locator('td.client-screen__cell--edited').count();
    await page.keyboard.press('Escape');
    await expect(popup.locator('td.client-screen__cell--edited')).toHaveCount(0, { timeout: 20000 });
    await expect.poll(async () => (await popup.locator('tbody tr[data-row-id]').first().innerText()).replace(/\D/g, '').includes(typed), { timeout: 20000 }).toBe(false);
    results.push(`live edit mirrored: the customer saw the typed value in the same cell (${editedCells} cell(s) changed live), back to the saved value after Escape`);

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
  await expect(page.getByRole('button', { name: 'Что видит клиент' })).toHaveCount(0, { timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Отключить экран клиента' })).toHaveCount(0);
  results.push('«Скрыть от клиента» → splash; the header eye and the emergency button are gone');

  await page.getByRole('button', { name: 'Показать клиенту' }).click();
  await expect(popup.getByRole('heading', { level: 1 })).toHaveText(/Заказ |Ваш заказ/, { timeout: 30000 });

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

  // The order VIEW page presents the same order from what it has loaded itself.
  await page.goto(`${base}/orders/show/${orderId}`, { waitUntil: 'domcontentloaded' });
  const presentView = page.getByRole('button', { name: 'Показать клиенту' });
  await expect(presentView).toBeVisible({ timeout: 120000 });
  await expect(presentView).toBeEnabled({ timeout: 120000 });
  const [viewPopup] = await Promise.all([context.waitForEvent('page', { timeout: 30000 }), presentView.click()]);
  viewPopup.on('pageerror', (e) => errors.push(`customer (view): ${e.message.split('\n')[0]}`));
  await expect(viewPopup.getByRole('heading', { level: 1 })).toHaveText(/Заказ |Ваш заказ/, { timeout: 60000 });
  await expect(page.getByText('Клиент видит этот заказ')).toBeVisible({ timeout: 30000 });
  await expect(viewPopup.getByRole('tab', { selected: true })).toHaveText(/Детали заказа/, { timeout: 20000 });
  await expect(viewPopup.locator('tbody tr[data-row-id]').first()).toBeVisible({ timeout: 20000 });
  assert.equal(await viewPopup.getByRole('columnheader', { name: 'Сумма', exact: true }).count(), 0, 'view: hidden cost column is absent');
  assert.equal(await viewPopup.getByRole('columnheader', { name: 'Примечание', exact: true }).count(), 0, 'view: hidden note column is absent');
  const viewHeaders = await viewPopup.getByRole('columnheader').allInnerTexts();
  assert.ok(viewHeaders.includes('Кол-во'), `view: ticked quantity column is present (columns: ${viewHeaders.join(' | ')})`);
  results.push(`view page presented: ${await viewPopup.locator('tbody tr[data-row-id]').count()} detail rows, hidden columns absent`);
  const financePanel = page.locator('.order-show-info-tabs [role="tab"]').filter({ hasText: 'Финансы' });
  if (await financePanel.count()) {
    await financePanel.first().click();
    await expect(viewPopup.getByRole('tab', { selected: true })).toHaveText(/Финансы/, { timeout: 20000 });
    await page.locator('.order-show-info-tabs [role="tab"]').filter({ hasText: 'Группы заказа' }).first().click();
    await expect(viewPopup.getByRole('tab', { selected: true })).toHaveText(/Детали заказа/, { timeout: 20000 });
    results.push('view page: the finance panel is mirrored as the finance tab; any other panel shows the detail table');
  }
  await page.getByRole('button', { name: 'Скрыть от клиента' }).click();
  await expect(viewPopup.getByText('Здесь появится ваш заказ')).toBeVisible({ timeout: 20000 });
  results.push('view page: «Скрыть от клиента» → splash');

  // Rollback on a running presentation: the organisation switch is turned off while the customer
  // sees the order; within a minute the customer is back on the splash, without any reload.
  if (process.env.ROLLBACK === '1') {
    await page.getByRole('button', { name: 'Показать клиенту' }).click();
    await expect(viewPopup.getByRole('heading', { level: 1 })).toHaveText(/Заказ |Ваш заказ/, { timeout: 30000 });
    const mine = change.outcome().applied;
    const startedAt = Date.now();
    const off = await change.run(async () => {
      const response = await settingsRequest('PUT', { enabled: false, visibleCodes: mine.visibleCodes, expectedVersion: mine.version });
      return { ok: response.ok, status: response.status, body: response.ok ? await response.json() : null };
    });
    assert.ok(off.ok, `PUT client-screen settings (switch off) → ${off.status}`);
    await expect(viewPopup.getByRole('heading', { level: 1 })).toHaveCount(0, { timeout: 90000 });
    await expect(page.getByText('Клиент видит этот заказ')).toHaveCount(0, { timeout: 30000 });
    results.push(`rollback: switched off in the settings during a presentation → the customer lost the order in ${Math.round((Date.now() - startedAt) / 1000)} s`);
  }

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
  await restoreSettings();
  await browser.close();
}
