import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Calendar day menu «Отправить в чат» (header click / right click / header icon) and the «Отправка из календаря» settings block in a real
// browser under React.StrictMode. Every API call is answered by page.route mocks.
const PORT = 5199;
const directory = await mkdtemp(path.join(os.tmpdir(), 'erp-calendar-send-'));
const browser = await chromium.launch({ headless: true });
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'),
  server: { host: '127.0.0.1', port: PORT, strictPort: true },
  optimizeDeps: { entries: ['tests/fixtures/calendar-send.tsx'] },
  plugins: [{ name: 'calendar-send-fixture', configureServer(s) { s.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith('/fixture')) return next();
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/calendar-send.tsx"></script></body></html>');
  }); } }],
});

const settings = { broadcastId: 9, version: 3, groupChatId: '120363338054016575@g.us', cardsPerMessage: 2, captionTemplate: 'Заказы на {target_date}',
  minIntervalMinutes: 15, updatedAt: '2026-10-01T00:00:00Z', updatedBy: null };
const runtime = { enabled: true, relayAvailable: true, unavailableReason: null };
const envelope = (over = {}) => ({ settings: { ...settings, ...over }, nextAllowedAt: null, activeRun: false, runtime });
const runDetail = (state) => ({ run: { id: 'r1', broadcastId: 9, state }, messages: [] });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function open(context, query, handlers) {
  const page = await context.newPage();
  const errors = [];
  const posts = [];
  const puts = [];
  page.on('pageerror', (e) => { errors.push(e.message); allErrors.push(e.message.split('\n')[0]); });
  page.on('console', (m) => { if (m.type() === 'error' && /Cannot read|TypeError/.test(m.text())) errors.push(m.text()); });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    if (url.includes('/whatsapp/groups')) return route.fulfill({ json: { groups: [], truncated: false, fetchedAt: '2026-10-01T00:00:00Z', cached: true } });
    if (/\/whatsapp\/broadcasts\/9\/runs$/.test(url) && method === 'GET') return route.fulfill({ json: { runs: [] } });
    if (url.endsWith('/whatsapp/calendar-send') && method === 'GET') return route.fulfill({ json: envelope() });
    if (url.endsWith('/whatsapp/calendar-send') && method === 'PUT') {
      const body = request.postDataJSON();
      puts.push(body);
      return route.fulfill({ json: envelope({ ...body, version: body.version + 1 }) });
    }
    if (url.endsWith('/whatsapp/calendar-send/runs') && method === 'POST') {
      posts.push(request.postDataJSON());
      return handlers.post(route, posts.length);
    }
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
  });
  await page.goto(`http://127.0.0.1:${PORT}/fixture?${query}`, { timeout: 120000 });
  return { page, errors, posts, puts };
}

const results = [];
const allErrors = [];
try {
  await server.listen();
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });

  // 1. Left click on the day header -> «Отправить в чат» -> POST with the column date and a uuid key -> success toast.
  {
    const { page, errors, posts } = await open(context, 'mode=day', { post: (route) => route.fulfill({ status: 202, json: runDetail('queued') }) });
    await expect(page.getByTestId('support')).toHaveText('supported', { timeout: 20000 });
    await page.locator('.day-column__header').first().click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.calendar-context-menu')).toBeVisible();
    await expect(page.locator('.calendar-context-menu').getByText('Пт, 02.10.2026')).toBeVisible();
    // Another header click while the menu is open re-opens it for that day.
    await page.locator('.day-column__header').nth(1).click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.calendar-context-menu').getByText('Сб, 03.10.2026')).toBeVisible();
    await page.locator('.day-column__header').first().click({ button: 'right', position: { x: 10, y: 10 } });
    await expect(page.locator('.calendar-context-menu').getByText('Пт, 02.10.2026')).toBeVisible();
    await page.locator('.calendar-context-menu').getByText('Отправить в чат').click();
    await expect(page.getByText('Отправка за Пт, 02.10 поставлена в очередь')).toBeVisible();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].date, '2026-10-02');
    assert.match(posts[0].idempotencyKey, UUID);
    await expect(page.locator('.calendar-context-menu')).toBeHidden();
    assert.deepEqual(errors, [], 'no runtime errors (queued)');
    results.push('header click / right click -> menu; item -> POST date 2026-10-02 + uuid key + success toast: ok');
    await page.close();
  }

  // 2. Empty day and cooldown toasts; Escape closes the menu.
  {
    const { page, errors, posts } = await open(context, 'mode=day', { post: (route, n) => n === 1
      ? route.fulfill({ status: 202, json: runDetail('empty') })
      : route.fulfill({ status: 409, json: { error: { code: 'BROADCAST_CALENDAR_COOLDOWN', message: 'cooldown', details: { nextAllowedAt: '2026-10-01T07:30:00Z' } } } }) });
    await expect(page.getByTestId('support')).toHaveText('supported', { timeout: 20000 });
    const headers = page.locator('.day-column__header');
    await headers.nth(1).click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Escape');
    await expect(page.locator('.calendar-context-menu')).toBeHidden();
    await headers.nth(1).click({ position: { x: 10, y: 10 } });
    await page.locator('.calendar-context-menu').getByText('Отправить в чат').click();
    await expect(page.getByText('На 03.10 заказов нет — ничего не отправлено')).toBeVisible();
    await headers.first().click({ button: 'right' });
    await page.locator('.calendar-context-menu').getByText('Отправить в чат').click();
    await expect(page.getByText('Следующая отправка — не раньше 12:30')).toBeVisible();
    await expect(page.getByText('не чаще раза в 15 мин')).toBeVisible();
    assert.deepEqual(posts.map((p) => p.date), ['2026-10-03', '2026-10-02']);
    assert.deepEqual(errors, [], 'no runtime errors (empty/cooldown)');
    results.push('empty-day toast, cooldown toast (12:30 Almaty, 15 min), Escape closes: ok');
    await page.close();
  }

  // 3. A single tap on the header opens the compact menu.
  {
    const touch = await browser.newContext({ viewport: { width: 420, height: 800 }, hasTouch: true });
    const { page, errors } = await open(touch, 'mode=day&compact=1', { post: (route) => route.fulfill({ status: 202, json: runDetail('queued') }) });
    await expect(page.getByTestId('support')).toHaveText('supported', { timeout: 20000 });
    const box = await page.locator('.day-column__header').first().boundingBox();
    await page.touchscreen.tap(box.x + 20, box.y + 10);
    await expect(page.locator('.calendar-context-menu--compact')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.locator('.calendar-context-menu--compact')).toBeVisible();
    assert.deepEqual(errors, [], 'no runtime errors (touch)');
    results.push('touch tap on header -> compact menu stays open: ok');
    await touch.close();
  }

  // 4. Old backend (404 probe): right click does nothing special.
  {
    const page = await context.newPage();
    await page.route('**/api/v1/**', (route) => route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } }));
    await page.goto(`http://127.0.0.1:${PORT}/fixture?mode=day`, { timeout: 120000 });
    await expect(page.getByTestId('support')).toHaveText('unsupported', { timeout: 20000 });
    await page.locator('.day-column__header').first().click({ button: 'right' });
    await expect(page.locator('.calendar-context-menu')).toBeHidden();
    await expect(page.locator('.day-column__send')).toHaveCount(0);
    await page.locator('.day-column__header').first().click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.calendar-context-menu')).toBeHidden();
    results.push('404 probe -> unsupported, no menu, no icon: ok');
    await page.close();
  }

  // 4b. Header icon: sends that column's date at once, does not open the menu, spinner + ignored repeats while in flight.
  {
    const { page, errors, posts } = await open(context, 'mode=day', { post: async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return route.fulfill({ status: 202, json: runDetail('queued') });
    } });
    await expect(page.getByTestId('support')).toHaveText('supported', { timeout: 20000 });
    const icons = page.locator('.day-column__send');
    await expect(icons).toHaveCount(2);
    const before = await page.locator('.day-column__header').first().boundingBox();
    await icons.nth(1).click();
    await expect(page.locator('.calendar-context-menu')).toBeHidden();
    await expect(icons.nth(1)).toHaveAttribute('aria-disabled', 'true');
    await expect(icons.nth(1)).toHaveAttribute('aria-busy', 'true');
    await expect(icons.nth(0)).toHaveAttribute('aria-disabled', 'false');
    // Playwright's click would wait out aria-disabled; dispatch the event as a hurried user would.
    await icons.nth(1).dispatchEvent('click');
    await expect(page.getByText('Отправка за Сб, 03.10 поставлена в очередь')).toBeVisible();
    assert.equal(posts.length, 1, 'repeated clicks while in flight are ignored');
    assert.equal(posts[0].date, '2026-10-03');
    assert.match(posts[0].idempotencyKey, UUID);
    await expect(icons.nth(1)).toHaveAttribute('aria-disabled', 'false');
    await expect(page.locator('.calendar-context-menu')).toBeHidden();
    // Header click away from the icon still opens the menu.
    await page.locator('.day-column__header').first().click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.calendar-context-menu')).toBeVisible();
    // The icon does not change the header height.
    const after = await page.locator('.day-column__header').first().boundingBox();
    assert.equal(Math.round(after.height), Math.round(before.height));
    assert.ok(after.height < 60, `header height ${after.height}`);
    assert.deepEqual(errors, [], 'no runtime errors (icon)');
    results.push('header icon -> POST 2026-10-03, no menu, spinner/disabled while in flight, repeat ignored: ok');
    await page.close();
  }

  // 5. Settings block: change the interval and save -> PUT with version and minIntervalMinutes.
  {
    const { page, errors, puts } = await open(context, 'mode=settings', { post: (route) => route.fulfill({ status: 202, json: runDetail('queued') }) });
    await expect(page.getByText('Отправка из календаря', { exact: true }).first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('правый клик по заголовку дня')).toBeVisible();
    const interval = page.getByLabel('Не чаще одного раза в (мин)');
    await expect(interval).toHaveValue('15');
    await interval.fill('30');
    await page.getByRole('button', { name: 'Сохранить настройки' }).click();
    await expect(page.getByText('Настройки отправки из календаря сохранены.')).toBeVisible();
    assert.equal(puts.length, 1);
    assert.equal(puts[0].minIntervalMinutes, 30);
    assert.equal(puts[0].version, 3);
    assert.equal(puts[0].cardsPerMessage, 2);
    await expect(interval).toHaveValue('30');
    assert.deepEqual(errors, [], 'no runtime errors (settings)');
    results.push('settings save -> PUT {version 3, minIntervalMinutes 30}: ok');
    await page.close();
  }
  console.log(JSON.stringify({ browse: 'passed', results }, null, 1));
} catch (error) {
  console.log(JSON.stringify({ browse: 'failed', results, pageErrors: [...new Set(allErrors)].slice(0, 5), error: String(error?.message ?? error).slice(0, 800) }, null, 1));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
