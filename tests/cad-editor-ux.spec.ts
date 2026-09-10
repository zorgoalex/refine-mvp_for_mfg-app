import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { setupWorkflowMockApi, createWorkflowMockDb } from './helpers/mockWorkflowApi';
import { applyVariantChanges, cloneVariant, createGroups, type CadVariant, type CadSourceSnapshot } from '../backend/src/shared/cad-workspace';

async function setup(page: Page, count = 2, technical = false) {
  const permissions = ['orders.view', 'cad.view', 'cad.edit', 'cad.export', ...(technical ? ['cad.technology', 'cad.approve'] : [])];
  await setupWorkflowMockApi(page, createWorkflowMockDb(), { authUser: { id: '1', user_id: 1, username: 'Тест CAD', role: 'admin', role_id: 1, permissions } });
  const recipe = { code: 'neoclassic', version: '1', parameters: {} };
  const source: CadSourceSnapshot = { id: randomUUID(), orderId: 1, orderName: 'Тест CAD UX', capturedAt: '2026-09-10', parts: Array.from({ length: count }, (_, i) => ({
    orderId: 1, detailId: i + 1, detailNumber: i + 1, widthMm: 400, heightMm: 700, quantity: 4, thicknessMm: 16, material: 'Тест МДФ', millingTypeId: 1, millingName: 'Неоклассика', edgeName: '', recipe,
  })) };
  const original: CadVariant = { id: randomUUID(), workspaceId: randomUUID(), kind: 'original', name: 'Оригинал', version: 1, groups: createGroups([source], randomUUID), sources: [source], createdAt: '', parentId: null, jobId: null, renderRevision: null };
  const working = cloneVariant(original, randomUUID(), 'Рабочая 1', '');
  const variants = [original, working], archive = new Map(variants.map(v => [`${v.id}:1`, v]));
  const control = { failSave: false, conflict: false, sourceChanged: false, requireApproval: false, approved: false, approvalPolls: 0, approvalReason: '', previewCalls: 0, saves: [] as Array<{ key: string; version: number; groups: CadVariant['groups'] }>, forks: [] as Array<{ version: number; groups: CadVariant['groups'] }> };
  const commands = new Map<string, CadVariant>();
  const result = (g: CadVariant['groups'][number]) => ({ part_id: g.id, status: 'succeeded', snapshot_hash: 'a'.repeat(64), result: { input_recipe: g.recipe,
    geometry: { boundaries: [], milling: [{ path_id: 'p', layer: '~~pk_d6_s01', operation: 'pocket', depth_mm: 6, tool_id: 'tool_pr_d40', slot: 1, closed: true, segments: [], metadata: { ring_role: 'pocket_outer' }, points: [{ x: 20, y: 20 }, { x: 380, y: 20 }, { x: 380, y: 680 }, { x: 20, y: 680 }] }] },
    visualization: { version: 'test', quality: 'exact', profiles: [], schematic_path_ids: [], dimensions: [{ parameter: 'border_mm', kind: 'linear', value: g.recipe?.parameters.border_mm ?? 20, points: [{ x: 0, y: 350 }, { x: Number(g.recipe?.parameters.border_mm ?? 20), y: 350 }] }], regions: [{ kind: 'material', quality: 'exact', depth_mm: 0, polygons: [{ outer: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 700 }, { x: 0, y: 700 }], holes: [] }] }] }, files: [], errors: [], warnings: [] } });
  await page.route(/\/api\/v1\/orders(?:\?.*)?$/, route => route.fulfill({ json: { data: [{ orderId: 1, orderName: source.orderName }], pagination: { page: 1, total: 1, totalPages: 1, pageSize: 100 } } }));
  await page.route(/\/api\/v1\/cad\//, async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1/cad', ''), body = request.postDataJSON();
    const ok = (json: unknown) => route.fulfill({ json });
    if (path === '/capabilities') return ok({ enabled: true, editorEnabled: true });
    if (path === '/recipes') return ok({ recipes: [{ ...recipe, display_name: 'Неоклассика', status: 'production', manager_ready: true, snapshot_hash: 'a'.repeat(64), defaults: { border_mm: 20, depth_mm: 6 }, available_tools: [{ id: 'tool_pr_d40', display_name: 'Прямая Ø40' }], parameter_schema: {
      border_mm: { type: 'number', default: 20, label: 'Ширина рамки', unit: 'мм', manager_editable: true, min: 10, max: 50 }, depth_mm: { type: 'number', default: 6, label: 'Глубина', unit: 'мм', manager_editable: false },
    } }] });
    if (path === '/orders/1') return ok({ workspaceId: original.workspaceId, variants });
    const match = path.match(/^\/variants\/([^/]+)\/(.*)$/), v = variants.find(v => v.id === match?.[1]);
    if (match && v) {
      if (match[2] === 'source-status') return ok([{ orderId: 1, stale: control.sourceChanged, changedDetailIds: control.sourceChanged ? [1] : [] }]);
      if (match[2] === 'save') {
        const key = request.headers()['idempotency-key']; control.saves.push({ key, version: body.version, groups: body.groups });
        if (control.failSave) return route.abort('failed');
        if (control.conflict) { control.conflict = false; variants[variants.indexOf(v)] = { ...v, version: v.version + 1 }; return route.fulfill({ status: 409, json: { error: { code: 'CAD_STALE_VERSION', message: 'Коллега изменил вариант' } } }); }
        if (commands.has(key)) return ok(commands.get(key));
        const next = applyVariantChanges(v, body.version, body.groups, [source]); variants[variants.indexOf(v)] = next; archive.set(`${next.id}:${next.version}`, next); commands.set(key, next); return ok(next);
      }
      if (match[2] === 'fork') { control.forks.push(body); const old = archive.get(`${v.id}:${body.version}`)!; const next = { ...cloneVariant(old, randomUUID(), body.name, ''), groups: body.groups }; variants.push(next); archive.set(`${next.id}:1`, next); return ok(next); }
      if (match[2] === 'clone') { const next = cloneVariant(v, randomUUID(), body.name, ''); variants.push(next); archive.set(`${next.id}:1`, next); return ok(next); }
      if (match[2] === 'preview') { control.previewCalls++; return ok({ items: body.groups.map(result) }); }
      if (match[2].startsWith('runs/')) { const revision = Number(match[2].split('/')[1]), stored = archive.get(`${v.id}:${revision}`)!; return ok({ run: { id: 'run', status: 'succeeded', packageId: 'package', packageRequested: true, lastError: null }, job: { id: 'job', status: 'succeeded', total: stored.groups.length, completed: stored.groups.length, package_files: [], items: stored.groups.map(result) } }); }
      if (match[2] === 'approve') { control.approvalReason = body.reason; return ok({ id: 'approval', status: 'pending' }); }
      if (match[2] === 'preflight') { const ready = !control.requireApproval || control.approved; return ok({ ready, reviewId: ready ? 'review' : null, runId: 'run', version: body.version, variantName: v.name, positions: v.groups.length, quantity: v.groups.reduce((n, g) => n + g.quantity, 0), changedGroupIds: [], sourceStatus: [{ orderId: 1, orderName: source.orderName, stale: control.sourceChanged, changedDetailIds: control.sourceChanged ? [1] : [] }], readiness: { job_id: 'job', ready, items: ready ? [] : [{ part_id: v.groups[0].id, status: 'succeeded', ready: false, manufacturing_hash: 'b'.repeat(64) }] } }); }
      if (match[2] === 'package' || match[2] === 'render') return ok({ runId: 'run' });
    }
    if (path === '/approval-commands/approval') { control.approvalPolls++; control.approved = control.approvalPolls > 1; return ok({ id: 'approval', status: control.approved ? 'succeeded' : 'pending' }); }
    if (path === '/runs/run/artifacts/package') return route.fulfill({ body: 'test-zip', contentType: 'application/zip' });
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: path } } });
  });
  return { variants, original, working, control };
}

test('CAD side panels start collapsed, expand independently and preserve selection and scroll', async ({ page }) => {
  const { control } = await setup(page, 500);
  await page.setViewportSize({ width: 1500, height: 1000 }); await page.goto('/cad/orders/1');
  const parts = page.getByRole('button', { name: 'Детали (500)', exact: true });
  const properties = page.getByRole('button', { name: 'Свойства', exact: true });
  await expect(parts).toHaveAttribute('aria-expanded', 'false');
  await expect(properties).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Проверки', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Найти деталь')).toBeHidden();
  const canvas = page.getByRole('application', { name: /Поле CAD/ });
  const fullWidth = (await canvas.boundingBox())!.width;
  await page.screenshot({ path: 'test-results/cad-editor-ux/desktop-collapsed.png', fullPage: true });
  await parts.focus(); await page.keyboard.press('Enter');
  await expect(parts).toHaveAttribute('aria-expanded', 'true');
  await page.locator('.cad-part-card').first().click();
  await expect(properties).toHaveAttribute('aria-expanded', 'false');
  await properties.focus(); await page.keyboard.press('Space');
  await expect(page.getByLabel('Количество', { exact: true })).toHaveValue('4');
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeLessThan(fullWidth - 400);
  await page.screenshot({ path: 'test-results/cad-editor-ux/desktop-expanded.png', fullPage: true });
  const list = page.locator('.cad-part-list');
  await list.evaluate(el => { el.scrollTop = 5000; });
  await expect(page.locator('.cad-part-card').first()).not.toContainText('Позиция 1 ');
  const firstVisible = await page.locator('.cad-part-card').first().textContent();
  await parts.click(); await expect(page.getByLabel('Найти деталь')).toBeHidden();
  await expect(properties).toHaveAttribute('aria-expanded', 'true');
  await parts.click();
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBe(5000);
  await expect(page.locator('.cad-part-card').first()).toHaveText(firstVisible!);
  await expect(page.getByLabel('Количество', { exact: true })).toHaveValue('4');
  await parts.click(); await properties.click();
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBe(fullWidth);
  expect(control.saves).toEqual([]);
  await page.getByRole('tab', { name: /Оригинал/ }).click();
  await expect(parts).toHaveAttribute('aria-expanded', 'false');
  await expect(properties).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(parts).toHaveAttribute('aria-expanded', 'false');
  await expect(properties).toHaveAttribute('aria-expanded', 'false');
});

async function selectFirstDesktopPart(page: Page) {
  await page.getByRole('button', { name: 'Детали (2)', exact: true }).click();
  await page.locator('.cad-part-card').first().click();
  await page.getByRole('button', { name: 'Свойства', exact: true }).click();
}

test('issues open the collapsed desktop inspector without a duplicate drawer form', async ({ page }) => {
  const { working } = await setup(page); working.groups[0].recipe = null;
  await page.setViewportSize({ width: 1500, height: 1000 }); await page.goto('/cad/orders/1');
  const properties = page.getByRole('button', { name: 'Свойства', exact: true });
  await expect(properties).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Проверки (1)', exact: true }).click();
  await page.getByRole('button', { name: 'Перейти к детали', exact: true }).click();
  await expect(properties).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Фрезеровка детали', exact: true })).toHaveCount(1);
  await expect(page.getByRole('combobox', { name: 'Фрезеровка детали', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Детали (2)', exact: true })).toHaveAttribute('aria-expanded', 'false');
});

test('manager starts in working variant; human parameters autosave; original remains locked', async ({ page }) => {
  const state = await setup(page); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1500, height: 1000 }); await page.goto('/cad/orders/1');
  await expect(page.getByRole('heading', { name: 'Фрезеровки заказов' })).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole('tab', { name: 'Рабочая 1' })).toHaveAttribute('aria-selected', 'true');
  await selectFirstDesktopPart(page);
  await expect(page.getByLabel('Глубина, мм', { exact: true })).toHaveCount(0);
  await page.getByLabel('Ширина рамки, мм', { exact: true }).fill('30');
  await expect.poll(() => state.control.saves.length).toBe(1);
  await expect(page.getByText('Все изменения сохранены', { exact: true })).toBeVisible();
  expect(state.variants.find(v => v.id === state.working.id)?.groups[0].recipe?.parameters.border_mm).toBe(30);
  expect(state.original.groups[0].recipe?.parameters).toEqual({});
  await page.getByRole('checkbox', { name: 'Расширенный режим' }).check();
  await expect(page.getByLabel('Глубина, мм', { exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: /Оригинал/ }).click(); await expect(page.getByText('Оригинал · только просмотр', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('network failure keeps draft and stable key; incomplete input blocks export', async ({ page }) => {
  const { control } = await setup(page); await page.setViewportSize({ width: 1500, height: 1000 }); await page.goto('/cad/orders/1');
  await selectFirstDesktopPart(page); control.failSave = true;
  await page.getByLabel('Ширина рамки, мм', { exact: true }).fill('33');
  await expect(page.getByText('Изменения остались в этой вкладке', { exact: true })).toBeVisible();
  control.failSave = false; await page.getByRole('button', { name: 'Повторить сохранение' }).click();
  await expect(page.getByText('Все изменения сохранены', { exact: true })).toBeVisible();
  expect(new Set(control.saves.map(s => s.key)).size).toBe(1);
  await page.getByLabel('Ширина рамки, мм', { exact: true }).fill('');
  await expect(page.getByRole('button', { name: 'Скачать фрезеровки', exact: true })).toBeDisabled();
  await expect(page.getByText('Введите число', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Свойства', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Свойства', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Ширина рамки, мм', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Скачать фрезеровки', exact: true })).toBeDisabled();
  await page.getByLabel('Ширина рамки, мм', { exact: true }).fill('35');
  await page.getByRole('button', { name: 'Свойства', exact: true }).click();
  await expect(page.getByLabel('Ширина рамки, мм', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Свойства', exact: true }).click();
  await expect(page.getByLabel('Ширина рамки, мм', { exact: true })).toHaveValue('35');
});

test('CAS conflict forks exact original base plus own draft', async ({ page }) => {
  const { control, working, variants } = await setup(page); await page.setViewportSize({ width: 1500, height: 1000 }); await page.goto('/cad/orders/1');
  await selectFirstDesktopPart(page); control.conflict = true;
  await page.getByLabel('Ширина рамки, мм', { exact: true }).fill('34');
  await expect(page.getByText('Коллега уже изменил этот вариант', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Сохранить мои в новый вариант' }).click();
  await page.getByLabel('Имя нового варианта').fill('Тест мой вариант'); await page.getByRole('dialog').getByRole('button', { name: /OK|ОК/ }).click();
  await expect(page.getByRole('tab', { name: 'Тест мой вариант' })).toHaveAttribute('aria-selected', 'true');
  expect(control.forks[0].version).toBe(1); expect(control.forks[0].groups[0].recipe?.parameters.border_mm).toBe(34);
  expect(variants.find(v => v.id === working.id)?.groups[0].recipe?.parameters).toEqual({});
});

test('one download flow requires explicit source acknowledgement', async ({ page }) => {
  const { control } = await setup(page); control.sourceChanged = true; await page.goto('/cad/orders/1');
  await page.getByRole('button', { name: 'Скачать фрезеровки', exact: true }).click();
  const confirm = page.getByRole('button', { name: 'Подтвердить и подготовить ZIP' }); await expect(confirm).toBeDisabled();
  await page.getByRole('checkbox', { name: /Подтверждаю выгрузку/ }).check(); await confirm.click();
  await expect(page.getByText('Готово к скачиванию', { exact: true })).toBeVisible();
  await page.evaluate(() => document.addEventListener('click', e => { if (e.target instanceof HTMLAnchorElement) document.documentElement.dataset.downloadName = e.target.download; }, true));
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: /Скачать ZIP$/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-download-name', 'cad-Рабочая 1.zip');
  expect((await download).suggestedFilename()).toContain('Рабочая');
});

test('tablet drawers, keyboard placement and 500-group virtualization', async ({ page }) => {
  const { control } = await setup(page, 500); await page.setViewportSize({ width: 1024, height: 768 }); await page.goto('/cad/orders/1');
  await expect(page.getByRole('button', { name: 'Детали (500)' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Свойства', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Детали (500)' }).click();
  await expect(page.locator('.cad-part-card')).toHaveCount(14); await page.locator('.cad-part-card').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click(); await page.getByRole('button', { name: 'Свойства', exact: true }).click();
  await expect(page.getByLabel('Ширина рамки, мм', { exact: true })).toBeVisible(); await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  const canvas = page.getByRole('application', { name: /Поле CAD/ }); await canvas.focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(() => control.saves.length).toBe(1); expect(control.saves[0].groups[0].xMm).toBe(1);
  await page.getByRole('button', { name: 'Панорама', exact: true }).click(); await expect(page.getByRole('button', { name: 'Выбор', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await canvas.focus(); await page.keyboard.press('m'); await page.keyboard.press('Enter'); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Enter');
  await expect(page.getByText('Расстояние: 10.00 мм', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Детали (500)' }).click(); await page.getByRole('checkbox', { name: 'Выбрать несколько' }).check(); await page.locator('.cad-part-card').nth(1).click();
  await expect(page.locator('.cad-part-card[aria-pressed="true"]')).toHaveCount(2);
  await page.locator('.cad-part-list').evaluate(el => { el.scrollTop = 5000; });
  await expect(page.locator('.cad-part-card').first()).not.toContainText('Позиция 1 ');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Детали (500)' }).click();
  await expect.poll(() => page.locator('.cad-part-list').evaluate(el => el.scrollTop)).toBe(5000);
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.screenshot({ path: 'test-results/cad-editor-ux/tablet-500.png', fullPage: true });
});

test('technologist edits depth and waits for scoped approval receipt before ZIP', async ({ page }) => {
  const { control } = await setup(page, 2, true); control.requireApproval = true;
  await page.setViewportSize({ width: 1500, height: 1000 }); await page.goto('/cad/orders/1');
  await selectFirstDesktopPart(page); await page.getByRole('checkbox', { name: 'Расширенный режим' }).check();
  await page.getByLabel('Глубина, мм', { exact: true }).fill('7');
  await expect(page.getByText('Все изменения сохранены', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Скачать фрезеровки', exact: true }).click();
  await page.getByRole('button', { name: 'Одобрить для этой детали' }).click();
  await page.getByLabel('Причина индивидуального одобрения').fill('Проверено на образце 16 мм');
  await page.getByRole('button', { name: 'Подтвердить одобрение' }).click();
  await expect(page.getByText('Ожидаем подтверждение CAD. Деталь ещё не считается одобренной.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Подтвердить и подготовить ZIP' })).toBeVisible();
  expect(control.approvalReason).toBe('Проверено на образце 16 мм'); expect(control.approvalPolls).toBeGreaterThan(1);
});

test('browser retains a Cyrillic blob download filename', async ({ page }) => {
  await page.setContent('<button>download</button>');
  await page.evaluate(() => document.querySelector('button')!.addEventListener('click', () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['test'], { type: 'application/zip' })); a.download = 'cad-Рабочая 1.zip'; document.body.append(a); a.click(); a.remove();
  }));
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'download' }).click();
  expect((await download).suggestedFilename()).toBe('cad-Рабочая 1.zip');
});
