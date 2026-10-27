import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { printableError } from './helpers/redactSecrets.mjs';
import { vercelBypassCookies } from './helpers/vercelBypass.mjs';

// Smoke of a BUILT deployment (a Vercel preview or the stage site): the main app still starts, a
// deep route still resolves to it, and /client-screen.html is the isolated customer page.
// BASE_URL is required. VERCEL_AUTOMATION_BYPASS_SECRET, when set, is exchanged once for the
// deployment's bypass cookie (one request, no redirects followed); the browser never carries the
// secret itself, and it is redacted from anything printed. Read-only: no login, no data.
const base = (process.env.BASE_URL ?? '').replace(/\/$/, '');
assert.match(base, /^https:\/\//, 'BASE_URL must be an https URL');
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const origin = new URL(base).origin;

const browser = await chromium.launch({ headless: true });
const results = [];
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  // Only the deployment's own cookies go into the browser; no request of the page carries the secret.
  const cookies = await vercelBypassCookies(base, bypass);
  if (cookies.length) await context.addCookies(cookies);
  const watch = (page, name) => {
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message.split('\n')[0]}`));
  };

  // 1. The main application: the entry page and a deep route both boot the app (login screen, no session).
  for (const route of ['/', '/orders/edit/1']) {
    const page = await context.newPage();
    watch(page, `app ${route}`);
    const response = await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, `GET ${route}`);
    assert.ok((await page.content()).includes('/assets/'), `${route} is the built app shell`);
    await expect(page.locator('#root > *').first()).toBeVisible({ timeout: 60000 });
    await page.waitForURL(/\/login/, { timeout: 60000 });
    assert.equal(await page.getByText('Экран клиента').count(), 0, `${route} is not the customer page`);
    await page.close();
  }
  results.push('main app boots on / and on a deep route (redirects to the login page)');

  // 2. The customer page: its own HTML and entry, inert unless the runtime config switches it on.
  let runtime = 'off';
  const configRequests = [];
  await context.route(/runtime-config/, (route) => {
    configRequests.push(new URL(route.request().url()).pathname);
    if (runtime === 'fail') return route.fulfill({ status: 503, body: 'unavailable' });
    return route.fulfill({ json: { features: { clientScreen: runtime === 'on' } } });
  });
  const page = await context.newPage();
  watch(page, 'customer');
  const requests = [];
  const scripts = new Map();
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (response.request().resourceType() === 'script' && url.origin === origin) {
      scripts.set(url.pathname, response.body().then((body) => body.length, () => 0));
    }
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && !/^\/(assets\/|client-screen\.html|vite\.svg|favicon)/.test(url.pathname) && !/runtime-config/.test(url.pathname)) requests.push(url.pathname);
    if (url.origin !== origin) requests.push(`${url.origin}${url.pathname}`.slice(0, 80));
  });
  const response = await page.goto(`${base}/client-screen.html`, { waitUntil: 'domcontentloaded' });
  assert.equal(response.status(), 200, 'GET /client-screen.html');
  const html = await response.text();
  assert.ok(html.includes('<title>Экран клиента</title>'), 'the customer page HTML is served, not the app shell');
  await expect(page.getByText('Экран клиента выключен')).toBeVisible({ timeout: 60000 });
  results.push('customer page, flag off → inert splash');
  assert.equal(await page.evaluate(() => Object.keys(localStorage).length + sessionStorage.length), 0, 'inert page stores nothing');

  runtime = 'fail';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Экран клиента выключен')).toBeVisible({ timeout: 60000 });
  results.push('customer page, runtime config unavailable → inert splash');

  runtime = 'on';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Здесь появится ваш заказ')).toBeVisible({ timeout: 60000 });
  results.push('customer page, flag on → waiting splash');
  assert.equal(await page.evaluate(() => sessionStorage.length), 0, 'customer page sessionStorage is empty');
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), [], 'customer page localStorage is empty before any presentation');

  assert.ok(configRequests.length >= 3, 'the runtime config was requested on every load');
  assert.deepEqual([...new Set(requests)], [], 'the customer page requested nothing but its assets and the runtime config');
  const customerScripts = [...scripts.keys()];
  assert.ok(customerScripts.length >= 1 && customerScripts.every((path) => path.startsWith('/assets/')), 'customer scripts are built assets');
  // The emitted customer entry must not pull the application bundle: total script size is a cheap proxy.
  let bytes = 0;
  for (const size of scripts.values()) bytes += await size;
  assert.ok(bytes < 600_000, `customer page scripts are small (${bytes} bytes), so the app bundle is not loaded`);
  results.push(`customer page loads ${customerScripts.length} script(s), ${bytes} bytes, no other requests`);

  assert.deepEqual([...new Set(errors)], [], 'no page errors');
  console.log(JSON.stringify({ smoke: 'passed', base: new URL(base).host, results }, null, 1));
} catch (error) {
  // Never the raw error: Playwright call logs may include request headers.
  console.log(JSON.stringify({
    smoke: 'failed', results,
    pageErrors: [...new Set(errors)].slice(0, 5).map((text) => printableError({ name: 'page', message: text }, [bypass])),
    error: printableError(error, [bypass]),
  }, null, 1));
  process.exitCode = 1;
} finally {
  await browser.close();
}
