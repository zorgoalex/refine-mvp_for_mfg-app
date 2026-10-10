import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import {
  createSettingsChange, customerWindowBlockedProblem, customerWindowRequestProblem, expectedMaterialColumns, frameDifferences, frameText,
  isForbiddenDataRequest, isStageRelayTarget, isStageSettingsRequest, settingsRestorePlan, stageTargetProblem, STAGE_SITE,
} from './helpers/clientScreenLiveGuards.mjs';
import { FRAME_CONTROL_SELECTOR, readCopy, readManagerTab } from './helpers/clientScreenFrameLive.mjs';
import { printableError } from './helpers/redactSecrets.mjs';
import { vercelBypassCookies } from './helpers/vercelBypass.mjs';

// Live check of the manager side in the real application against the stage backend: log in, open a
// test order, present it, follow tabs, hide, emergency switch-off. Nothing is saved in the order.
// When the organisation has not switched the customer screen on, the setting is switched on for the
// run and restored in `finally` (and verified): only
// what this run itself changed, and only if nobody changed it since. Runs against the stage backend
// only: a deployment configured for any other backend is refused before logging in.
// Env: BASE_URL (a built deployment), ORDER_ID (an existing test order), CODEX_PLAYWRIGHT_USERNAME /
// CODEX_PLAYWRIGHT_PASSWORD, optional VERCEL_AUTOMATION_BYPASS_SECRET, optional LAYOUT=legacy,
// optional SELF_INTERRUPT=1 | during, optional ROLLBACK=1,
// optional EXTRA_CODES=code,code (read-only mode only).
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
  // Everything any window asks the network for and everything the browser refuses to load is noted
  // from the very start; what the customer window did is judged at the end (see customerWindowProblems).
  const asked = [];
  const refused = [];
  const pageOf = (source) => {
    try {
      return source.frame().page();
    } catch {
      return null;
    }
  };
  context.on('request', (request) => asked.push({ page: pageOf(request), url: request.url(), type: request.resourceType() }));
  context.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) refused.push({ page: message.page(), text: message.text() });
  });
  const isCustomerWindow = (target) => {
    try {
      return Boolean(target) && new URL(target.url()).pathname.endsWith('/client-screen.html');
    } catch {
      return false;
    }
  };
  const customerWindowProblems = () => {
    const origin = new URL(base).origin;
    return [...new Set([
      ...asked.filter((entry) => isCustomerWindow(entry.page)).map((entry) => customerWindowRequestProblem(entry.url, entry.type, origin)),
      ...refused.filter((entry) => isCustomerWindow(entry.page)).map((entry) => customerWindowBlockedProblem(entry.text, origin)),
    ].filter(Boolean))];
  };
  const cookies = await vercelBypassCookies(base, bypass);
  if (cookies.length) await context.addCookies(cookies);
  // A preview deployment has the customer screen flag off; this run switches it on for its own browser only.
  let runtimeConfig = null;
  let targetProblem = null;
  // EXTRA_CODES=a,b,c: these codes are added to the settings the app under test reads (its GET of
  // the settings is rewritten in this browser only). Nothing is written anywhere: it lets a build
  // be checked with codes the deployed backend does not know yet.
  const extraCodes = (process.env.EXTRA_CODES ?? '').split(',').map((code) => code.trim()).filter(Boolean);
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

  // Registered last, so that it is asked first (before the relay of stage calls).
  if (extraCodes.length) {
    // Only the stage backend's own settings address: any other request goes on to the destination guard untouched.
    await context.route((url) => isStageSettingsRequest(url.href), async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch({ headers: { ...route.request().headers(), origin: STAGE_SITE, referer: `${STAGE_SITE}/` } });
      if (!response.ok()) return route.fulfill({ response });
      const json = await response.json();
      const visibleCodes = [...json.visibleCodes, ...extraCodes.filter((code) => !json.visibleCodes.includes(code))];
      return route.fulfill({ response, json: { ...json, visibleCodes }, headers: { ...response.headers(), 'access-control-allow-origin': new URL(base).origin, 'access-control-allow-credentials': 'true' } });
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
  // An organisation that already uses the customer screen is not touched at all: the check runs with
  // the settings in force and writes nothing (a run stopped from outside cannot leave them changed).
  // CHANGE_SETTINGS=1 forces the old behaviour: switch on, hide cost and note, tick what the steps need.
  const readOnly = original.enabled === true && process.env.CHANGE_SETTINGS !== '1';
  const codes = readOnly ? [...original.visibleCodes] : original.visibleCodes.filter((code) => code !== 'details.cost' && code !== 'details.note');
  // Codes added for this browser only (EXTRA_CODES) are in force for the app under test.
  for (const code of extraCodes) if (readOnly && !codes.includes(code)) codes.push(code);
  if (!readOnly) {
    for (const code of ['summary.number', 'summary.client', 'tab.basic', 'basic.client', 'tab.details', 'details.n', 'details.quantity', 'tab.finance', 'finance.final']) {
      if (!codes.includes(code)) codes.push(code);
    }
  }
  // CLIENT_PHONE=1: the client's phone is ticked for the run (needs a backend that knows the code).
  if (!readOnly && process.env.CLIENT_PHONE === '1' && !codes.includes('summary.client_phone')) codes.push('summary.client_phone');
  // HEADER=1: the lines of the order header are ticked for the run (needs a backend that knows the codes).
  const headerCodes = ['summary.order_name', 'summary.deadline', 'summary.positions', 'summary.material', 'summary.milling_type', 'summary.edge_type',
    'summary.film', 'summary.paid', 'summary.discount', 'summary.surcharge'];
  if (!readOnly && process.env.HEADER === '1') for (const code of headerCodes) if (!codes.includes(code)) codes.push(code);
  // HDF=1: the HDF tab with all its fields and columns is ticked for the run (needs a backend that knows the codes).
  if (!readOnly && process.env.HDF === '1') {
    for (const code of ['tab.hdf', 'hdf.min_threshold', 'hdf.total', 'hdf.position', 'hdf.milling_type', 'hdf.height', 'hdf.width', 'hdf.quantity', 'hdf.area', 'hdf.status']) {
      if (!codes.includes(code)) codes.push(code);
    }
  }
  if (readOnly) {
    results.push(`customer screen is already switched on by the organisation: its ${codes.length} ticks are used as they are, nothing is written`);
  } else {
    const switching = change.run(async () => {
      const response = await settingsRequest('PUT', { enabled: true, visibleCodes: codes, expectedVersion: original.version });
      return { ok: response.ok, status: response.status, body: response.ok ? await response.json() : null };
    });
    // SELF_INTERRUPT=during proves the interruption path while the change is still on its way.
    if (process.env.SELF_INTERRUPT === 'during') process.kill(process.pid, 'SIGINT');
    const switched = await switching;
    assert.ok(switched.ok, `PUT client-screen settings → ${switched.status}`);
    results.push('organisation switch turned on for the run');
  }
  // SELF_INTERRUPT=1 proves the interruption path: the run stops itself here, as the load guard would.
  if (!readOnly && process.env.SELF_INTERRUPT === '1') process.kill(process.pid, 'SIGINT');

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
  // The organisation may have ticked the phone itself: the check follows the codes actually in force.
  if (codes.includes('summary.client_phone')) {
    await expect(popup.locator('.client-screen__chip').filter({ hasText: 'Телефон клиента' })).toHaveCount(1, { timeout: 30000 });
    results.push('the client phone is on the customer screen when ticked');
  } else {
    assert.equal(await popup.locator('.client-screen__chip').filter({ hasText: 'Телефон клиента' }).count(), 0, 'the client phone is not shown unless ticked');
  }

  if (headerCodes.every((code) => codes.includes(code))) {
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

  // Steps follow the ticks in force: what the organisation has not ticked is not expected, and is reported as skipped.
  const has = (code) => codes.includes(code);
  const skipped = (what) => results.push(`skipped (not ticked in the settings in force): ${what}`);
  const selectedTab = () => popup.getByRole('tab', { selected: true });
  const WHOLE_TABS = [
    { code: 'tab.cut', key: 'cut', name: /^Раскрой$/ },
    { code: 'tab.workshops', key: 'workshops', name: /^(Цеха|Производство)$/ },
    { code: 'tab.additional', key: 'additional', name: /^(Дополнительно|Бирки)$/ },
  ];
  const managerTab = (name) => page.getByRole('tab', { name }).first();
  if (!has('tab.details')) skipped('the detail list and everything on it');
  else if (await managerTab(/Детали заказа|Состав/).count()) {
    await managerTab(/Детали заказа|Состав/).click();
    await expect(selectedTab()).toHaveText(/Детали заказа|Состав/, { timeout: 20000 });
    await expect(popup.locator('tbody tr[data-row-id]').first()).toBeVisible({ timeout: 20000 });
    if (!codes.includes('details.cost')) assert.equal(await popup.getByRole('columnheader', { name: 'Сумма', exact: true }).count(), 0, 'hidden cost column is absent');
    if (!codes.includes('details.note')) assert.equal(await popup.getByRole('columnheader', { name: 'Примечание', exact: true }).count(), 0, 'hidden note column is absent');
    const headers = await popup.getByRole('columnheader').allInnerTexts();
    if (codes.includes('details.quantity')) assert.ok(headers.includes('Кол-во'), `ticked quantity column is present (columns: ${headers.join(' | ')})`);
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
    if (has('details.height')) {
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
    } else skipped('live edit of a cell (the height column)');

    const tabSwitches = has('tab.finance') && has('tab.basic');
    if (tabSwitches) {
      await managerTab(/Финансы/).click();
      await expect(selectedTab()).toHaveText(/Финансы/, { timeout: 20000 });
      await managerTab(/Основная информация|Обзор/).click();
      await expect(selectedTab()).toHaveText(/Основная информация|Обзор/, { timeout: 20000 });
      // The tab has fields on screen only when the organisation ticked at least one of them.
      if (codes.some((code) => code.startsWith('basic.'))) await expect(popup.locator('.client-screen__field').first()).toBeVisible();
      else await expect(popup.locator('.client-screen__field')).toHaveCount(0);
      results.push('tab switches mirrored');
    } else skipped('tab switches between «Финансы» and «Основная информация»');

    // The HDF tab is mirrored only when the organisation ticked it; otherwise the customer keeps the last tab.
    const hdfTab = managerTab(/^ХДФ$/);
    if (!has('tab.hdf')) skipped('the HDF tab');
    else if (!tabSwitches) skipped('the HDF tab (needs the basic and finance tabs to return to)');
    else if (!(await hdfTab.count())) results.push('this layout of the form has no HDF tab: nothing to mirror');
    else {
      await hdfTab.click();
      await expect(selectedTab()).toHaveText(/ХДФ/, { timeout: 20000 });
      results.push('HDF tab mirrored');
      await managerTab(/Основная информация|Обзор/).click();
      await expect(selectedTab()).toHaveText(/Основная информация|Обзор/, { timeout: 20000 });
    }
    // The «Материалы» tab reports its own tables; it is mirrored once the manager opens it.
    const materialsTab = managerTab(/^Материалы$/);
    if (!has('tab.requirements')) skipped('the materials tab');
    else if (!tabSwitches) skipped('the materials tab (needs the basic and finance tabs to return to)');
    else if (!(await materialsTab.count())) results.push('this layout of the form has no materials tab: nothing to mirror');
    else {
      await materialsTab.click();
      await expect(selectedTab()).toHaveText(/Материалы/, { timeout: 30000 });
      // What must be there: the ticked columns that the manager's own table has, in the tab's order.
      // A table with no such column is not shown. Content is compared with the manager's tables.
      const FILM_COLUMNS = [['film_name', 'Пленка'], ['film_area', 'м²'], ['film_details', 'Детали'], ['film_meters', 'Пог. м'], ['film_sheets', 'Листы'],
        ['film_cut_jobs', 'Раскрои'], ['film_stock', 'На складе, пог. м'], ['film_coverage', 'Покрытие']].map(([field, label]) => ({ code: `requirements.${field}`, label }));
      const SHEET_COLUMNS = [['sheet_name', 'Материал'], ['sheet_area', 'Кол-во м²'], ['sheet_details', 'Кол-во деталей'], ['sheet_stock', 'На складе (1С)'],
        ['sheet_coverage', 'Покрытие']].map(([field, label]) => ({ code: `requirements.${field}`, label }));
      const managerTables = page.locator('.ant-tabs-tabpane-active .ant-table');
      await expect(managerTables).toHaveCount(2, { timeout: 30000 });
      const managerHeaders = async (index) => (await managerTables.nth(index).locator('thead th').allInnerTexts()).map((text) => text.trim()).filter(Boolean);
      const expected = [
        { title: 'Пленка', managerIndex: 0, headers: expectedMaterialColumns(FILM_COLUMNS, codes, await managerHeaders(0)) },
        { title: 'Листовые материалы', managerIndex: 1, headers: expectedMaterialColumns(SHEET_COLUMNS, codes, await managerHeaders(1)) },
      ].filter((table) => table.headers.length > 0);
      await expect.poll(() => popup.locator('.client-screen__subtitle').allInnerTexts(), { timeout: 30000 }).toEqual(expected.map((table) => table.title));
      const customerTables = popup.locator('.client-screen__table');
      await expect(customerTables).toHaveCount(expected.length);
      const described = [];
      for (const [index, table] of expected.entries()) {
        const customer = customerTables.nth(index);
        // Exactly the expected columns, in order: nothing the manager does not have, nothing ticked missing.
        assert.deepEqual(await customer.getByRole('columnheader').allInnerTexts(), table.headers, `materials «${table.title}»: columns`);
        const managerRows = managerTables.nth(table.managerIndex).locator('tbody tr.ant-table-row');
        const rowCount = await managerRows.count();
        // The customer has the manager's rows plus the totals row, when there are rows.
        await expect(customer.locator('tbody tr[data-row-id]')).toHaveCount(rowCount > 0 ? rowCount + 1 : 0, { timeout: 20000 });
        if (rowCount > 0 && ['Пленка', 'Материал'].includes(table.headers[0])) {
          const managerName = (await managerRows.first().locator('td').first().innerText()).trim();
          const customerName = (await customer.locator('tbody tr[data-row-id]').first().locator('td').first().innerText()).trim();
          assert.equal(customerName, managerName, `materials «${table.title}»: the first row names the same material as the manager table`);
          assert.equal((await customer.locator('tbody tr[data-row-id]').last().locator('td').first().innerText()).trim(), 'Итого', `materials «${table.title}»: the totals row is last`);
        }
        described.push(`${table.title} — ${table.headers.join(' | ')}; ${rowCount} row(s)`);
      }
      results.push(`materials tab mirrored and equal to the manager's tables: ${described.join('; ') || 'no ticked column that the manager has — no table shown'}`);
      await managerTab(/Основная информация|Обзор/).click();
      await expect(selectedTab()).toHaveText(/Основная информация|Обзор/, { timeout: 20000 });
    }
    // A tab shown whole whose tick is off is like a tab that is not mirrored at all.
    const offTab = WHOLE_TABS.find((tab) => !has(tab.code));
    const unmirrored = offTab ? managerTab(offTab.name) : null;
    if (tabSwitches && unmirrored && await unmirrored.count() && await unmirrored.isEnabled()) {
      await unmirrored.click();
      await page.waitForTimeout(1500);
      await expect(selectedTab()).toHaveText(/Основная информация|Обзор/);
      assert.equal(await popup.locator('iframe.client-screen__frame-box').count(), 0, 'a tab whose tick is off is not copied');
      results.push(`tab whose tick is off (${offTab.key}) → the customer keeps the last tab shown, nothing of it is copied`);
    }
  } else {
    results.push('this layout has no tab bar (sections on one page): tab mirroring not exercised');
  }

  // Tabs shown whole (cut, workshops, additional): the customer sees an inert copy of the manager's tab.
  const openSection = async (name) => {
    const tab = page.getByRole('tab', { name }).first();
    if (await tab.count()) {
      if (!(await tab.isEnabled())) return false;
      await tab.click();
      return true;
    }
    const anchor = page.locator('.wb-form-anchors__item').filter({ hasText: name }).first();
    if (!(await anchor.count()) || !(await anchor.isEnabled())) return false;
    await anchor.click();
    return true;
  };
  const copyEquals = async (key, where, scope, what) => {
    let manager = null;
    let copy = null;
    let problems = ['not compared yet'];
    const deadline = Date.now() + 45000;
    while (problems.length && Date.now() < deadline) {
      await page.waitForTimeout(400);
      manager = await page.evaluate(readManagerTab, [key, FRAME_CONTROL_SELECTOR]);
      copy = await where.evaluate(readCopy, [scope, FRAME_CONTROL_SELECTOR]);
      if (!manager || !copy) {
        problems = [`${manager ? 'the copy' : 'the tab of the manager'} is not on screen`];
        continue;
      }
      problems = [];
      if (frameText(manager.text) !== frameText(copy.text)) problems.push(`texts differ (${frameText(manager.text).length} and ${frameText(copy.text).length} characters)`);
      if (manager.images !== copy.images) problems.push(`pictures: ${manager.images} on the tab, ${copy.images} in the copy`);
      if (copy.brokenImages || copy.emptyImages) problems.push(`pictures not drawn: ${copy.brokenImages} broken, ${copy.emptyImages} empty`);
      if (manager.width !== copy.width) problems.push(`width ${manager.width} → ${copy.width}`);
      if (manager.viewport.join('x') !== copy.viewport.join('x')) problems.push(`window ${manager.viewport.join('x')} → ${copy.viewport.join('x')}`);
      problems.push(...frameDifferences(manager.controls, copy.controls));
      // Where a pinned bar of the app itself covers the tab on the manager's screen there is nothing to
      // compare: those bars are not part of the tab, the customer sees the tab's own content there.
      const glass = manager.seen.map((seen, index) => (seen === 'outside the tab' || seen === copy.seen[index] ? null : `«${seen}» → «${copy.seen[index]}»`)).filter(Boolean);
      if (glass.length) problems.push(`on the glass: ${glass.join('; ')}`);

      // The tab fills the area the customer looks at: its left edge at the edge, no blank above or below.
      const place = copy.place;
      if (Math.abs(place.left) > 2 || Math.abs(place.right - place.holderWidth) > 3 || place.top > 2 || place.bottom < place.holderHeight - 3 || place.holderHeight < 20) {
        problems.push(`the tab is not where the customer looks: ${JSON.stringify(place)}`);
      }
    }
    assert.ok(problems.length === 0, `${what}: the copy does not equal the manager's tab: ${problems.join('; ').replace(/\d{5,}/g, '#')}`);
    assert.equal(copy.sandbox, 'allow-same-origin', `${what}: the box runs no scripts`);
    assert.equal(copy.policy, `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data: ${new URL(base).origin}/assets/`, `${what}: the content policy of the box`);
    assert.equal(copy.policyFirst, true, `${what}: the policy is the first thing in the box`);
    assert.equal(copy.scripts, 0, `${what}: nothing that runs, embeds or submits is in the copy`);
    assert.equal(copy.handlers, 0, `${what}: no event handler is in the copy`);
    assert.deepEqual(copy.addressed, [], `${what}: nothing in the copy has an address`);
    return { manager, copy };
  };
  for (const tab of WHOLE_TABS) {
    if (!has(tab.code)) {
      skipped(`the ${tab.key} tab shown whole`);
      continue;
    }
    if (!(await openSection(tab.name))) {
      results.push(`this layout or this order has no enabled ${tab.key} tab: nothing to copy`);
      continue;
    }
    await expect(selectedTab()).toHaveText(tab.name, { timeout: 30000 });
    const first = await copyEquals(tab.key, popup, '.client-screen', `${tab.key} tab`);
    // SHOTS=<folder>: pictures of both windows, to look at the copy with one's own eyes.
    const shot = async (name) => {
      if (!process.env.SHOTS) return;
      await page.screenshot({ path: `${process.env.SHOTS}/${tab.key}-${name}-manager.png` });
      await popup.screenshot({ path: `${process.env.SHOTS}/${tab.key}-${name}-customer.png` });
    };
    await shot('first');
    const notes = [`${first.copy.controls.length} control node(s) at the same place`, `${first.copy.images} picture(s) inline`];
    // The other side of the layout breakpoint: a narrower manager window.
    await page.setViewportSize({ width: 1200, height: 900 });
    await copyEquals(tab.key, popup, '.client-screen', `${tab.key} tab in a 1200 px window`);
    await page.setViewportSize({ width: 1500, height: 900 });
    await copyEquals(tab.key, popup, '.client-screen', `${tab.key} tab back in a 1500 px window`);
    // Scrolling: what is pinned inside the tab is pinned at the same place in the copy.
    if (tab.key === 'cut') {
      // A job opened on the tab brings its sheets: drawings and pictures are in the copy as well.
      const job = page.locator('[data-client-screen-frame="cut"] .cut-jobs-actions').getByRole('button', { name: 'Открыть' }).first();
      // The list of jobs is loaded by the tab itself, a moment after the tab is opened.
      await job.waitFor({ state: 'visible', timeout: 20000 }).catch(() => undefined);
      if (await job.count()) {
        await job.click();
        // The pointer leaves the button: a hover colour is the manager's own, the copy has none.
        await page.mouse.move(5, 400);
        await page.waitForTimeout(2500);
        const opened = await copyEquals(tab.key, popup, '.client-screen', 'cut tab with a job opened');
        notes.push(`with a job opened: ${opened.copy.controls.length} control node(s), ${opened.copy.images} picture(s) inline`);
        await shot('job');
        // The copy is brought up to date in place: the same node is still there a moment later, with its pictures drawn.
        await page.waitForTimeout(2500);
        const later = await copyEquals(tab.key, popup, '.client-screen', 'cut tab with a job opened, a moment later');
        assert.ok(later.copy.sameNode > opened.copy.sameNode, `the copy is updated in place, not redrawn as a whole (drawn last: ${later.copy.drawn})`);
        await shot('job-later');
      } else {
        notes.push(`no job to open on the tab (buttons: ${(await page.locator('[data-client-screen-frame="cut"] button').allInnerTexts()).slice(0, 12).join(' | ').replace(/\d/g, '#')})`);
      }
    }
    const before = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollBy(0, 260));
    const moved = await page.evaluate(() => window.scrollY) - before;
    const scrolled = await copyEquals(tab.key, popup, '.client-screen', `${tab.key} tab after scrolling`);
    notes.push(moved > 0 ? `the manager scrolled ${moved} px, the box is at ${scrolled.copy.scrollTop} px` : 'the page of the manager does not scroll with this tab open');
    if (moved > 0) await expect.poll(async () => (await popup.evaluate(readCopy, ['.client-screen', FRAME_CONTROL_SELECTOR]))?.scrollTop ?? -1, { timeout: 10000 }).toBeGreaterThan(0);
    // Back to the tab (a one-page form scrolls to its section), then the page as it was.
    if (moved > 0) await page.evaluate((top) => window.scrollTo(0, top), before);
    // The miniature in the manager's header draws the same copy.
    await page.getByRole('button', { name: 'Что видит клиент' }).hover();
    await copyEquals(tab.key, page, '.client-screen-preview', `${tab.key} tab in the miniature`);
    await page.mouse.move(5, 400);
    const timings = scrolled.manager.timings;
    if (timings.length) notes.push(`taking a copy: ${Math.max(...timings)} ms at most over ${timings.length} time(s)`);
    results.push(`${tab.key} tab shown whole and equal to the manager's tab: ${notes.join('; ')}`);

    if (tab.key === 'cut' || !has('tab.cut')) {
      // The manager leaves the order screen with the order still presented: the copy stays whole,
      // also for a customer window opened anew and for the miniature.
      {
        // What the tab shows right before the manager leaves (it may tick on by itself: counters, times).
        const before = await copyEquals(tab.key, popup, '.client-screen', `${tab.key} tab before leaving`);
        const settled = (text) => frameText(text).replace(/\d+/g, '#');
        await page.evaluate(() => {
          window.history.pushState({}, '', '/orders');
          window.dispatchEvent(new PopStateEvent('popstate'));
        });
        await page.waitForURL((url) => url.pathname === '/orders', { timeout: 20000 });
        const left = await page.evaluate((key) => {
          const node = document.querySelector(`[data-client-screen-frame="${key}"]`);
          return node ? `kept in the page, ${Math.round(node.getBoundingClientRect().width)} px wide` : 'removed from the page';
        }, tab.key);
        const kept = async (where, label) => {
          const scope = label.split(' ')[0];
          let state = 'not read yet';
          const deadline = Date.now() + 45000;
          while (state !== 'whole' && Date.now() < deadline) {
            await page.waitForTimeout(400);
            const copy = await where.evaluate(readCopy, [scope, FRAME_CONTROL_SELECTOR]);
            if (!copy) {
              state = `no copy on screen: ${JSON.stringify(await where.evaluate((selector) => ({
                tab: document.querySelector(`${selector} .client-screen__tab--active`)?.textContent ?? null,
                boxes: document.querySelectorAll(`${selector} iframe`).length,
                filled: document.querySelector(`${selector} iframe`)?.contentDocument?.querySelectorAll('[data-cs-tab]').length ?? null,
                splash: Boolean(document.querySelector('.client-screen__splash')),
                note: document.querySelector(`${selector} .client-screen__empty`)?.textContent ?? null,
              }), scope))}`;
            }
            else if (settled(copy.text) !== settled(before.manager.text)) state = `text differs (${frameText(copy.text).length} and ${frameText(before.manager.text).length} characters)`;
            else if (copy.brokenImages || copy.images !== before.manager.images) state = `pictures: ${copy.images} in the copy (${copy.brokenImages} broken), ${before.manager.images} on the tab`;
            else state = 'whole';
          }
          assert.ok(state === 'whole', `${tab.key} tab: the kept copy in ${label}: ${state}`);
        };
        // First with the customer window as it is, then with one opened anew.
        await page.waitForTimeout(1500);
        await kept(popup, '.client-screen');
        await popup.reload({ waitUntil: 'domcontentloaded' });
        await kept(popup, '.client-screen (after a reload)');
        await page.getByRole('button', { name: 'Что видит клиент' }).click();
        await kept(page, '.client-screen-preview');
        results.push(`${tab.key} tab: the copy with its pictures survives leaving the order screen (the tab is ${left}), a reload of the customer window and the miniature`);
        await page.locator('[role="dialog"][aria-label="Экран клиента"]').getByRole('button', { name: 'Перейти к заказу' }).click();
        await page.waitForURL((url) => url.pathname === `/orders/edit/${orderId}`, { timeout: 20000 });
        await expect(page.getByText('Клиент видит этот заказ')).toBeVisible({ timeout: 30000 });
        await page.mouse.move(5, 400);
        await expect(page.locator('[role="dialog"][aria-label="Экран клиента"]')).toHaveCount(0, { timeout: 10000 });
      }
    }
    // Back to the first tab where the layout has tabs; a one-page form is simply scrolled back below.
    if (await openSection(/Основная информация|Обзор/) && has('tab.basic')) await expect(selectedTab()).toHaveText(/Основная информация|Обзор/, { timeout: 20000 });
  }
  // The page as it was before the tabs were visited (a scrolled one-page form shows a second, compact header).
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.mouse.move(750, 500);
  await page.mouse.wheel(0, -30000);
  const hideButtons = page.getByRole('button', { name: 'Скрыть от клиента' });
  await expect.poll(() => hideButtons.count(), { timeout: 10000 }).toBeGreaterThan(0);
  const headerState = await page.evaluate(() => `page at ${Math.round(window.scrollY)} px`);
  if (await hideButtons.count() > 1) results.push(`the one-page form keeps its compact header on (${headerState}): the first «Скрыть от клиента» is used`);

  await hideButtons.first().click();
  await expect(popup.getByText('Здесь появится ваш заказ')).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('button', { name: 'Показать клиенту' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Что видит клиент' })).toHaveCount(0, { timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Отключить экран клиента' })).toHaveCount(0);
  results.push('«Скрыть от клиента» → splash; the header eye and the emergency button are gone');

  await page.getByRole('button', { name: 'Показать клиенту' }).first().click();
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
  if (has('tab.details')) {
    await expect(viewPopup.getByRole('tab', { selected: true })).toHaveText(/Детали заказа/, { timeout: 20000 });
    await expect(viewPopup.locator('tbody tr[data-row-id]').first()).toBeVisible({ timeout: 20000 });
  } else skipped('the detail list of the view page');
  if (!codes.includes('details.cost')) assert.equal(await viewPopup.getByRole('columnheader', { name: 'Сумма', exact: true }).count(), 0, 'view: hidden cost column is absent');
  if (!codes.includes('details.note')) assert.equal(await viewPopup.getByRole('columnheader', { name: 'Примечание', exact: true }).count(), 0, 'view: hidden note column is absent');
  const viewHeaders = await viewPopup.getByRole('columnheader').allInnerTexts();
  if (has('tab.details') && has('details.quantity')) assert.ok(viewHeaders.includes('Кол-во'), `view: ticked quantity column is present (columns: ${viewHeaders.join(' | ')})`);
  results.push(`view page presented: ${await viewPopup.locator('tbody tr[data-row-id]').count()} detail rows, hidden columns absent`);
  const financePanel = page.locator('.order-show-info-tabs [role="tab"]').filter({ hasText: 'Финансы' });
  if (!(has('tab.finance') && has('tab.details'))) skipped('the finance panel of the view page');
  else if (await financePanel.count()) {
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
  if (process.env.ROLLBACK === '1' && !readOnly) {
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

  assert.deepEqual(customerWindowProblems(), [], 'the customer window asked the network only for its own page');
  results.push(`customer windows asked the network for ${asked.filter((entry) => isCustomerWindow(entry.page)).length} thing(s), all of them their own page, build files and runtime config`);
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
