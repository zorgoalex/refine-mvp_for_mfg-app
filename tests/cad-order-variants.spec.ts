import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi } from './helpers/mockWorkflowApi';
import { applyVariantChanges, cloneVariant, createGroups, type CadSourceSnapshot, type CadVariant } from '../backend/src/shared/cad-workspace';

async function setup(page: Page, count = 2) {
  const authUser = { id: '1', user_id: 1, username: 'Тест CAD', role: 'admin', role_id: 1, permissions: ['orders.view', 'cad.view', 'cad.edit', 'cad.export', 'references.manage'] };
  await setupWorkflowMockApi(page, createWorkflowMockDb(), { authUser });
  const variants: CadVariant[] = [], sources: CadSourceSnapshot[] = [], requests: string[] = [];
  const recipe = { code: 'contour_only', version: '1.0.0', parameters: {} };
  const catalog = { fail: false, recipes: [
    { ...recipe, display_name: 'Без фрезеровки', status: 'production', snapshot_hash: '1'.repeat(64), defaults: {}, parameter_schema: {} },
    { code: 'rib_sq', version: '1', display_name: 'Квадратная лапша', status: 'review', snapshot_hash: '2'.repeat(64), defaults: { depth_mm: 2 }, parameter_schema: { depth_mm: { type: 'number', default: 2 } } },
  ] };
  const capture = (orderId: number): CadSourceSnapshot => {
    const source = { id: randomUUID(), orderId, orderName: `Тест CAD ${orderId}`, capturedAt: '2026-09-06',
      parts: Array.from({ length: count }, (_, n) => ({ orderId, detailId: orderId * 1000 + n + 1, detailNumber: n + 1,
        widthMm: 200, heightMm: 400, quantity: 10, thicknessMm: 18, material: 'Тест МДФ', millingTypeId: 1, millingName: 'Тест контур', edgeName: 'Тест обкат', recipe })) };
    sources.push(source); return source;
  };
  await page.route(/\/api\/v1\/orders(?:\?.*)?$/, route => route.fulfill({ json: { data: [1, 2, 3, 4, 5].map(id => ({ orderId: id, orderName: `Тест CAD ${id}`, clientName: 'Тест клиент' })), pagination: { page: 1, total: 5, totalPages: 1, pageSize: 100 } } }));
  await page.route(/\/api\/v1\/cad\//, async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/v1/cad', '');
    const body = request.postDataJSON(); requests.push(`${request.method()} ${path}`);
    const ok = (json: unknown) => route.fulfill({ json });
    if (path === '/capabilities') return ok({ enabled: true });
    if (path === '/recipes') return catalog.fail
      ? route.fulfill({ status: 503, json: { error: { code: 'CAD_UNAVAILABLE', message: 'Тест: CAD недоступен' } } })
      : ok({ recipes: catalog.recipes });
    if (path === '/mappings') return ok([{ milling_type_id: 1, milling_type_name: 'Тест фрезеровка', recipe, revision: 1 }]);
    const sourceMatch = path.match(/^\/orders\/(\d+)\/source$/);
    if (sourceMatch) return ok(capture(Number(sourceMatch[1])));
    const order = path.match(/^\/orders\/(\d+)(\/render)?$/);
    if (order) {
      const id = Number(order[1]); let stored = variants.filter(v => v.sources[0].orderId === id);
      if (order[2] && !stored.length) {
        const source = capture(id), original: CadVariant = { id: randomUUID(), workspaceId: randomUUID(), name: 'Оригинал', kind: 'original', version: 1, groups: createGroups([source], randomUUID), sources: [source], createdAt: '2026-09-06', parentId: null, jobId: null, renderRevision: null };
        stored = [original, cloneVariant(original, randomUUID(), 'Рабочая 1', '2026-09-06')]; variants.push(...stored);
      }
      return ok({ workspaceId: stored[0]?.workspaceId ?? null, variants: stored });
    }
    const match = path.match(/^\/variants\/([^/]+)\/(.*)$/), variant = variants.find(v => v.id === match?.[1]);
    if (match && variant) {
      if (match[2] === 'source-status') return ok(variant.sources.map(s => ({ orderId: s.orderId, stale: false, changedDetailIds: [] })));
      if (match[2] === 'save') { const next = applyVariantChanges(variant, body.version, body.groups, sources.filter(s => body.sourceIds.includes(s.id))); variants[variants.indexOf(variant)] = next; return ok(next); }
      if (match[2] === 'clone') { const next = cloneVariant(variant, randomUUID(), body.name, '2026-09-06'); variants.push(next); return ok(next); }
      if (match[2] === 'render' || match[2] === 'package') return ok({ runId: 'run' });
      if (match[2].startsWith('runs/')) return ok({ run: { id: 'run', status: 'succeeded', packageId: 'package', packageRequested: true, lastError: null }, job: {
        id: 'job', status: 'succeeded', total: variant.groups.length, completed: variant.groups.length, package_files: [],
        items: variant.groups.map(g => ({ part_id: g.id, status: 'succeeded', result: {
          input_recipe: g.recipe, geometry: { boundaries: [], milling: Array.from({ length: 50 }, (_, n) => ({ path_id: `p${n}`, layer: '~~gr_dia6_d2_s08', operation: 'groove', points: [{ x: 4 * n, y: 0 }, { x: 4 * n, y: 400 }], closed: false, segments: [], slot: 8, depth_mm: 2, tool_id: 'tool_pr_d6' })) }, files: [], errors: [], warnings: [] } })) } });
    }
    if (path === '/runs/run/artifacts/package') return route.fulfill({ body: 'mock-package', contentType: 'application/zip', headers: { 'Content-Disposition': 'attachment; filename=test.zip' } });
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: path } } });
  });
  return { variants, requests, catalog };
}

test('recipe catalog refreshes on modal open and polls without changing the assigned version', async ({ page }) => {
  const { catalog, requests } = await setup(page);
  await page.clock.install();
  await page.goto('/cad');
  await expect.poll(() => requests.filter(r => r === 'GET /recipes').length).toBe(1);
  catalog.recipes.push({ ...catalog.recipes[0], version: '1.0.1' });
  await page.getByRole('button', { name: 'Соответствия фрезеровок' }).click();
  const select = page.locator('.ant-select[aria-label="Рецепт CAD: Тест фрезеровка"]');
  await select.locator('.ant-select-selector').click();
  await expect(page.getByText('Без фрезеровки · 1.0.1', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('Квадратная лапша · 1', { exact: true })).toHaveCount(0);
  catalog.recipes.push({ ...catalog.recipes[0], version: '1.0.2' });
  await page.clock.fastForward(10_100);
  await expect(page.getByText('Без фрезеровки · 1.0.2', { exact: true }).last()).toBeVisible();
  await expect(select.locator('.ant-select-selection-item')).toHaveText('Без фрезеровки · 1.0.0');
  expect(requests.filter(r => !r.startsWith('GET '))).toEqual([]);

  await page.keyboard.press('Escape');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  const count = requests.filter(r => r === 'GET /recipes').length;
  await page.clock.fastForward(30_100);
  expect(requests.filter(r => r === 'GET /recipes')).toHaveLength(count);
});

test('catalog pauses when hidden, refreshes on return, retains options on error and supports retry', async ({ page }) => {
  const { catalog, requests } = await setup(page);
  await page.clock.install();
  await page.goto('/cad');
  await page.getByRole('button', { name: 'Соответствия фрезеровок' }).click();
  await expect(page.getByRole('button', { name: 'Обновить список' })).not.toHaveClass(/ant-btn-loading/);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const count = requests.filter(r => r === 'GET /recipes').length;
  catalog.recipes.push({ ...catalog.recipes[0], version: '1.0.3' });
  await page.clock.fastForward(30_100);
  expect(requests.filter(r => r === 'GET /recipes')).toHaveLength(count);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  const select = page.locator('.ant-select[aria-label="Рецепт CAD: Тест фрезеровка"]');
  await select.locator('.ant-select-selector').click();
  await expect(page.getByText('Без фрезеровки · 1.0.3', { exact: true }).last()).toBeVisible();
  await page.keyboard.press('Escape');
  catalog.fail = true;
  await page.getByRole('button', { name: 'Обновить список' }).click();
  await expect(page.getByText('Не удалось обновить каталог CAD', { exact: true })).toBeVisible();
  await expect(select.locator('.ant-select-selection-item')).toHaveText('Без фрезеровки · 1.0.0');
  await select.locator('.ant-select-selector').click();
  await expect(page.getByText('Без фрезеровки · 1.0.3', { exact: true }).last()).toBeVisible();
  await page.keyboard.press('Escape');
  catalog.fail = false;
  await page.getByRole('button', { name: 'Обновить список' }).click();
  await expect(page.getByText('Не удалось обновить каталог CAD', { exact: true })).toHaveCount(0);
  expect(requests.filter(r => !r.startsWith('GET '))).toEqual([]);
});

test('unapproved-only catalog explains the empty list and an approval appears without reload', async ({ page }) => {
  const { catalog } = await setup(page);
  catalog.recipes = catalog.recipes.filter(r => r.status === 'review');
  await page.clock.install();
  await page.goto('/cad');
  await page.getByRole('button', { name: 'Соответствия фрезеровок' }).click();
  await expect(page.getByText('Нет одобренных версий рецептов', { exact: true })).toBeVisible();
  catalog.recipes[0].status = 'production';
  await page.clock.fastForward(10_100);
  await expect(page.getByText('Нет одобренных версий рецептов', { exact: true })).toHaveCount(0);
  await page.locator('.ant-select[aria-label="Рецепт CAD: Тест фрезеровка"] .ant-select-selector').click();
  await expect(page.getByText('Квадратная лапша · 1', { exact: true }).last()).toBeVisible();
});

test('original stays immutable; split/import/save/clone/export through actual controls', async ({ page }) => {
  const { variants, requests } = await setup(page); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/cad/orders/1'); await page.getByRole('button', { name: 'Отрисовать заказ', exact: true }).click();
  await expect(page.getByRole('tab', { name: /Оригинал/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
  const frozen = JSON.stringify(variants.find(v => v.kind === 'original'));
  await page.getByRole('tab', { name: 'Рабочая 1', exact: true }).click();
  await page.locator('.cad-part-row').first().click(); await page.getByRole('button', { name: 'Разделить количество' }).click();
  await expect(page.locator('.cad-part-row')).toHaveCount(3);
  await page.locator('.ant-select[aria-label="Фрезеровка рабочей версии"] .ant-select-selector').click(); await page.getByText('Квадратная лапша · 1 · review', { exact: true }).click();
  await page.getByLabel('depth_mm', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Добавить из заказа' }).click();
  await page.locator('.ant-select[aria-label="Исходный заказ"] .ant-select-selector').click(); await page.getByText('Тест CAD 2 · Тест клиент', { exact: true }).last().click();
  await page.getByRole('button', { name: 'Получить состав' }).click();
  await page.getByLabel('Количество позиции 1', { exact: true }).fill('2');
  await page.getByLabel('Количество позиции 2', { exact: true }).fill('0');
  await page.getByRole('dialog').getByRole('button', { name: /OK|ОК/ }).click();
  await expect(page.locator('.cad-part-row')).toHaveCount(4);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByText('Сохранено · редакция 2')).toBeVisible();
  expect(JSON.stringify(variants.find(v => v.kind === 'original'))).toBe(frozen);
  await page.getByRole('button', { name: 'Создать версию', exact: true }).click();
  await page.getByLabel('Имя версии').fill('Тест альтернативная'); await page.getByRole('dialog').getByRole('button', { name: /OK|ОК/ }).click();
  await expect(page.getByRole('tab', { name: 'Тест альтернативная' })).toHaveAttribute('aria-selected', 'true');
  await page.locator('.cad-page > .ant-tabs .ant-tabs-tab').filter({ hasText: 'Тест альтернативная' }).getByRole('button', { name: 'remove' }).click();
  await expect(page.getByRole('tab', { name: 'Тест альтернативная' })).toHaveCount(0);
  await page.locator('.ant-select[aria-label="Открыть сохранённую версию"] .ant-select-selector').click();
  await page.getByText('Тест альтернативная', { exact: true }).last().click();
  await expect(page.getByRole('tab', { name: 'Тест альтернативная' })).toHaveAttribute('aria-selected', 'true');
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Скачать ZIP', exact: true }).click(); await download;
  expect(requests.some(r => r.endsWith('/save'))).toBe(true); expect(errors).toEqual([]);
  expect(requests.filter(r => /^POST .*\/render$/.test(r))).toHaveLength(1);
  await page.screenshot({ path: 'test-results/cad-working-variant.png', fullPage: true });
});

test('500 groups, five workspaces: only active canvas mounted; tab changes do not render', async ({ page }) => {
  const { requests } = await setup(page, 500); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/cad/orders/1');
  for (const id of [1, 2, 3, 4, 5]) {
    if (id !== 1) { await page.locator('[data-workspace-key]:not([hidden]) .ant-select[aria-label="Выбрать заказ"] .ant-select-selector').click(); await page.getByText(`Тест CAD ${id} · Тест клиент`, { exact: true }).last().click(); }
    await page.getByRole('button', { name: 'Отрисовать заказ', exact: true }).click();
    await expect(page.locator('[data-workspace-key]:not([hidden]) .cad-part-row')).toHaveCount(500);
    await expect(page.locator('.konvajs-content')).toHaveCount(1);
  }
  expect(requests.filter(r => /^POST .*\/render$/.test(r))).toHaveLength(5);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/cad-500-groups.png', fullPage: true });
});

test('CAD admin reviews exact ERP overrides, clears old preview and approves its hash', async ({ page }) => {
  const cadRepo = process.env.CAD_TEST_REPO ?? resolve(process.cwd(), '../cad-integration-api');
  const html = readFileSync(resolve(cadRepo, 'cad_service/web/integration.html'), 'utf8');
  const snapshot = 'a'.repeat(64), submissions: any[] = [], approvals: string[] = [];
  const recipe = { code: 'test_recipe', version: '1', parameters: { depth_mm: 3 } };
  await page.route('**/cad-admin-test', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.route('**/api/v2/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/recipes')) return route.fulfill({ json: { recipes: [{ code: recipe.code, version: recipe.version, display_name: 'Тест рецепт', algorithm: 'test', defaults: { depth_mm: 2 }, snapshot_hash: 'b'.repeat(64), status: 'review' }] } });
    if (path.endsWith('/capabilities')) return route.fulfill({ json: { formats: ['svg', 'dxf'] } });
    if (path.includes('/snapshots/')) return route.fulfill({ json: { snapshot_hash: snapshot, recipe, snapshot: { resolved_parameters: recipe.parameters }, tools: {} } });
    if (path.endsWith('/approve')) { approvals.push(route.request().postDataJSON().snapshot_hash); return route.fulfill({ json: { approved: true } }); }
    if (path === '/api/v2/jobs') {
      const body = route.request().postDataJSON(); submissions.push(body);
      const valid = body.parts[0].width_mm >= 30;
      return route.fulfill({ json: { id: 'preview', status: valid ? 'succeeded' : 'failed', completed: 1, total: 1, items: [{ snapshot_hash: snapshot, status: valid ? 'succeeded' : 'failed', result: valid ? { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="1" y="1" width="98" height="98" fill="none" stroke="black"/></svg>' } : { errors: [{ code: 'MIN_SIZE' }] } }] } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/cad-admin-test'); await expect(page.locator('#status')).toContainText('Каталог загружен');
  await page.getByLabel('Хеш снимка из ERP (проверка изменённых параметров)').fill(snapshot);
  await page.getByRole('button', { name: 'Открыть снимок для проверки' }).click();
  await expect(page.locator('#review-settings')).toContainText(snapshot);
  await page.locator('#render').click(); await expect(page.locator('#preview')).toBeVisible();
  expect(submissions[0].parts[0].recipe).toEqual(recipe);
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#approve-result').click(); await expect(page.locator('#status')).toHaveText('Снимок результата одобрен.');
  expect(approvals).toEqual([snapshot]);
  await page.getByLabel('Ширина, мм', { exact: true }).fill('20'); await page.locator('#render').click();
  await expect(page.locator('#status')).toHaveText('Результат: failed');
  await expect(page.locator('#preview')).toBeHidden(); await expect(page.locator('#approve-result')).toBeDisabled();
  await expect(page.locator('#download')).toBeDisabled();
});
