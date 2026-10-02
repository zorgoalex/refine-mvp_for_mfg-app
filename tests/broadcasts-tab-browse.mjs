import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The whole «Рассылка сообщений» tab with production-like mocked data (skip policy, legacy history with
// every run state, runs with reasons). Never touches ERP/WhatsApp.
const PORT = 5199;
const directory = await mkdtemp(path.join(os.tmpdir(), 'erp-broadcasts-tab-'));
const browser = await chromium.launch({ headless: true });
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'),
  server: { host: '127.0.0.1', port: PORT, strictPort: true },
  optimizeDeps: { entries: ['tests/fixtures/broadcasts-tab.tsx'] },
  plugins: [{ name: 'broadcasts-tab-fixture', configureServer(s) { s.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith('/fixture')) return next();
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/broadcasts-tab.tsx"></script></body></html>');
  }); } }],
});

const T = '2026-09-30T03:50:00Z';
const broadcast = { id: 1, version: 3, archived: false, scheduleGeneration: 1, createdAt: T, updatedAt: T, updatedBy: { id: '11', username: 'admin' },
  name: 'Рассылка заказов', enabled: true, groupChatId: '120363338054016575@g.us', weekdays: [1, 2, 3, 4, 5, 6, 7], sendTime: '08:45',
  sendWindowMinutes: 30, catchUpPolicy: 'skip', catchUpDeadline: '10:00', partialPolicy: 'manual', orderDateOffsetDays: 0, cardsPerMessage: 2,
  captionTemplate: 'Заказы на сегодня' };
const runtime = { enabled: true, relayAvailable: true, unavailableReason: null };
const states = ['sent', 'partial', 'failed', 'unknown', 'cancelled', 'expired', 'empty', 'skipped', 'queued', 'sending'];
const legacyRuns = states.map((state, i) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, businessDate: '2026-09-2' + (i % 9), kind: i % 3 ? 'auto' : 'manual',
  state, reason: i % 2 ? 'runtime_unavailable' : null, orderCount: i, totalArea: i * 1.5, pageCount: 2, sentPageCount: 1, destinationMasked: '12***@g.us',
  createdAt: T, scheduledAt: i % 2 ? T : null }));
const runs = ['preparing', 'queued', 'sent', 'skipped', 'failed'].map((state, i) => ({ id: `10000000-0000-4000-8000-00000000000${i}`, broadcastId: 1,
  businessDate: '2026-09-30', targetDate: '2026-09-30', kind: 'auto', parentRunId: null, state, reason: ['MISSED_WINDOW', 'NO_ORDERS', null, 'MISSED_WINDOW', 'BROADCAST_PREPARATION_FAILED'][i],
  orderCount: 3, totalArea: 4.5, messageCount: 2, sentMessageCount: state === 'sent' ? 2 : 0, destinationMasked: '12***@g.us', createdAt: T, updatedAt: T,
  expiresAt: null, scheduledAt: T, superseded: i === 4 }));

const results = [];
const errors = [];
try {
  await server.listen();
  const context = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error' && /TypeError|Cannot read|is not a function|ErrorBoundary/.test(m.text())) errors.push(m.text().split('\n')[0]); });
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^.*\/api\/v1/, '');
    const json = (body) => route.fulfill({ json: body });
    if (p === '/whatsapp/broadcasts') return json({ broadcasts: [{ id: 1, name: broadcast.name, enabled: true, groupChatId: broadcast.groupChatId, weekdays: broadcast.weekdays,
      sendTime: '08:45', sendWindowMinutes: 30, orderDateOffsetDays: 0, archived: false, lastRun: { state: 'sent', createdAt: T } }],
      control: { paused: false, version: 1, pausedAt: null, pausedBy: null }, runtime, limits: { maxActive: 20 } });
    if (p === '/whatsapp/broadcasts/catalog') return json({ captionVariables: [{ name: 'target_date', label: 'Дата заказов', example: '30.09.2026' }] });
    if (p === '/whatsapp/broadcasts/control') return json({ paused: false, version: 1, pausedAt: null, pausedBy: null });
    if (p === '/whatsapp/broadcasts/legacy-digest-runs') return json({ runs: legacyRuns });
    if (p === '/whatsapp/broadcasts/1') return json({ broadcast, todaySchedule: { broadcastId: 1, businessDate: '2026-09-30', generation: 1, scheduledAt: T,
      windowStart: '08:45', windowEnd: '09:15', sendWindowMinutes: 30, catchUpPolicy: 'skip', catchUpDeadline: '10:00', settingsVersion: 3, createdAt: T }, runtime });
    if (p === '/whatsapp/broadcasts/1/runs') return json({ runs });
    if (p.startsWith('/whatsapp/broadcast-runs/')) return json({ run: runs[2], messages: [
      { deliverySeq: 1, kind: 'image', orderIds: [5, 6], state: 'sent', attemptCount: 1, errorCode: null, sentAt: T, imageAvailable: false, expiresAt: T },
      { deliverySeq: 2, kind: 'image', orderIds: [7], state: 'failed', attemptCount: 2, errorCode: 'WAHA_PROVIDER_ERROR', sentAt: null, imageAvailable: false, expiresAt: T }] });
    if (p === '/whatsapp/groups') return json({ groups: [{ id: broadcast.groupChatId, name: 'ЧПУ', participantCount: 7, announceOnly: false, communityParent: false, suspended: false }],
      truncated: false, fetchedAt: T, cached: true });
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  await page.goto(`http://127.0.0.1:${PORT}/fixture`);
  await expect(page.getByText('Список рассылок')).toBeVisible({ timeout: 30000 });
  results.push('list rendered');
  await expect(page.getByRole('cell', { name: 'ЧПУ · 1203…@g.us' })).toBeVisible({ timeout: 20000 });
  results.push('list shows the group name with the masked id');
  await page.getByRole('cell', { name: 'Рассылка заказов' }).first().click();
  await expect(page.getByText('Рассылка: Рассылка заказов')).toBeVisible({ timeout: 20000 });
  results.push('editor opened (skip policy)');
  const groupRow = page.locator('.whatsapp-group-select-row').first();
  await expect(groupRow.locator('.whatsapp-group-select-name')).toHaveText('ЧПУ', { timeout: 20000 });
  const [inputBox, nameBox] = await Promise.all([groupRow.locator('.whatsapp-group-select-input').boundingBox(), groupRow.locator('.whatsapp-group-select-name').boundingBox()]);
  assert.ok(nameBox.x >= inputBox.x + inputBox.width && Math.abs(nameBox.y + nameBox.height / 2 - (inputBox.y + inputBox.height / 2)) < 8, 'name sits right of the id field');
  if (process.env.SHOT_DIR) await groupRow.screenshot({ path: path.join(process.env.SHOT_DIR, 'group-row-desktop.png') });
  results.push('editor shows the group name next to the id field');
  await expect(page.getByText('История отправок')).toBeVisible();
  await expect(page.getByText('Готовится').first()).toBeVisible();
  results.push('history rendered with preparing/queued/sent/skipped/failed');
  await page.getByRole('button', { name: 'Подробности' }).nth(2).click();
  await expect(page.getByText('Сообщение 2')).toBeVisible();
  results.push('run details rendered');
  await page.getByText('История до перехода').click();
  await expect(page.getByText('Нет заказов').first()).toBeVisible({ timeout: 20000 });
  results.push('legacy history rendered with every state');
  await page.setViewportSize({ width: 390, height: 900 });
  const narrowRow = page.locator('.whatsapp-group-select-row').first();
  await expect(narrowRow.locator('.whatsapp-group-select-name')).toBeVisible();
  const narrow = await narrowRow.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  assert.ok(narrow.scroll <= narrow.client + 1, `group row fits at phone width: ${JSON.stringify(narrow)}`);
  if (process.env.SHOT_DIR) await narrowRow.screenshot({ path: path.join(process.env.SHOT_DIR, 'group-row-phone.png') });
  results.push('group row wraps at phone width');
  assert.deepEqual([...new Set(errors)], [], 'no runtime errors');
  console.log(JSON.stringify({ browse: 'passed', results }, null, 1));
} catch (error) {
  console.log(JSON.stringify({ browse: 'failed', results, pageErrors: [...new Set(errors)].slice(0, 5), error: String(error?.message ?? error).slice(0, 700) }, null, 1));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
