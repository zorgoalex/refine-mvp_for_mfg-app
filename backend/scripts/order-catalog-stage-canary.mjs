// Stage-only API/browser acceptance. Run through rtk-heavy-guard; no live Bitrix calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

assert.equal(process.env.ERP_ORDER_CATALOG_TARGET_ENV, 'backend-test');
const sha = process.env.ERP_ORDER_CATALOG_EXPECTED_SHA;
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const prefix = `E2E-order-catalog-${randomUUID()}`;
const api = 'https://backend-test.mebelkz.app/api/v1';
const flags = execFileSync('docker', ['exec', 'erp_test-backend-1', 'sh', '-lc', 'printf "%s|%s|%s" "$BACKEND_ENABLE_BITRIX24_SYNC" "$BACKEND_ENABLE_BITRIX24_REVERSE_SYNC" "$BACKEND_ENABLE_BITRIX24_PAYMENT_WIDGET"'], { encoding: 'utf8' });
assert.ok(flags.split('|').every(value => value === '' || value === 'false'), 'Stage Bitrix writers must remain disabled');
const url = new URL(execFileSync('docker', ['exec', 'erp_test-backend-1', 'printenv', 'DATABASE_URL'], { encoding: 'utf8' }).trim());
url.hostname = '100.99.106.72';
const db = new pg.Client({ connectionString: url.href, statement_timeout: 10000 });
await db.connect();
let bearer, actorId, clientId, browser, page;
const orderIds = [], catalogIds = [], projectIds = [];
const request = async (path, method = 'GET', body, auth = true) => {
  const response = await fetch(api + path, { method, headers: { ...(auth ? { authorization: `Bearer ${bearer}` } : {}),
    'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  return { status: response.status, body: await response.json() };
};
try {
  const health = await (await fetch('https://backend-test.mebelkz.app/health/ready')).json();
  assert.equal(health.status, 'ready'); assert.equal(health.deployment.gitCommitSha, sha);
  const login = await request('/auth/login', 'POST', { username: process.env.CODEX_PLAYWRIGHT_USERNAME, password: process.env.CODEX_PLAYWRIGHT_PASSWORD }, false);
  assert.equal(login.status, 200); bearer = login.body.accessToken; actorId = String(login.body.user.id);
  assert.ok(bearer); assert.match(actorId, /^\d+$/);
  clientId = (await db.query('INSERT INTO clients(client_name) VALUES($1) RETURNING client_id', [prefix])).rows[0].client_id;
  const units = await request('/catalog-items/units'); assert.equal(units.status, 200);
  const itemResponse = await request('/catalog-items', 'POST', { name: prefix, sku: prefix, kind: 'service', unitId: units.body[0].id, basePrice: '1500.50', description: 'Тест', isActive: true });
  assert.equal(itemResponse.status, 201, JSON.stringify(itemResponse.body)); const item = itemResponse.body; catalogIds.push(item.id);
  const statusId = (await db.query('SELECT min(order_status_id) AS id FROM order_statuses WHERE is_active=true')).rows[0].id;
  const draft = { header: { orderName: prefix, clientId: Number(clientId), orderStatusId: Number(statusId), orderDate: '2026-09-10', discount: 1, surcharge: 0 },
    details: [], payments: [], workshops: [], requirements: [], dowelingLinks: [], deleted: {},
    catalogLines: [{ clientKey: randomUUID(), catalogItemId: item.id, catalogVersion: item.version, quantity: '2', unitPrice: '1500.50', notes: 'Тест API' }] };
  const created = await request('/orders', 'POST', draft); assert.equal(created.status, 201, JSON.stringify(created.body));
  const order = created.body.order; orderIds.push(order.header.orderId); if (order.header.projectId) projectIds.push(order.header.projectId);
  assert.equal(order.details.length, 0); assert.equal(order.catalogLines.length, 1); assert.equal(order.totals.totalAmount, 3001); assert.equal(order.totals.finalAmount, 3000);
  const orderPath = `/orders/${order.header.orderId}`;
  assert.equal((await request(orderPath, 'GET', undefined, false)).status, 401);
  // No external export request is made for goods-only orders.
  const exported = await request(orderPath + '/export/google-drive', 'POST', {});
  assert.equal(exported.status, 422, JSON.stringify(exported.body)); assert.equal(exported.body.error.code, 'ORDER_EXPORT_DETAILS_REQUIRED');
  const updated = await request(orderPath, 'PUT', { ...draft, version: order.version, catalogLines: undefined, header: { ...draft.header, notes: 'omission' } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body)); assert.equal(updated.body.order.totals.totalAmount, 3001);
  assert.equal((await request(orderPath, 'PUT', { ...draft, version: order.version })).status, 409);
  const empty = await request(orderPath, 'PUT', { ...draft, version: updated.body.order.version, header: { ...draft.header, discount: 0 }, catalogLines: [], deleted: { catalogLineIds: [order.catalogLines[0].id] } });
  assert.equal(empty.status, 422); assert.equal(empty.body.error.code, 'ORDER_POSITIONS_REQUIRED');
  assert.equal((await request(orderPath)).body.order.catalogLines.length, 1);
  console.log('PASS API: exact SHA, goods-only persisted, combined totals, omission, 401, stale409, empty422, Google422');

  if (process.env.ERP_ORDER_CATALOG_BROWSER_CANARY === 'true') {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) await context.route('https://app-test.mebelkz.app/**', route => route.continue({ headers: { ...route.request().headers(), 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET } }));
    page = await context.newPage(); const errors = [], exports = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/export/google-drive')) exports.push(request.url()); });
    await page.goto('https://app-test.mebelkz.app/login', { waitUntil: 'domcontentloaded' });
    await page.locator('#username').fill(process.env.CODEX_PLAYWRIGHT_USERNAME); await page.locator('#password').fill(process.env.CODEX_PLAYWRIGHT_PASSWORD);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 30000 });
    await page.goto(`https://app-test.mebelkz.app/orders/edit/${order.header.orderId}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Услуги/товары', exact: true }).click();
    const quantity = page.getByLabel(`Количество: ${prefix}`, { exact: true }); await quantity.waitFor();
    assert.equal(await quantity.inputValue(), '2.000');
    await quantity.fill('3'); await page.getByLabel(`Цена: ${prefix}`, { exact: true }).fill('2000');
    await page.getByLabel(`Примечание: ${prefix}`, { exact: true }).fill('Тест UI');
    const [saved] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith(orderPath) && response.request().method() === 'PUT'),
      page.getByRole('button', { name: /Сохранить$/ }).first().click(),
    ]);
    assert.equal(saved.status(), 200, JSON.stringify(await saved.json()));
    const loaded = (await request(orderPath)).body.order;
    assert.equal(loaded.catalogLines[0].unitPrice, '2000.00'); assert.equal(loaded.catalogLines[0].notes, 'Тест UI'); assert.equal(loaded.totals.totalAmount, 6000);
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('tab', { name: 'Услуги/товары', exact: true }).click();
    assert.equal(await page.getByLabel(`Цена: ${prefix}`, { exact: true }).inputValue(), '2000.00');
    await page.getByRole('combobox', { name: 'Добавить товар или услугу', exact: true }).fill(prefix);
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: prefix }).first().click();
    assert.equal(await page.getByLabel(`Цена: ${prefix}`, { exact: true }).nth(1).inputValue(), '1500.50');
    assert.equal(await page.getByLabel(`Количество: ${prefix}`, { exact: true }).nth(1).inputValue(), '1');
    await page.getByRole('button', { name: `Удалить: ${prefix}`, exact: true }).nth(1).click();
    await page.getByRole('button', { name: 'Удалить', exact: true }).last().click();
    assert.equal(await page.getByLabel(`Цена: ${prefix}`, { exact: true }).count(), 1);
    await page.screenshot({ path: '/home/ovhtest/projects/erp_dev/spec_erp/logs/order-catalog-stage.png', fullPage: true });
    assert.deepEqual(exports, []); assert.deepEqual(errors, []);
    console.log('PASS browser: renamed tab, reload, quantity/price/note save, picker defaults, delete draft, no automatic Google export, no page errors');
  }
} catch (error) {
  if (page) {
    console.error((await page.locator('.ant-notification, .ant-modal-content, .ant-alert').allTextContents()).join('\n'));
    await page.screenshot({ path: '/home/ovhtest/projects/erp_dev/spec_erp/logs/order-catalog-stage-failure.png', fullPage: true });
  }
  throw error;
} finally {
  await browser?.close();
  await db.query('BEGIN');
  try {
    // Stage fixtures only. Transactional DDL holds the table lock until COMMIT,
    // so other writers never observe append-only protection disabled.
    await db.query("SET LOCAL lock_timeout='3s'");
    await db.query('ALTER TABLE mdf_board_history_events DISABLE TRIGGER trg_mdf_board_history_events_append_only');
    // Exact own order IDs and actor only. Never clean unrelated users' records.
    for (const table of ['order_catalog_lines', 'mdf_board_history_coverage', 'mdf_board_history_events', 'mdf_board_history_state']) {
      await db.query(`DELETE FROM ${table} WHERE order_id=ANY($1::bigint[])`, [orderIds]);
    }
    await db.query('ALTER TABLE mdf_board_history_events ENABLE TRIGGER trg_mdf_board_history_events_append_only');
    const ownedAudit = "user_id=$1 AND (related_order_id=ANY($2::text[]::bigint[]) OR (entity_type='order' AND entity_id=ANY($2::text[])) OR (entity_type='catalog_item' AND entity_id=ANY($3::text[])) OR (entity_type='project' AND entity_id=ANY($4::text[])))";
    const ownedArgs = [actorId, orderIds.map(String), catalogIds.map(String), projectIds.map(String)];
    await db.query(`DELETE FROM audit_log_related_entity WHERE audit_id IN (SELECT audit_id FROM audit_log WHERE ${ownedAudit})`, ownedArgs);
    await db.query(`DELETE FROM audit_log WHERE ${ownedAudit}`, ownedArgs);
    await db.query("DELETE FROM outbox_events WHERE payload_json->>'actorUserId'=$1::text AND ((aggregate_type='order' AND aggregate_id=ANY($2::text[])) OR (aggregate_type='catalog_item' AND aggregate_id=ANY($3::text[])) OR (aggregate_type='project' AND aggregate_id=ANY($4::text[])))", ownedArgs);
    await db.query("DELETE FROM command_idempotency_keys WHERE actor_user_id=$1 AND command_name='orders.create' AND response_json->'header'->>'orderId'=ANY($2::text[])", [actorId, orderIds.map(String)]);
    await db.query("DELETE FROM catalog_item_commands WHERE actor_user_id=$1 AND response_json->>'id'=ANY($2::text[])", [actorId, catalogIds.map(String)]);
    await db.query('DELETE FROM orders WHERE order_id=ANY($1::bigint[]) AND created_by=$2', [orderIds, actorId]);
    await db.query('DELETE FROM projects WHERE project_id=ANY($1::bigint[]) AND client_id=$2', [projectIds, clientId]);
    await db.query('DELETE FROM catalog_items WHERE id=ANY($1::bigint[]) AND created_by=$2', [catalogIds, actorId]);
    if (clientId) await db.query('DELETE FROM clients WHERE client_id=$1 AND client_name=$2', [clientId, prefix]);
    await db.query('COMMIT');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM orders WHERE order_id=ANY($1::bigint[])', [orderIds])).rows[0].n, 0);
    console.log('CLEANUP verified: own orders, lines, client, project, catalogue removed');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  await db.end();
}
