// Explicit stage-only API/concurrency canary. Run through rtk-heavy-guard.
// Removes only its own randomly-prefixed catalogue fixtures in finally.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

assert.equal(process.env.ERP_CATALOG_TEST_TARGET_ENV, 'backend-test');
const expectedSha = process.env.ERP_CATALOG_EXPECTED_SHA;
assert.match(expectedSha ?? '', /^[a-f0-9]{40}$/);
const api = 'https://backend-test.mebelkz.app/api/v1';
const prefix = `E2E-catalog-stage-${randomUUID()}`;
const url = new URL(execFileSync('docker', ['exec', 'erp_test-backend-1', 'printenv', 'DATABASE_URL'], { encoding: 'utf8' }).trim());
url.hostname = '100.99.106.72';
const db = new pg.Client({ connectionString: url.href, statement_timeout: 10000 });
await db.connect();
let actorId;
let bearer;
let browser;
let source;
const request = async (path, method = 'GET', body, key, auth = true) => {
  const response = await fetch(api + path, { method, headers: { ...(auth ? { authorization: `Bearer ${bearer}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
  body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  return { status: response.status, body: await response.json() };
};
try {
  const health = await (await fetch('https://backend-test.mebelkz.app/health/ready')).json();
  assert.equal(health.status, 'ready'); assert.equal(health.deployment.gitCommitSha, expectedSha);
  const login = await request('/auth/login', 'POST', { username: process.env.CODEX_PLAYWRIGHT_USERNAME, password: process.env.CODEX_PLAYWRIGHT_PASSWORD }, undefined, false);
  assert.equal(login.status, 200); bearer = login.body.accessToken; actorId = String(login.body.user.id);
  assert.ok(bearer); assert.match(actorId, /^\d+$/);
  console.log(`Fixture scope: ${prefix}; actor=${actorId}`);
  assert.equal((await request('/catalog-items', 'GET', undefined, undefined, false)).status, 401);
  const units = await request('/catalog-items/units'); assert.equal(units.status, 200); assert.ok(units.body.length);
  source = { name: prefix, sku: prefix, kind: 'service', unitId: units.body[0].id, basePrice: '1500.50', description: 'Rollback canary', isActive: true };
  const commandKey = randomUUID();
  const same = await Promise.all([request('/catalog-items', 'POST', source, commandKey), request('/catalog-items', 'POST', source, commandKey)]);
  assert.deepEqual(same.map(result => result.status), [201, 201]); assert.equal(same[0].body.id, same[1].body.id);
  const item = same[0].body;
  const edits = await Promise.all(['A', 'B'].map(description => request(`/catalog-items/${item.id}`, 'PUT', { ...source, description, expectedVersion: 1 }, randomUUID())));
  assert.deepEqual(edits.map(result => result.status).sort(), [200, 409]);
  const latest = edits.find(result => result.status === 200).body;
  const duplicate = await Promise.all(['one', 'two'].map(suffix => request('/catalog-items', 'POST', { ...source, name: prefix + suffix, sku: prefix + '-duplicate' }, randomUUID())));
  assert.deepEqual(duplicate.map(result => result.status).sort(), [201, 409]);
  const archived = await request(`/catalog-items/${item.id}`, 'PUT', { ...source, expectedVersion: latest.version, isActive: false }, randomUUID());
  assert.equal(archived.status, 200);
  assert.equal((await request(`/catalog-items?q=${encodeURIComponent(prefix)}&active=false`)).body.total, 1);
  const restored = await request(`/catalog-items/${item.id}`, 'PUT', { ...source, expectedVersion: archived.body.version }, randomUUID());
  assert.equal(restored.status, 200);
  console.log('PASS stage API: exact SHA, units, 401, concurrent same-key replay, version conflict, SKU uniqueness, archive/restore');

  if (process.env.ERP_CATALOG_BROWSER_CANARY === 'true') {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1365, height: 950 } });
    if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) await context.route('https://app-test.mebelkz.app/**', route => route.continue({ headers: { ...route.request().headers(), 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET } }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://app-test.mebelkz.app/login', { waitUntil: 'domcontentloaded' });
    await page.locator('#username').fill(process.env.CODEX_PLAYWRIGHT_USERNAME);
    await page.locator('#password').fill(process.env.CODEX_PLAYWRIGHT_PASSWORD);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 30000 });
    await page.goto('https://app-test.mebelkz.app/catalog-items', { waitUntil: 'domcontentloaded' });
    const createButton = page.getByRole('button', { name: /Создать позицию$/ });
    await createButton.waitFor();
    const search = page.getByLabel('Поиск товара или услуги', { exact: true });
    await search.fill(prefix); await search.press('Enter');
    await page.getByText(prefix, { exact: true }).first().waitFor();
    await createButton.click();
    await page.getByLabel('Название', { exact: true }).fill(prefix + '-UI');
    await page.getByLabel('Единица измерения', { exact: true }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
    await page.getByLabel('Базовая цена, ₸', { exact: true }).fill('2500');
    const refKey1c = randomUUID();
    await page.getByLabel('1C_key', { exact: true }).fill(refKey1c);
    await page.getByLabel('Порядок сортировки', { exact: true }).fill('5');
    assert.equal(await page.getByRole('switch', { name: 'Активен', exact: true }).isChecked(), true);
    const savedResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/catalog-items') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const saved = await savedResponse;
    assert.equal(saved.status(), 201);
    const savedItem = await saved.json();
    assert.equal(savedItem.refKey1c, refKey1c);
    assert.equal(savedItem.sortOrder, 5);
    assert.equal(savedItem.createdBy, actorId);
    await page.getByText(prefix + '-UI', { exact: true }).waitFor();
    await page.getByRole('row').filter({ hasText: prefix + '-UI' }).getByRole('button', { name: 'Изменить', exact: true }).click();
    await page.getByText('Данные записи — заполняются системой', { exact: true }).waitFor();
    for (const label of ['Кто создал', 'Кто изменил', 'Дата создания', 'Дата изменения']) await page.getByText(label, { exact: true }).waitFor();
    assert.equal(await page.getByLabel('1C_key', { exact: true }).inputValue(), refKey1c);
    await page.screenshot({ path: process.env.ERP_CATALOG_SCREENSHOT ?? '/home/ovhtest/projects/erp_dev/spec_erp/logs/catalog-items-stage.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS stage browser: login, catalogue, search, create, price, 1C UUID, sort, active, metadata, row refresh, no page errors');
  }
} finally {
  await browser?.close();
  if (actorId) {
    await db.query('BEGIN');
    try {
      const ids = (await db.query('SELECT id FROM catalog_items WHERE created_by=$1 AND left(name,length($2::text))=$2::text FOR UPDATE', [actorId, prefix])).rows.map(row => String(row.id));
      await db.query("DELETE FROM audit_log_related_entity WHERE audit_id IN (SELECT audit_id FROM audit_log WHERE entity_type='catalog_item' AND entity_id=ANY($1::text[]) AND user_id=$2)", [ids, actorId]);
      await db.query("DELETE FROM audit_log WHERE entity_type='catalog_item' AND entity_id=ANY($1::text[]) AND user_id=$2", [ids, actorId]);
      await db.query("DELETE FROM outbox_events WHERE aggregate_type='catalog_item' AND aggregate_id=ANY($1::text[]) AND payload_json->>'actorUserId'=$2::text", [ids, actorId]);
      await db.query("DELETE FROM catalog_item_commands WHERE actor_user_id=$1 AND response_json->>'id'=ANY($2::text[])", [actorId, ids]);
      await db.query('DELETE FROM catalog_items WHERE created_by=$1 AND id=ANY($2::bigint[])', [actorId, ids]);
      await db.query('COMMIT');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM catalog_items WHERE left(name,length($1::text))=$1::text', [prefix])).rows[0].n, 0);
      console.log(`CLEANUP verified: ${ids.length} owned fixture items removed`);
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  }
  await db.end();
}
