import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Balloons for the user's own WhatsApp sends and the «ожидают отправки» block under the bell, in a real
// browser under React.StrictMode. /whatsapp/my-sends is answered by page.route mocks.
const PORT = 5197;
const directory = await mkdtemp(path.join(os.tmpdir(), 'erp-whatsapp-balloons-'));
const browser = await chromium.launch({ headless: true });
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'),
  server: { host: '127.0.0.1', port: PORT, strictPort: true },
  optimizeDeps: { entries: ['tests/fixtures/whatsapp-balloons.tsx'] },
  plugins: [{ name: 'whatsapp-balloons-fixture', configureServer(s) { s.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith('/fixture')) return next();
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/whatsapp-balloons.tsx"></script></body></html>');
  }); } }],
});

const send = (id, state, title, estimatedAt = null) => ({ kind: 'order_send', id, title, state, active: state === 'queued' || state === 'sending',
  estimatedAt, createdAt: '2026-10-02T07:00:00Z', finishedAt: state === 'sent' ? '2026-10-02T07:20:00Z' : null, errorCode: null, cancelReason: null,
  orderId: 1, targetDate: null });
const ids = ['a', 'b', 'c', 'd'].map((letter) => `00000000-0000-4000-8000-00000000000${letter}`);
const [A, B] = ids;
const results = [];
const errors = [];
try {
  await server.listen();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
  let phase = 'pending';
  await page.route('**/api/v1/**', async (route) => {
    if (route.request().url().includes('/whatsapp/my-sends')) {
      const items = phase === 'pending'
        ? [send(A, 'queued', 'Заказ 230725 → клиенту, PDF заказа', new Date(Date.now() + 45 * 60_000).toISOString()),
          send(B, 'sending', 'Календарь, 02.10.2026 → чат', new Date().toISOString()),
          send(ids[2], 'queued', 'Заказ 230726 → в чат «Цех»', new Date().toISOString()),
          send(ids[3], 'queued', 'Заказ 230727 → клиенту, Excel заказа', new Date().toISOString())]
        : ids.map((id, index) => send(id, 'sent', `Отправка ${index + 1}`));
      return route.fulfill({ json: { serverTime: new Date().toISOString(), items } });
    }
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  await page.goto(`http://127.0.0.1:${PORT}/fixture`, { timeout: 120000 });
  const block = page.getByTestId('my-whatsapp-sends');
  await expect(block).toBeVisible({ timeout: 30000 });
  await expect(block.getByText('WhatsApp: ожидают отправки')).toBeVisible();
  const expected = `≈ ${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(Date.now() + 45 * 60_000))}`;
  const shown = await block.getByText(/^≈ \d\d:\d\d$/).textContent();
  assert.ok(Math.abs(Date.parse(`1970-01-01T${shown.slice(2)}:00Z`) - Date.parse(`1970-01-01T${expected.slice(2)}:00Z`)) <= 60_000, `${shown} vs ${expected}`);
  await expect(block.getByText('сейчас').first()).toBeVisible();
  results.push(`pending block: «${shown}» (Almaty, +45 min) and «сейчас»`);
  // An ordinary app notification is on screen; then all four sends finish.
  await page.getByRole('button', { name: 'app' }).click();
  phase = 'sent';
  await page.getByRole('button', { name: 'queued' }).click();
  const balloons = page.locator('.ant-notification-notice').filter({ hasText: 'Отправлено в WhatsApp' });
  await expect(balloons).toHaveCount(4, { timeout: 10000 });
  await expect(page.getByText('Обычное уведомление приложения')).toBeVisible();
  await expect(block).toBeHidden();
  const boxes = await Promise.all([0, 1, 2, 3].map((index) => balloons.nth(index).boundingBox()));
  assert.ok(boxes.every((box) => box.x + box.width > 1280 - 40), `balloons sit at the right: ${JSON.stringify(boxes)}`);
  assert.equal(new Set(boxes.map((box) => Math.round(box.y))).size, 4, 'balloons are stacked');
  assert.equal(Number(await balloons.first().evaluate((el) => getComputedStyle(el).opacity)), 0.88);
  results.push('four balloons at once next to an app notification (own container), bottom right, stacked, opacity 0.88');
  await balloons.first().locator('.ant-notification-notice-close').click();
  await expect(balloons).toHaveCount(3, { timeout: 5000 });
  results.push('close cross removes a balloon');
  await page.getByRole('button', { name: 'queued' }).click();
  await page.waitForTimeout(800);
  await expect(balloons).toHaveCount(3);
  results.push('no repeat on the next refresh');
  await page.getByRole('button', { name: 'switch user' }).click();
  await expect(balloons).toHaveCount(0, { timeout: 5000 });
  results.push('logout / another user: the balloons are closed at once');
  // A send that finished before the first poll: tracked at acceptance, announced from a fresh page.
  const fast = '00000000-0000-4000-8000-0000000000ff';
  const page2 = await context.newPage();
  await page2.route('**/api/v1/**', (route) => route.request().url().includes('/whatsapp/my-sends')
    ? route.fulfill({ json: { serverTime: new Date().toISOString(), items: route.request().url().includes(fast) ? [send(fast, 'sent', 'Быстрая отправка')] : [] } })
    : route.fulfill({ status: 404, json: {} }));
  await page2.goto(`http://127.0.0.1:${PORT}/fixture?queued=${fast}`, { timeout: 120000 });
  await page2.getByRole('button', { name: 'queued' }).click();
  await expect(page2.locator('.ant-notification-notice').filter({ hasText: 'Быстрая отправка' })).toHaveCount(1, { timeout: 10000 });
  results.push('a send finished before the first poll still gets its balloon (followed by id)');
  // Two tabs of the same browser follow the same send and both see it finish at once: one balloon in total.
  const twin = '00000000-0000-4000-8000-0000000000ee';
  let twinPhase = 'pending';
  const twinRoute = (route) => route.request().url().includes('/whatsapp/my-sends')
    ? route.fulfill({ json: { serverTime: new Date().toISOString(), items: [send(twin, twinPhase === 'pending' ? 'queued' : 'sent', 'Двойная вкладка')] } })
    : route.fulfill({ status: 404, json: {} });
  const tabs = [await context.newPage(), await context.newPage()];
  for (const tab of tabs) { await tab.route('**/api/v1/**', twinRoute); await tab.goto(`http://127.0.0.1:${PORT}/fixture`, { timeout: 120000 }); }
  for (const tab of tabs) await expect(tab.getByTestId('my-whatsapp-sends')).toBeVisible({ timeout: 30000 });
  twinPhase = 'sent';
  await Promise.all(tabs.map((tab) => tab.getByRole('button', { name: 'queued' }).click()));
  await Promise.all(tabs.map((tab) => tab.waitForTimeout(1500)));
  const twinCounts = await Promise.all(tabs.map((tab) => tab.locator('.ant-notification-notice').filter({ hasText: 'Двойная вкладка' }).count()));
  assert.equal(twinCounts[0] + twinCounts[1], 1, `one balloon across two tabs: ${twinCounts}`);
  results.push('two tabs finishing the same send at once: one balloon in total (Web Locks)');
  // Tab B idles (no pending sends, no polling); tab A sends and is closed before the send ends: B shows the balloon.
  const orphan = '00000000-0000-4000-8000-0000000000dd';
  let orphanDone = false;
  const orphanRoute = (route) => route.request().url().includes('/whatsapp/my-sends')
    ? route.fulfill({ json: { serverTime: new Date().toISOString(),
      items: route.request().url().includes(orphan) ? [send(orphan, orphanDone ? 'sent' : 'queued', 'Закрытая вкладка')] : [] } })
    : route.fulfill({ status: 404, json: {} });
  const idle = await context.newPage();
  await idle.route('**/api/v1/**', orphanRoute);
  await idle.goto(`http://127.0.0.1:${PORT}/fixture`, { timeout: 120000 });
  await expect(idle.getByTestId('count')).toHaveText('0', { timeout: 30000 });
  const sender = await context.newPage();
  await sender.route('**/api/v1/**', orphanRoute);
  await sender.goto(`http://127.0.0.1:${PORT}/fixture?queued=${orphan}`, { timeout: 120000 });
  await sender.getByRole('button', { name: 'queued' }).click();
  await expect(sender.getByTestId('my-whatsapp-sends')).toBeVisible({ timeout: 10000 });
  await sender.close();
  // The send ends only after the sending tab is gone; the idle tab was woken by the storage event and polls.
  await expect(idle.getByTestId('my-whatsapp-sends')).toBeVisible({ timeout: 10000 });
  orphanDone = true;
  await expect(idle.locator('.ant-notification-notice').filter({ hasText: 'Закрытая вкладка' })).toHaveCount(1, { timeout: 25000 });
  results.push('a send from a tab closed before the end is announced by another open tab (storage wake-up)');
  assert.deepEqual(errors, [], 'no runtime errors');
  console.log(JSON.stringify({ browse: 'passed', results }, null, 1));
} catch (error) {
  console.log(JSON.stringify({ browse: 'failed', results, pageErrors: errors.slice(0, 5), error: String(error?.message ?? error).slice(0, 700) }, null, 1));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
