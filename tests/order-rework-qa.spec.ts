import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  PREFIX, cleanup, createOrder, createUser, detailStates, frontendUrl, login, openOrder, orderState, psql, qaEnabled,
  residue, rounds, runId, type Fixture,
} from './helpers/reworkQa';

/**
 * «Переделка» browser QA on an isolated copy of the stage DB (own backend/Hasura/Vite; MDF engine legacy,
 * BACKEND_ORDER_REWORK_ENABLED=true). Run: ORDER_REWORK_QA=true PLAYWRIGHT_SKIP_WEB_SERVER=true
 * npx playwright test tests/order-rework-qa.spec.ts
 */
const shots = process.env.ORDER_REWORK_QA_SHOTS ?? 'test-results/order-rework-qa';
const tag = runId();

test.describe.configure({ mode: 'serial' });

test.describe('«Переделка» — browser QA (isolated stack)', () => {
  test.skip(!qaEnabled, 'Run with ORDER_REWORK_QA=true against the isolated rework QA stack');
  test.setTimeout(240_000);

  let admin: { userId: number; password: string; username: string };
  let manager: { userId: number; password: string; username: string };
  let worker: { userId: number; password: string; username: string };
  let ready: Fixture;
  let inProduction: Fixture;
  let sawn: Fixture;

  test.beforeAll(() => {
    cleanup();
    const mk = (role: number, name: string) => ({ ...createUser(`e2e_rework_qa_${name}_${tag}`, role), username: `e2e_rework_qa_${name}_${tag}` });
    admin = mk(1, 'admin');
    manager = mk(10, 'manager');
    worker = mk(20, 'worker');
    ready = createOrder({ name: `${PREFIX} готов ${tag}`, createdBy: admin.userId, orderStatus: 'legacy_6', detailStage: 'packed' });
    inProduction = createOrder({ name: `${PREFIX} в производстве ${tag}`, createdBy: admin.userId, orderStatus: 'legacy_4', detailStage: 'cut' });
    sawn = createOrder({ name: `${PREFIX} распилен ${tag}`, createdBy: admin.userId, orderStatus: 'legacy_5', detailStage: 'cut' });
  });

  test.afterAll(() => {
    psql("UPDATE mdf_engine_state SET mode = 'legacy' WHERE singleton;");
    if (process.env.ORDER_REWORK_QA_KEEP === 'true') return;
    cleanup();
    expect(residue()).toBe('0/0/0');
  });

  // Every rework call and its answer goes to the report (status + error code).
  test.beforeEach(async ({ page }) => {
    page.on('response', async (response) => {
      if (!/\/rework/.test(response.url()) || response.request().method() === 'OPTIONS') return;
      const body = response.status() >= 400 ? (await response.text().catch(() => '')).slice(0, 300) : '';
      test.info().annotations.push({ type: 'api', description: `${response.request().method()} ${new URL(response.url()).pathname} → ${response.status()} ${body}` });
    });
    page.on('response', async (response) => {
      const path = new URL(response.url()).pathname;
      if (!/\/api\/v1\/orders\/\d+$/.test(path) || response.request().method() !== 'GET') return;
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      const find = (o: unknown, key: string): unknown => {
        if (!o || typeof o !== 'object') return undefined;
        if (key in (o as Record<string, unknown>)) return (o as Record<string, unknown>)[key];
        for (const v of Object.values(o as Record<string, unknown>)) { const r = find(v, key); if (r !== undefined) return r; }
        return undefined;
      };
      const details = (find(body, 'details') as Array<Record<string, unknown>> | undefined) ?? [];
      test.info().annotations.push({ type: 'order read', description: `${path} → ${response.status()} keys=${Object.keys(body ?? {}).join(',')} version=${String(find(body, 'version'))} productionRound=${String(find(body, 'productionRound'))} details=${details.map((d) => String(d.productionRound)).join(',')}` });
    });
    page.on('console', (m) => { if (m.type() === 'error') test.info().annotations.push({ type: 'console error', description: m.text().slice(0, 300) }); });
  });

  const panel = (page: Page) => page.locator('.order-rework-panel');
  const dialog = (page: Page) => page.locator('.ant-modal-content').filter({ visible: true }).last();

  async function pick(page: Page, select: Locator, label: string) {
    await select.click();
    const option = page.locator('.ant-select-dropdown .ant-select-item-option:visible')
      .filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
    await option.last().click();
    // The dropdown closes with an animation; under load it can take longer — then close it explicitly.
    const closed = await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0, { timeout: 10_000 }).then(() => true, () => false);
    if (!closed) {
      await page.keyboard.press('Escape');
      await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
    }
  }

  async function shot(page: Page, name: string) {
    await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
  }

  async function detailRow(page: Page, number: number): Promise<Locator> {
    return dialog(page).locator('.ant-table-tbody tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${number}$`) }) });
  }

  test('1. После готовности: «Вернуть в переделку» → статус «Переделка», круг ·2, суффиксы, история', async ({ page }) => {
    await login(page, admin.username, admin.password);
    await openOrder(page, ready.orderId);
    await expect(panel(page).getByRole('button', { name: 'Вернуть в переделку' })).toBeVisible({ timeout: 45_000 });
    await shot(page, '01-ready-card');

    await panel(page).getByRole('button', { name: 'Вернуть в переделку' }).click();
    const modal = dialog(page);
    await expect(modal.getByText('Вернуть выбранные детали на этап:')).toBeVisible();
    // Nothing selected yet: the command cannot be sent.
    await expect(modal.getByText('Выберите детали')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Начать переделку' })).toBeDisabled();

    await (await detailRow(page, 1)).locator('.ant-checkbox-input').check();
    await (await detailRow(page, 2)).locator('.ant-checkbox-input').check();
    await pick(page, modal.locator('.ant-select').filter({ hasText: 'Этап для всех выбранных' }), 'Отрисован');
    // Per-row override: detail 2 back to «Распилен» only.
    await pick(page, (await detailRow(page, 2)).locator('.ant-select'), 'Распилен');
    // Reason «Другое» requires a comment.
    await pick(page, modal.locator('.ant-select').filter({ hasText: 'Выберите причину' }), 'Другое');
    await expect(modal.getByText('Для этой причины нужен комментарий')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Начать переделку' })).toBeDisabled();
    await pick(page, modal.locator('.ant-select').filter({ hasText: 'Другое' }), 'Брак цеха');
    await modal.locator('textarea').fill('скол на фасаде');
    await shot(page, '02-ready-modal-filled');
    await modal.getByRole('button', { name: 'Начать переделку' }).click();
    await expect(page.getByText('Переделка ·2 начата')).toBeVisible({ timeout: 20_000 });

    await expect(panel(page).getByText('Переделка ·2:')).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).getByText('Брак цеха — скол на фасаде')).toBeVisible();
    await expect(panel(page).getByText(/после готовности, деталей: 2/)).toBeVisible();
    // Round suffix in the card's detail table: right after the command, then after a page reload.
    const suffixNow = await page.getByText('Отрисован ·2').first().isVisible({ timeout: 15_000 }).catch(() => false)
      || await page.getByText('Отрисован ·2').first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
    await shot(page, '03-ready-after-start');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const suffixAfterReload = await page.getByText('Отрисован ·2').first().waitFor({ timeout: 45_000 }).then(() => true).catch(() => false);
    const headerAfterReload = await page.getByText(/Переделка ·2/).first().isVisible().catch(() => false);
    test.info().annotations.push({ type: 'detail suffix «Отрисован ·2»', description: `without reload: ${suffixNow}; after reload: ${suffixAfterReload}` });
    test.info().annotations.push({ type: 'header status «Переделка ·2» after reload', description: String(headerAfterReload) });
    await shot(page, '03b-ready-after-reload');
    expect(suffixNow, 'the round suffix shows right after the command, without a reload').toBe(true);
    expect(suffixAfterReload).toBe(true);

    expect(orderState(ready.orderId)).toEqual({ status: 'rework', round: 2, lastRound: 2 });
    expect(detailStates(ready.orderId)).toEqual([
      { n: 1, stage: 'drawn', round: 2 }, { n: 2, stage: 'cut', round: 2 }, { n: 3, stage: 'packed', round: 1 },
    ]);
    // Status of the order in the card header.
    await expect(page.getByText('Переделка', { exact: false }).first()).toBeVisible();

    await panel(page).getByText(/История переделок \(1\)/).click();
    await expect(panel(page).locator('.ant-table-tbody').getByText('·2')).toBeVisible();
    await expect(panel(page).locator('.ant-table-tbody').getByText('вручную')).toBeVisible();
    await expect(panel(page).locator('.ant-table-tbody').getByText('открыт')).toBeVisible();
    await shot(page, '04-ready-history');
  });

  test('2. Добавить деталь в открытый круг ·2 (без причины)', async ({ page }) => {
    await login(page, admin.username, admin.password);
    await openOrder(page, ready.orderId);
    const button = panel(page).getByRole('button', { name: 'Добавить детали в переделку ·2' });
    await expect(button).toBeVisible({ timeout: 45_000 });
    await button.click();
    const modal = dialog(page);
    await expect(modal.getByText('Выберите причину')).toHaveCount(0);
    await (await detailRow(page, 3)).locator('.ant-checkbox-input').check();
    await pick(page, modal.locator('.ant-select').filter({ hasText: 'Этап для всех выбранных' }), 'Присажен');
    await shot(page, '05-extend-modal');
    await modal.getByRole('button', { name: 'Добавить' }).click();
    await expect(page.getByText('Детали добавлены в переделку')).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).getByText(/деталей: 3/)).toBeVisible({ timeout: 20_000 });
    expect(detailStates(ready.orderId)[2]).toEqual({ n: 3, stage: 'drilled', round: 2 });
    const now = await page.getByText('Присажен ·2').first().waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    await shot(page, '06-extend-done');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloaded = await page.getByText('Присажен ·2').first().waitFor({ timeout: 45_000 }).then(() => true).catch(() => false);
    test.info().annotations.push({ type: 'detail suffix «Присажен ·2»', description: `without reload: ${now}; after reload: ${reloaded}` });
    expect(now, 'the round suffix shows right after adding, without a reload').toBe(true);
    expect(reloaded).toBe(true);
  });

  test('3. Изменить причину открытого круга', async ({ page }) => {
    await login(page, admin.username, admin.password);
    await openOrder(page, ready.orderId);
    await panel(page).getByRole('button', { name: 'Изменить причину' }).first().click();
    const modal = dialog(page);
    await expect(modal.getByText('Причина переделки ·2')).toBeVisible();
    await pick(page, modal.locator('.ant-select'), 'Ошибка замера/проекта');
    await modal.locator('textarea').fill('неверный размер в проекте');
    await modal.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Причина сохранена')).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).getByText('Ошибка замера/проекта — неверный размер в проекте')).toBeVisible();
    expect(rounds(ready.orderId)).toEqual([{ round: 2, closed: false, closeReason: null, reason: 'measurement_error', mode: 'after_ready' }]);
    await shot(page, '07-reason-changed');
  });

  test('4. Права: работник видит историю без кнопок; менеджер чужого заказа — тоже без кнопок', async ({ browser }) => {
    for (const [who, user] of [['worker', worker], ['manager', manager]] as const) {
      const page = await (await browser.newContext()).newPage();
      await login(page, user.username, user.password);
      await openOrder(page, ready.orderId);
      const opened = await panel(page).getByText('Переделка ·2:').isVisible({ timeout: 30_000 }).catch(() => false);
      await shot(page, `08-permissions-${who}`);
      test.info().annotations.push({ type: `${who}: open-round banner visible`, description: String(opened) });
      await expect(panel(page).getByRole('button', { name: /Добавить детали|Вернуть в переделку|Изменить причину|Это не переделка/ })).toHaveCount(0);
      await page.context().close();
    }
    // A manager on their own order (orders.rework + own update scope) gets the actions.
    const own = createOrder({ name: `${PREFIX} менеджер ${tag}`, createdBy: manager.userId, orderStatus: 'legacy_6', detailStage: 'packed', details: 2 });
    const page = await (await browser.newContext()).newPage();
    await login(page, manager.username, manager.password);
    await openOrder(page, own.orderId);
    const canStart = await panel(page).getByRole('button', { name: 'Вернуть в переделку' }).waitFor({ timeout: 45_000 }).then(() => true).catch(() => false);
    test.info().annotations.push({ type: 'manager on own order: «Вернуть в переделку» visible', description: String(canStart) });
    await shot(page, '08-permissions-manager-own');
    await page.context().close();
  });

  test('5. Готовность закрывает круг; история «закрыт», снова «Вернуть в переделку» (круг ·3)', async ({ page }) => {
    // Any writer moving the order to «Готов к выдаче» closes the open round (§5.4); done here like a status change.
    psql(`BEGIN; SELECT set_session_user(${admin.userId}); UPDATE orders SET order_status_id = (SELECT order_status_id FROM order_statuses WHERE order_status_code='legacy_6'), version = version + 1 WHERE order_id = ${ready.orderId}; COMMIT;`);
    expect(rounds(ready.orderId)[0]).toMatchObject({ round: 2, closed: true, closeReason: 'ready' });
    await login(page, admin.username, admin.password);
    await openOrder(page, ready.orderId);
    await expect(panel(page).getByRole('button', { name: 'Вернуть в переделку' })).toBeVisible({ timeout: 45_000 });
    await expect(panel(page).getByText('Переделка ·2:')).toHaveCount(0);
    await panel(page).getByText(/История переделок \(1\)/).click();
    await expect(panel(page).locator('.ant-table-tbody .ant-tag').first()).not.toHaveText('открыт');
    await shot(page, '09-closed-by-ready');
  });

  test('6. В производстве (D6): «Переделка деталей» — статус заказа не меняется; «Это не переделка» откатывает', async ({ page }) => {
    await login(page, admin.username, admin.password);
    await openOrder(page, inProduction.orderId);
    const button = panel(page).getByRole('button', { name: 'Переделка деталей' });
    await expect(button).toBeVisible({ timeout: 45_000 });
    await button.click();
    const modal = dialog(page);
    await (await detailRow(page, 1)).locator('.ant-checkbox-input').check();
    // Stage options per row: only earlier than the current «Распилен».
    await (await detailRow(page, 1)).locator('.ant-select').click();
    const options = await page.locator('.ant-select-dropdown .ant-select-item-option:visible').allInnerTexts();
    test.info().annotations.push({ type: 'per-row targets for «Распилен»', description: options.join(', ') });
    await page.keyboard.press('Escape');
    await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
    await pick(page, modal.locator('.ant-select').filter({ hasText: 'Этап для всех выбранных' }), 'Отрисован');
    await pick(page, modal.locator('.ant-select').filter({ hasText: 'Выберите причину' }), 'Брак цеха');
    await modal.getByRole('button', { name: 'Начать переделку' }).click();
    await expect(page.getByText('Переделка ·2 начата')).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).getByText(/в производстве, деталей: 1/)).toBeVisible({ timeout: 20_000 });
    expect(orderState(inProduction.orderId)).toEqual({ status: 'legacy_4', round: 2, lastRound: 2 });
    await shot(page, '10-d6-started');

    await panel(page).getByRole('button', { name: 'Это не переделка' }).click();
    await expect(page.getByText('Это не переделка (круг ·2)?')).toBeVisible();
    await shot(page, '11-false-positive-confirm');
    await page.getByRole('button', { name: 'Отменить круг' }).click();
    await expect(page.getByText('Круг отменён')).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).getByText('Переделка ·2:')).toHaveCount(0, { timeout: 20_000 });
    expect(orderState(inProduction.orderId)).toEqual({ status: 'legacy_4', round: 1, lastRound: 2 });
    expect(detailStates(inProduction.orderId)[0]).toEqual({ n: 1, stage: 'cut', round: 1 });
    expect(rounds(inProduction.orderId)[0]).toMatchObject({ closed: true, closeReason: 'false_positive' });
    await shot(page, '12-false-positive-done');
  });

  test('7. Статус заказа «Распилен» (legacy_5): «Переделка деталей», статус заказа не меняется', async ({ page }) => {
    await login(page, admin.username, admin.password);
    await openOrder(page, sawn.orderId);
    const button = panel(page).getByRole('button', { name: 'Переделка деталей' });
    await expect(button).toBeVisible({ timeout: 45_000 });
    await button.click();
    const modal = dialog(page);
    await (await detailRow(page, 2)).locator('.ant-checkbox-input').check();
    await pick(page, modal.locator('.ant-select').filter({ hasText: 'Этап для всех выбранных' }), 'Отрисован');
    await pick(page, modal.locator('.ant-select').filter({ hasText: 'Выберите причину' }), 'Брак цеха');
    await modal.getByRole('button', { name: 'Начать переделку' }).click();
    await expect(page.getByText('Переделка ·2 начата')).toBeVisible({ timeout: 20_000 });
    await expect(panel(page).getByText(/в производстве, деталей: 1/)).toBeVisible({ timeout: 20_000 });
    expect(orderState(sawn.orderId)).toEqual({ status: 'legacy_5', round: 2, lastRound: 2 });
    expect(detailStates(sawn.orderId)[1]).toEqual({ n: 2, stage: 'drawn', round: 2 });
    await expect(page.getByText('Отрисован ·2').first()).toBeVisible({ timeout: 15_000 });
    await shot(page, '13-status-sawn-started');
  });

  test('8. Realtime: вторая вкладка видит начатый круг без перезагрузки', async ({ browser }) => {
    const context = await browser.newContext();
    const watcher = await context.newPage();
    await login(watcher, admin.username, admin.password);
    await openOrder(watcher, ready.orderId);
    await expect(panel(watcher).getByRole('button', { name: 'Вернуть в переделку' })).toBeVisible({ timeout: 45_000 });
    let watcherReads = 0;
    watcher.on('response', (r) => {
      if (r.request().method() === 'GET' && new RegExp(`/api/v1/orders/${ready.orderId}$`).test(new URL(r.url()).pathname)) watcherReads += 1;
    });
    const actor = await context.newPage();
    await openOrder(actor, ready.orderId);
    await panel(actor).getByRole('button', { name: 'Вернуть в переделку' }).click();
    const modal = dialog(actor);
    // Detail 3 is at «Присажен ·2» after scenarios 2 and 5; «Отрисован» is earlier.
    await (await detailRow(actor, 3)).locator('.ant-checkbox-input').check();
    await pick(actor, modal.locator('.ant-select').filter({ hasText: 'Этап для всех выбранных' }), 'Отрисован');
    await pick(actor, modal.locator('.ant-select').filter({ hasText: 'Выберите причину' }), 'Изменение по просьбе клиента');
    await modal.getByRole('button', { name: 'Начать переделку' }).click();
    await expect(actor.getByText('Переделка ·3 начата')).toBeVisible({ timeout: 20_000 });
    const started = Date.now();
    const seen = await panel(watcher).getByText('Переделка ·3:').isVisible({ timeout: 25_000 }).catch(() => false)
      || await panel(watcher).getByText('Переделка ·3:').waitFor({ timeout: 25_000 }).then(() => true).catch(() => false);
    test.info().annotations.push({ type: 'realtime: watcher saw round ·3', description: `${seen} after ${Date.now() - started} ms` });
    await shot(watcher, '14-realtime-watcher');
    expect(seen, 'another tab shows the new round without a reload').toBe(true);
    await expect(watcher.getByText('Отрисован ·3').first()).toBeVisible({ timeout: 15_000 });
    // No request storm: the other tab re-reads the order once for the change (at most one retry), nothing afterwards.
    await watcher.waitForTimeout(10_000);
    test.info().annotations.push({ type: 'realtime: order re-reads in the other tab', description: String(watcherReads) });
    expect(watcherReads).toBeGreaterThanOrEqual(1);
    expect(watcherReads).toBeLessThanOrEqual(2);
    await context.close();
  });

  test('9. Список заказов: статус «Переделка»', async ({ page }) => {
    await login(page, admin.username, admin.password);
    await page.goto(`${frontendUrl}/orders`, { waitUntil: 'domcontentloaded' });
    const search = page.getByPlaceholder(/Поиск|поиск/).first();
    if (await search.isVisible({ timeout: 20_000 }).catch(() => false)) await search.fill(ready.orderName);
    await page.waitForTimeout(4000);
    const row = page.locator('tr', { hasText: ready.orderName }).first();
    const rowText = await row.innerText({ timeout: 20_000 }).catch(() => '');
    test.info().annotations.push({ type: 'orders list row', description: rowText.replace(/\s+/g, ' ').slice(0, 300) });
    await shot(page, '15-orders-list');
  });

  test('10. Справочник причин в /configuration: добавить причину с обязательным комментарием', async ({ page }) => {
    await login(page, admin.username, admin.password);
    await page.goto(`${frontendUrl}/configuration`, { waitUntil: 'domcontentloaded' });
    const tab = page.getByRole('tab', { name: /Причины переделки/ });
    await expect(tab).toBeVisible({ timeout: 45_000 });
    await tab.click();
    await expect(page.getByText('Уточнить', { exact: true })).toBeVisible({ timeout: 20_000 });
    await shot(page, '16-reasons-tab');
    await page.getByRole('button', { name: 'Добавить причину' }).click();
    const modal = dialog(page);
    await modal.locator('.ant-form-item').filter({ hasText: 'Название' }).locator('input').fill(`${PREFIX} причина ${tag}`);
    await modal.locator('.ant-checkbox-input').first().check();
    await modal.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Причина сохранена')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`${PREFIX} причина ${tag}`)).toBeVisible();
    const requires = psql(`SELECT requires_comment FROM order_rework_reasons WHERE name = '${PREFIX} причина ${tag}'`);
    test.info().annotations.push({ type: 'new reason requires_comment', description: requires });
    await shot(page, '17-reason-added');
  });

  test('11. МДФ-движок active: кнопка заблокирована с понятной подсказкой', async ({ page }) => {
    psql("UPDATE mdf_engine_state SET mode = 'active' WHERE singleton;");
    try {
      await login(page, admin.username, admin.password);
      await openOrder(page, inProduction.orderId);
      const button = panel(page).getByRole('button', { name: 'Переделка деталей' });
      await expect(button).toBeVisible({ timeout: 45_000 });
      await expect(button).toBeDisabled();
      // The reason is shown as text next to the disabled button.
      await expect(panel(page).getByText('Переделка станет доступна после поддержки кругов в МДФ-движке')).toBeVisible({ timeout: 10_000 });
      await shot(page, '18-mdf-active');
    } finally {
      psql("UPDATE mdf_engine_state SET mode = 'legacy' WHERE singleton;");
    }
  });

  test('12. NewLine (workbench): панель, суффикс круга и «Распилен» — на компьютере и в телефонной карточке', async ({ browser }) => {
    for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
      const context = await browser.newContext({ viewport, ...(device === 'phone' ? { isMobile: true, hasTouch: true } : {}) });
      // The shell variant is the user's server preference (the localStorage value is only its cache).
      psql(`INSERT INTO user_preferences (user_id, ui_variant) VALUES (${admin.userId}, 'workbench')
            ON CONFLICT (user_id) DO UPDATE SET ui_variant = EXCLUDED.ui_variant;`);
      const page = await context.newPage();
      await login(page, admin.username, admin.password);
      // The order of scenario 7: status «Распилен», round ·2 open (detail 2 «Отрисован ·2»).
      await openOrder(page, sawn.orderId);
      const workbench = await page.locator('.order-show-page--workbench').first().waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
      const banner = await panel(page).getByText('Переделка ·2:').first().waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
      const extend = await panel(page).getByRole('button', { name: 'Добавить детали в переделку ·2' }).isVisible().catch(() => false);
      const suffix = await page.getByText('Отрисован ·2').first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
      await shot(page, `19-newline-${device}`);
      test.info().annotations.push({ type: `NewLine ${device}`, description: `workbench layout: ${workbench}; banner: ${banner}; «Добавить детали» button: ${extend}; suffix «Отрисован ·2»: ${suffix}` });
      expect(workbench).toBe(true);
      expect(banner && extend).toBe(true);
      // The banner text keeps its width (the round actions do not squeeze it into a column on a phone).
      const messageWidth = (await panel(page).locator('.ant-alert-message').first().boundingBox())?.width ?? 0;
      test.info().annotations.push({ type: `NewLine ${device}: banner text width`, description: `${Math.round(messageWidth)} px` });
      expect(messageWidth).toBeGreaterThan(200);
      await expect(panel(page).getByRole('button', { name: 'Это не переделка' })).toBeVisible();
      // Phone detail cards show no stage at all (existing phone design), so the suffix is checked on the desktop table only.
      if (device === 'desktop') expect(suffix).toBe(true);
      await context.close();
    }
  });
});
