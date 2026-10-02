import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The order card «⋯» WhatsApp items (menu builder + hook + idempotent runner around an antd Dropdown) and the
// «Отправка заказа из карточки» settings block in a real browser under React.StrictMode. Every API call is answered by page.route mocks.
const PORT = 5198;
const directory = await mkdtemp(path.join(os.tmpdir(), 'erp-order-send-'));
const browser = await chromium.launch({ headless: true });
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'),
  server: { host: '127.0.0.1', port: PORT, strictPort: true },
  optimizeDeps: { entries: ['tests/fixtures/order-send.tsx'] },
  plugins: [{ name: 'order-send-fixture', configureServer(s) { s.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith('/fixture')) return next();
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/order-send.tsx"></script></body></html>');
  }); } }],
});

const GROUP = '120363338054016575@g.us';
const runtime = { enabled: true, relayAvailable: true, unavailableReason: null };
const FORMS = [
  { code: 'production_pdf', title: 'PDF для производства', format: 'pdf', financial: false },
  { code: 'order_pdf', title: 'PDF заказа', format: 'pdf', financial: true },
  { code: 'production_excel', title: 'Excel для производства', format: 'xlsx', financial: false },
  { code: 'order_excel', title: 'Excel заказа', format: 'xlsx', financial: true },
];
const menuBody = { enabled: true, forms: FORMS.map(({ code, title, financial }) => ({ code, title, financial })),
  client: { forms: ['production_pdf', 'order_pdf'] },
  chats: [{ chatKey: 'a1b2c3d4-0000-4000-8000-000000000001', label: 'Цех ЧПУ', forms: ['production_pdf', 'production_excel'] },
    { chatKey: 'a1b2c3d4-0000-4000-8000-000000000002', label: 'Менеджеры', forms: ['order_pdf'] }],
  nextAllowedAt: null, activeSend: false, runtime };
const settings = { version: 3, enabled: true, minIntervalMinutes: 15, sendWindowMinutes: 0, clientForms: ['production_pdf'], clientCaption: 'Заказ {order_name}',
  chats: [{ chatKey: 'a1b2c3d4-0000-4000-8000-000000000001', groupChatId: GROUP, label: 'Цех ЧПУ', forms: ['production_pdf'], caption: '' }],
  updatedAt: '2026-10-01T00:00:00Z', updatedBy: null };
const envelope = (over = {}) => ({ settings: { ...settings, ...over }, forms: FORMS,
  captionVariables: [{ name: 'order_name', label: 'Номер заказа', example: '230725' }, { name: 'client', label: 'Клиент', example: 'ИП Иванов' }],
  nextAllowedAt: null, activeSend: false, runtime });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sendView = { send: { sendId: 's1', orderId: 77, state: 'queued' } };

async function open(context, query, handlers = {}) {
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
    if (url.includes('/whatsapp/groups')) return route.fulfill({ json: { groups: [{ id: GROUP, name: 'Цех ЧПУ', participantCount: 5, announceOnly: false,
      communityParent: false, suspended: false }], truncated: false, fetchedAt: '2026-10-01T00:00:00Z', cached: true } });
    // History of order 77: the earlier queued send has since been delivered.
    if (url.endsWith('/orders/77/whatsapp-sends') && method === 'GET') return route.fulfill({ json: { sends: [{ ...sendView.send, state: 'sent', errorCode: null, cancelReason: null }] } });
    if (url.endsWith('/whatsapp/order-send/menu') && method === 'GET') return handlers.menu ? handlers.menu(route) : route.fulfill({ json: menuBody });
    if (url.endsWith('/whatsapp/order-send/settings') && method === 'GET') return route.fulfill({ json: envelope() });
    if (url.endsWith('/whatsapp/order-send/settings') && method === 'PUT') {
      const body = request.postDataJSON();
      puts.push(body);
      return route.fulfill({ json: envelope({ ...body, version: body.version + 1, chats: body.chats.map((c, i) => ({ ...c, chatKey: c.chatKey ?? `a1b2c3d4-0000-4000-8000-00000000009${i}` })) }) });
    }
    if (url.endsWith('/orders/77/whatsapp-sends') && method === 'POST') {
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
  const ok = { post: (route) => route.fulfill({ status: 202, json: sendView }) };

  // 1. Items render from the mocked menu; a client submenu form click POSTs the right body and shows the success toast.
  {
    const { page, errors, posts } = await open(context, 'mode=menu', ok);
    await expect(page.getByTestId('items')).toHaveText('3', { timeout: 20000 });
    await page.getByLabel('Ещё действия').click();
    await expect(page.getByText('Отправить клиенту в WhatsApp')).toBeVisible();
    await expect(page.getByText('Отправить в чат «Менеджеры» — PDF заказа')).toBeVisible();
    await page.getByText('Отправить в чат «Цех ЧПУ»').hover();
    await page.getByText('Excel для производства').click();
    await expect(page.getByText('Заказ поставлен в очередь на отправку: в чат «Цех ЧПУ» (Excel для производства)')).toBeVisible();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].target, { kind: 'chat', chatKey: 'a1b2c3d4-0000-4000-8000-000000000001' });
    assert.equal(posts[0].form, 'production_excel');
    assert.match(posts[0].idempotencyKey, UUID);
    // A one-form chat is a plain item; clicking it sends at once without a submenu.
    await page.getByLabel('Ещё действия').click();
    await page.getByText('Отправить в чат «Менеджеры» — PDF заказа').click();
    await expect(page.getByText('Заказ поставлен в очередь на отправку: в чат «Менеджеры» (PDF заказа)')).toBeVisible();
    assert.equal(posts[1].form, 'order_pdf');
    assert.deepEqual(errors, [], 'no runtime errors (menu)');
    results.push('menu items from the mocked menu; chat submenu click -> POST {target chat, form, uuid key} + success toast; one-form chat is a plain item: ok');
    await page.close();
  }

  // 2. Client item with a phone sends {kind:'client'}; without a phone it is disabled with the hint.
  {
    const { page, posts } = await open(context, 'mode=menu&phone=1', ok);
    await expect(page.getByTestId('items')).toHaveText('3', { timeout: 20000 });
    await page.getByLabel('Ещё действия').click();
    await page.getByText('Отправить клиенту в WhatsApp').hover();
    await page.getByText('PDF заказа', { exact: true }).click();
    await expect(page.getByText('Заказ поставлен в очередь на отправку: клиенту (PDF заказа)')).toBeVisible();
    assert.deepEqual(posts[0].target, { kind: 'client' });
    assert.equal(posts[0].form, 'order_pdf');
    await page.close();

    const noPhone = await open(context, 'mode=menu&phone=0', ok);
    await expect(noPhone.page.getByTestId('items')).toHaveText('3', { timeout: 20000 });
    await noPhone.page.getByLabel('Ещё действия').click();
    const clientItem = noPhone.page.locator('li.ant-dropdown-menu-item', { hasText: 'Отправить клиенту в WhatsApp' });
    await expect(clientItem).toBeVisible();
    await expect(clientItem).toHaveAttribute('aria-disabled', 'true');
    await expect(clientItem).toHaveAttribute('title', 'У клиента нет телефона');
    await noPhone.page.getByText('Отправить клиенту в WhatsApp').click({ force: true });
    await noPhone.page.waitForTimeout(300);
    assert.equal(noPhone.posts.length, 0, 'disabled client item never posts');
    results.push('client item posts {kind client}; without a phone it is disabled with «У клиента нет телефона»: ok');
    await noPhone.page.close();
  }

  // 3. COOLDOWN and ACTIVE toasts.
  {
    const { page, posts } = await open(context, 'mode=menu', { post: (route, n) => n === 1
      ? route.fulfill({ status: 409, json: { error: { code: 'ORDER_SEND_COOLDOWN', message: 'cooldown', details: { nextAllowedAt: '2026-10-01T07:30:00Z', minIntervalMinutes: 15 } } } })
      : route.fulfill({ status: 409, json: { error: { code: 'ORDER_SEND_ACTIVE', message: 'active' } } }) });
    await expect(page.getByTestId('items')).toHaveText('3', { timeout: 20000 });
    await page.getByLabel('Ещё действия').click();
    await page.getByText('Отправить в чат «Менеджеры» — PDF заказа').click();
    await expect(page.getByText('Следующая отправка из карточек — не раньше 12:30')).toBeVisible();
    await page.getByLabel('Ещё действия').click();
    await page.getByText('Отправить в чат «Менеджеры» — PDF заказа').click();
    await expect(page.getByText('Предыдущая отправка ещё выполняется, повторите через минуту')).toBeVisible();
    assert.equal(posts.length, 2);
    assert.notEqual(posts[0].idempotencyKey, posts[1].idempotencyKey, 'a refused first attempt drops its key');
    results.push('COOLDOWN toast (12:30 Almaty) and ACTIVE toast: ok');
    await page.close();
  }

  // 3b. After an unknown outcome the server asks for a confirmation; «Отправить ещё раз» sends its id.
  {
    const PREVIOUS = '1b4e28ba-2fa1-4d2b-883f-0016d3cca427';
    const { page, posts } = await open(context, 'mode=menu', { post: (route, n) => n === 1
      ? route.fulfill({ status: 409, json: { error: { code: 'ORDER_SEND_PREVIOUS_UNKNOWN', message: 'unknown', details: { sendId: PREVIOUS, createdAt: '2026-10-01T07:30:00Z' } } } })
      : route.fulfill({ status: 202, json: sendView }) });
    await expect(page.getByTestId('items')).toHaveText('3', { timeout: 20000 });
    await page.getByLabel('Ещё действия').click();
    await page.getByText('Отправить в чат «Менеджеры» — PDF заказа').click();
    await expect(page.getByText('Результат прежней отправки неизвестен')).toBeVisible();
    await expect(page.getByText(/в 12:30/)).toBeVisible();
    await page.getByRole('button', { name: 'Отправить ещё раз' }).click();
    await expect(page.getByText(/Заказ поставлен в очередь на отправку/)).toBeVisible();
    assert.equal(posts.length, 2);
    assert.equal(posts[1].confirmAfterUnknown, PREVIOUS);
    assert.notEqual(posts[0].idempotencyKey, posts[1].idempotencyKey);
    results.push('PREVIOUS_UNKNOWN -> confirmation dialog -> «Отправить ещё раз» posts confirmAfterUnknown: ok');
    await page.close();
  }

  // 4. A slow send ignores repeated clicks on the same item.
  {
    const { page, posts } = await open(context, 'mode=menu', { post: async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return route.fulfill({ status: 202, json: sendView });
    } });
    await expect(page.getByTestId('items')).toHaveText('3', { timeout: 20000 });
    await page.getByLabel('Ещё действия').click();
    await page.getByText('Отправить в чат «Менеджеры» — PDF заказа').click();
    await page.getByLabel('Ещё действия').click();
    await page.getByText('Отправить в чат «Менеджеры» — PDF заказа').click({ force: true });
    await expect(page.getByText('Заказ поставлен в очередь на отправку: в чат «Менеджеры» (PDF заказа)')).toBeVisible();
    assert.equal(posts.length, 1, 'repeated click while in flight is ignored');
    results.push('repeated click while in flight is ignored: ok');
    await page.close();
  }

  // 5. Old backend (404 menu): no items at all.
  {
    const { page } = await open(context, 'mode=menu', { menu: (route) => route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } }) });
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('items')).toHaveText('0');
    await expect(page.getByLabel('Ещё действия')).toHaveCount(0);
    results.push('404 menu -> no items: ok');
    await page.close();
  }

  // 6. Settings block: edit, add a chat, save -> PUT with version, chatKey (existing) and null (new).
  {
    const { page, errors, puts } = await open(context, 'mode=settings');
    await expect(page.getByText('Отправка заказа из карточки', { exact: true }).first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('Общий для всех отправок из карточек заказов')).toBeVisible();
    await expect(page.getByText('{order_name} — Номер заказа').first()).toBeVisible();
    const interval = page.getByLabel('Порог частоты, мин');
    await expect(interval).toHaveValue('15');
    await interval.fill('30');
    const window = page.getByLabel('Окно отправки, мин');
    await window.fill('16');
    await window.blur();
    await expect(page.getByText('Окно — не больше половины порога: до 15 мин')).toBeVisible();
    await window.fill('10');
    await window.blur();
    await page.getByRole('checkbox', { name: 'PDF заказа' }).first().check();
    await page.getByRole('button', { name: 'Добавить чат' }).click();
    const groups = page.locator('.whatsapp-group-select-input input');
    await expect(groups).toHaveCount(2);
    await groups.nth(1).fill('120363111111111111@g.us');
    await page.locator('input[id$="_label"]').nth(1).fill('Менеджеры');
    await page.getByRole('checkbox', { name: 'Excel для производства' }).nth(2).check();
    await page.getByRole('button', { name: 'Сохранить настройки' }).click();
    await expect(page.getByText('Настройки отправки заказа из карточки сохранены.')).toBeVisible();
    assert.equal(puts.length, 1);
    const put = puts[0];
    assert.equal(put.version, 3);
    assert.equal(put.minIntervalMinutes, 30);
    assert.equal(put.sendWindowMinutes, 10);
    assert.deepEqual(put.clientForms, ['production_pdf', 'order_pdf']);
    assert.equal(put.chats.length, 2);
    assert.equal(put.chats[0].chatKey, 'a1b2c3d4-0000-4000-8000-000000000001');
    assert.equal(put.chats[1].chatKey, null);
    assert.equal(put.chats[1].groupChatId, '120363111111111111@g.us');
    assert.equal(put.chats[1].label, 'Менеджеры');
    assert.deepEqual(put.chats[1].forms, ['production_excel']);
    await expect(interval).toHaveValue('30');
    assert.deepEqual(errors, [], 'no runtime errors (settings)');
    results.push('settings save -> PUT {version 3, interval 30, window 10 (16 refused), clientForms, chats [existing key, new null]}: ok');
    await page.close();
  }

  // 7. Settings block is hidden on an old backend (404).
  {
    const page = await context.newPage();
    await page.route('**/api/v1/**', (route) => route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } }));
    await page.goto(`http://127.0.0.1:${PORT}/fixture?mode=settings`, { timeout: 120000 });
    await page.waitForTimeout(1500);
    await expect(page.getByText('Отправка заказа из карточки')).toHaveCount(0);
    results.push('404 settings -> block hidden: ok');
    await page.close();
  }
  console.log(JSON.stringify({ browse: 'passed', results }, null, 1));
} catch (error) {
  console.log(JSON.stringify({ browse: 'failed', results, pageErrors: [...new Set(allErrors)].slice(0, 5), error: String(error?.message ?? error).slice(0, 1200) }, null, 1));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
