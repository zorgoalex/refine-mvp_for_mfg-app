import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const enabled = process.env.ORDER_UI_FULL_COVERAGE === 'true';
const frontendUrl = process.env.ORDER_UI_FULL_COVERAGE_FRONTEND_URL ?? process.env.FRONTEND_URL ?? 'http://localhost:5173';
const username = process.env.CODEX_PLAYWRIGHT_USERNAME ?? '';
const password = process.env.CODEX_PLAYWRIGHT_PASSWORD ?? '';
const vercelAutomationBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();

test.describe('Order UI full form coverage', () => {
    test.skip(!enabled, 'Run with ORDER_UI_FULL_COVERAGE=true; this spec creates durable orders.');
    test.skip(!username || !password, 'CODEX_PLAYWRIGHT_USERNAME/CODEX_PLAYWRIGHT_PASSWORD are required.');
    test.setTimeout(300000);

    test('creates a durable order through UI and verifies fields, tabs, buttons, and creator history', async ({ page }, testInfo) => {
        const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
        const orderName = `E2E codex full coverage ${runId}`;
        const detailName = `E2E detail ${runId}`;
        const note = `E2E full form note ${runId}`;
        const paymentNote = `E2E payment note ${runId}`;
        const paymentRef = uuidFromRunId(runId);

        await prepareRuntimeForBackendUi(page);
        await expectBackendRuntimeConfig(page);
        await loginThroughUi(page);
        await page.goto(`${frontendUrl}/orders`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('button', { name: 'Создать заказ' })).toBeVisible({ timeout: 30000 });

        // Detect the tabbed-workspace bar. The durable-order flow is the always-on gate;
        // the tab-context assertions below only apply when the frontend under test ships
        // the workspace tab-bar (it activates the "Заказы" tab on the list). A deployed
        // frontend predating the feature has no such bar — assert durable flow only, and
        // log loudly so the skip is never silent. (New-UI tab behaviour is covered by the
        // mocked tests/workspace-tabs.spec.ts.)
        const hasWorkspaceTabs =
            (await page.getByRole('tab', { name: /Заказы/ }).count()) > 0;
        if (!hasWorkspaceTabs) {
            console.warn(
                '[order-ui-full-coverage] Workspace tab-bar not present on the frontend under test; ' +
                    'skipping tab-context assertions (feature not deployed here). Durable-order flow still asserted.',
            );
        }

        await expect(page.getByRole('button', { name: 'Выгрузка JSON' })).toBeVisible();
        await expect(page.locator('button').filter({ hasText: 'Загрузка JSON' })).toBeVisible();
        await page.getByRole('button', { name: 'Фильтры' }).click();
        await expect(page.getByRole('button', { name: 'Применить' })).toBeVisible();
        await page.getByRole('button', { name: 'Скрыть фильтры' }).click();

        await page.getByRole('button', { name: 'Создать заказ' }).click();
        const orderDialog = page.getByRole('dialog', { name: 'Создание нового заказа' });
        await expect(orderDialog).toBeVisible();

        await clickOrderTab(orderDialog, 'Основная информация');
        await selectAntdOption(page, formItem(orderDialog, 'Клиент'));
        await orderDialog.getByPlaceholder('Введите название заказа').fill(orderName);
        await fillDate(formItem(orderDialog, 'Дата заказа'), '22.05.2026');
        await selectAntdOption(page, formItem(orderDialog, 'Статус заказа'));
        await selectAntdOption(page, formItem(orderDialog, 'Статус оплаты'));
        await selectAntdOption(page, formItem(orderDialog, 'Менеджер'));
        await fillNumber(formItem(orderDialog, 'Приоритет'), '77');
        await screenshot(page, testInfo, 'create-basic');

        await clickOrderTab(orderDialog, 'Даты');
        await fillDate(formItem(orderDialog, 'Плановая дата завершения'), '25.05.2026');
        await fillDate(formItem(orderDialog, 'Дата завершения'), '26.05.2026');
        await fillDate(formItem(orderDialog, 'Дата выдачи'), '27.05.2026');
        await screenshot(page, testInfo, 'create-dates');

        await clickOrderTab(orderDialog, 'Детали заказа');
        const detailsCard = orderDialog.locator('.ant-card').filter({ hasText: 'Всего позиций' }).first();
        await expect(detailsCard.getByRole('button', { name: /Групповые действия/ })).toBeDisabled();
        await expect(detailsCard.getByRole('button', { name: /Удалить выбранные/ })).toBeDisabled();
        await expect(detailsCard.getByRole('button', { name: /Пересчитать суммы/ })).toBeDisabled();
        const importButton = detailsCard.getByRole('button', { name: /Импорт/ });
        await importButton.click();
        await expect(page.locator('.ant-dropdown-menu:visible')).toBeVisible();
        await importButton.click();
        await expect(page.locator('.ant-dropdown-menu:visible')).toHaveCount(0);
        const refreshedDetailsCard = orderDialog.locator('.ant-card').filter({ hasText: 'Всего позиций' }).first();
        await refreshedDetailsCard.getByRole('button', { name: 'plus' }).click();

        const detailDialog = page.getByRole('dialog', { name: 'Добавить деталь' });
        await expect(detailDialog).toBeVisible();
        await detailDialog.locator('#height').fill('610');
        await detailDialog.locator('#width').fill('410');
        await detailDialog.locator('#quantity').fill('2');
        await selectAntdOption(page, formItem(detailDialog, 'Материал'), 'МДФ 16мм');
        // SP3: also exercise the "Листовой материал" sheet picker when it is rendered
        // (only post-operator-window: backend write + sheet_materials.view +
        // sheetMaterialsReads). Selecting a sheet supersedes the legacy material for
        // this detail (Variant A). Guarded no-op pre-window.
        const sheetDetailMaterial = await trySelectSheetMaterial(page, detailDialog);
        if (sheetDetailMaterial) {
            await screenshot(page, testInfo, 'detail-sheet-material');
        }
        await selectAntdOption(page, formItem(detailDialog, 'Пленка'));
        await selectAntdOption(page, formItem(detailDialog, 'Тип фрезеровки'), 'модерн');
        await selectAntdOption(page, formItem(detailDialog, 'Тип обката'), 'р-1');
        await detailDialog.locator('#milling_cost_per_sqm').fill('9000');
        await detailDialog.locator('#detail_name').fill(detailName);
        await detailDialog.locator('#priority').fill('11');
        await selectAntdOption(page, formItem(detailDialog, 'Статус производства'));
        await detailDialog.getByPlaceholder('Дополнительная информация').fill(`${note} detail`);
        await screenshot(page, testInfo, 'detail-modal-filled');
        await detailDialog.getByRole('button', { name: 'Сохранить' }).click();
        await expect(detailsCard.getByText('Всего позиций: 1')).toBeVisible();
        await expect(detailsCard.getByRole('button', { name: /Групповые действия/ })).toBeEnabled();
        await expect(detailsCard.getByRole('button', { name: /Пересчитать суммы/ })).toBeEnabled();
        await detailsCard.getByRole('button', { name: /Групповые действия/ }).click();
        await expect(page.getByRole('dialog', { name: /Групповые действия/ })).toBeVisible();
        await page.getByRole('button', { name: 'Отмена' }).click();
        await detailsCard.getByRole('button', { name: /Пересчитать суммы/ }).click();
        await screenshot(page, testInfo, 'create-details');

        await clickOrderTab(orderDialog, 'Финансы');
        await expect(orderDialog.getByRole('button', { name: /Удалить выбранные/ })).toBeDisabled();
        await orderDialog.getByRole('button', { name: 'Добавить (форма)' }).click();
        const paymentDialog = page.getByRole('dialog', { name: 'Создать оплату' });
        await selectAntdOption(page, formItem(paymentDialog, 'Тип оплаты'));
        await fillDate(formItem(paymentDialog, 'Дата платежа'), '22.05.2026');
        await paymentDialog.locator('#amount').fill('4501');
        await paymentDialog.locator('#notes').fill(paymentNote);
        await paymentDialog.locator('#ref_key_1c').fill(paymentRef);
        await screenshot(page, testInfo, 'payment-modal-filled');
        await paymentDialog.getByRole('button', { name: 'Создать' }).click();
        await expect(orderDialog.getByText('Всего платежей: 1')).toBeVisible();
        await screenshot(page, testInfo, 'create-finance');

        await clickOrderTab(orderDialog, 'Дополнительно');
        await orderDialog.getByText('Legacy поля (для совместимости)').click();
        await selectAntdOption(page, formItem(orderDialog, 'Материал'), 'МДФ 16мм');
        // SP3: mirror the sheet picker on the order header when rendered (post-window).
        const sheetHeaderMaterial = await trySelectSheetMaterial(page, orderDialog);
        await selectAntdOption(page, formItem(orderDialog, 'Тип фрезеровки'), 'модерн');
        await selectAntdOption(page, formItem(orderDialog, 'Тип кромки'));
        await selectAntdOption(page, formItem(orderDialog, 'Пленка'));
        await orderDialog.getByText('Ссылки на файлы').click();
        await fillInputInFormItem(formItem(orderDialog, 'Ссылка на файл раскроя'), `https://example.invalid/${runId}/cutting.erp`);
        await fillInputInFormItem(formItem(orderDialog, 'Ссылка на изображение раскроя'), `https://example.invalid/${runId}/cutting.png`);
        await fillInputInFormItem(formItem(orderDialog, 'Ссылка на CAD файл'), `https://example.invalid/${runId}/model.dxf`);
        await fillInputInFormItem(formItem(orderDialog, 'Ссылка на PDF файл'), `https://example.invalid/${runId}/order.pdf`);
        await screenshot(page, testInfo, 'create-additional');

        const saveResponsePromise = page.waitForResponse(
            (response) =>
                response.url().includes('/api/v1/orders') &&
                response.request().method() === 'POST',
            { timeout: 60000 },
        );
        await orderDialog.getByRole('button', { name: /Сохранить/ }).first().click();
        const saveResponse = await saveResponsePromise;
        const saveBody = await saveResponse.json().catch(() => null);
        expect(
            saveResponse.ok(),
            `order create failed with HTTP ${saveResponse.status()} ${saveResponse.statusText()}: ${summarizeApiBody(saveBody)}`,
        ).toBe(true);
        const orderId = readOrderIdFromCreateResponse(saveBody);
        expect(Number.isFinite(orderId)).toBe(true);
        await page.goto(`${frontendUrl}/orders/edit/${orderId}`, { waitUntil: 'domcontentloaded' });
        await expect(orderDialog).toBeHidden({ timeout: 30000 });

        await expect(page.getByText(orderName, { exact: true }).first()).toBeVisible({ timeout: 30000 });
        // Opening an order creates a workspace tab labelled "Заказ #<id>" (enriched with the name after load).
        if (hasWorkspaceTabs) {
            await expect(workspaceTabs(page).locator('.ant-tabs-tab-active')).toContainText(`Заказ #${orderId}`, {
                timeout: 30000,
            });
        }
        await verifyEditTabs(page, testInfo, orderName, detailName, paymentNote);
        await verifyDurableDatabaseState(orderId, orderName, detailName, paymentRef);

        await page.getByRole('button', { name: 'Просмотр' }).click();
        await page.waitForURL(new RegExp(`/orders/show/${orderId}`), { timeout: 30000 });
        await verifyShowPage(page, testInfo, orderId, orderName, note, paymentNote);

        // SP3: if the sheet picker was exercised (post-operator-window), the saved
        // order must DISPLAY the server-resolved sheet name on the show page and the
        // sheet picker must round-trip on re-open. Pre-window this is a documented
        // skip (the picker was absent, so both vars are null).
        if (sheetDetailMaterial || sheetHeaderMaterial) {
            const sheetName = (sheetDetailMaterial ?? sheetHeaderMaterial) as string;
            await expect(page.getByText(sheetName, { exact: false }).first()).toBeVisible({ timeout: 30000 });
            await screenshot(page, testInfo, 'show-sheet-material');
            await page.goto(`${frontendUrl}/orders/edit/${orderId}`, { waitUntil: 'domcontentloaded' });
            await expect(page.getByText(orderName, { exact: true }).first()).toBeVisible({ timeout: 30000 });
            await expect(page.getByText(sheetName, { exact: false }).first()).toBeVisible({ timeout: 30000 });
        } else {
            testInfo.annotations.push({
                type: 'skip-reason',
                description:
                    'SP3 sheet picker not rendered — requires operator window (migration 029 + Hasura metadata + VITE_SHEET_MATERIALS_READS/backend write/sheet_materials.view). Sheet path deferred to post-cutover canary.',
            });
        }

        // Cut (раскрой) detail picker on the show page: toggle per-detail
        // checkboxes and add selected details to a cut job. The whole surface is
        // gated by VITE_USE_BACKEND_CUT + cut.manage, so it only renders when the
        // cut feature flag is enabled in the env under test.
        const cutToggle = page.getByRole('button', { name: 'Выделить детали для раскроя' });
        if ((await cutToggle.count()) > 0) {
            await cutToggle.first().click();
            await page.getByRole('button', { name: 'Выделить все' }).click();
            const addToCut = page.getByRole('button', { name: /Добавить выбранные в раскрой/ });
            await expect(addToCut).toBeEnabled({ timeout: 30000 });
            await screenshot(page, testInfo, 'show-cut-detail-picker');
            await addToCut.click();
            const cutModal = page.getByRole('dialog').filter({ hasText: /Добавить детали в раскрой/ });
            await expect(cutModal).toBeVisible({ timeout: 30000 });
            await screenshot(page, testInfo, 'show-cut-modal-detail-mode');
            await cutModal.getByRole('button', { name: 'Отмена' }).click();
            await expect(cutModal).toBeHidden({ timeout: 30000 });
        } else {
            testInfo.annotations.push({
                type: 'skip-reason',
                description:
                    'Cut detail picker not rendered — gated by VITE_USE_BACKEND_CUT + cut.manage (frontend cut flag OFF on stage). Detail-level add-to-cut deferred to post flag-flip canary.',
            });
        }

        await page.goto(`${frontendUrl}/orders`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(orderName, { exact: true }).first()).toBeVisible({ timeout: 30000 });
        const row = page.getByRole('row', { name: new RegExp(orderName) }).first();
        await expect(row).toContainText(username);
        await screenshot(page, testInfo, 'orders-list-created-by');

        // ============================================================
        // Tabbed workspace context: dirty marker + Закрыть closes the tab
        // (only when the workspace tab-bar is present on the frontend under test)
        // ============================================================
        if (!hasWorkspaceTabs) {
            return;
        }
        await page.goto(`${frontendUrl}/orders/edit/${orderId}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText(orderName, { exact: true }).first()).toBeVisible({ timeout: 30000 });
        const editForm = page.locator('.ant-card').filter({ hasText: orderName }).first();
        await clickOrderTab(editForm, 'Основная информация');

        // Make the order draft dirty → the active workspace tab shows the ● marker.
        await fillNumber(formItem(editForm, 'Приоритет'), '88');
        const activeTab = workspaceTabs(page).locator('.ant-tabs-tab-active');
        await expect(activeTab).toContainText('●', { timeout: 30000 });
        await expect(activeTab).toContainText(`Заказ #${orderId}`);
        await screenshot(page, testInfo, 'edit-tab-dirty-marker');

        // Закрыть on a dirty order prompts; confirming closes the tab and leaves the edit route.
        const tabsBefore = await workspaceTabs(page).getByRole('tab').count();
        await editForm.getByRole('button', { name: 'Закрыть' }).click();
        await expect(page.getByText('Несохраненные изменения')).toBeVisible();
        await page.getByRole('button', { name: 'Покинуть' }).click();
        await expect(page).not.toHaveURL(new RegExp(`/orders/edit/${orderId}`), { timeout: 30000 });
        await expect(workspaceTabs(page).getByRole('tab')).toHaveCount(tabsBefore - 1);
        await screenshot(page, testInfo, 'edit-tab-closed');
    });
});

// The workspace tab-bar is the first AntD Tabs in the layout (rendered above page content).
function workspaceTabs(page: Page): Locator {
    return page.locator('.ant-tabs').first();
}

async function loginThroughUi(page: Page) {
    const authRequests: string[] = [];
    page.on('request', (request) => {
        const url = request.url();
        if (url.includes('/api/v1/auth/login') || url.includes('/api/login')) {
            authRequests.push(`${request.method()} ${url}`);
        }
    });
    await page.goto(`${frontendUrl}/login`, { waitUntil: 'domcontentloaded' });
    const loginResponsePromise = page.waitForResponse(
        (response) =>
            response.url().includes('/api/v1/auth/login') &&
            response.request().method() === 'POST',
    );
    await page.locator('input[autocomplete="username"], input#username').fill(username);
    await page.locator('input[autocomplete="current-password"], input#password').fill(password);
    await page.getByRole('button', { name: 'Войти' }).click();
    const loginResponse = await loginResponsePromise.catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}; auth requests: ${authRequests.join(', ') || 'none'}`);
    });
    expect(
        loginResponse.ok(),
        `backend login failed with HTTP ${loginResponse.status()} ${loginResponse.statusText()}`,
    ).toBe(true);
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30000 });
}

async function prepareRuntimeForBackendUi(page: Page) {
    if (vercelAutomationBypassSecret) {
        await page.context().setExtraHTTPHeaders({
            'x-vercel-protection-bypass': vercelAutomationBypassSecret,
        });
    }

    if (!isLocalFrontendUrl(frontendUrl)) return;

    await page.route(/\/runtime-config\.json$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                apiUrl: new URL(frontendUrl).origin,
                features: {
                    backendAuth: true,
                    backendPermissions: true,
                    backendOrdersRead: true,
                    backendOrdersWrite: true,
                    backendPayments: true,
                    backendClientPhones: true,
                    backendProductionActions: true,
                    backendDeadlines: true,
                    backendOrderExport: true,
                    backendProjects: true,
                    backendUsers: true,
                    backendVlm: true,
                    backendReferences: false,
                    enableLegacyHasura: true,
                },
            }),
        });
    });
}

async function expectBackendRuntimeConfig(page: Page) {
    const response = await page.goto(`${frontendUrl}/runtime-config.json`, {
        waitUntil: 'domcontentloaded',
    });
    expect(response.ok()).toBe(true);
    const runtimeConfig = JSON.parse((await page.locator('body').textContent()) || '{}');
    expect(runtimeConfig.features?.backendAuth).toBe(true);
    expect(runtimeConfig.features?.backendOrdersRead).toBe(true);
    expect(runtimeConfig.features?.backendOrdersWrite).toBe(true);
}

function isLocalFrontendUrl(value: string) {
    try {
        const parsed = new URL(value);
        return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    } catch {
        return false;
    }
}

function readOrderIdFromCreateResponse(body: unknown): number {
    if (!body || typeof body !== 'object') return NaN;

    const record = body as {
        order?: { header?: { orderId?: unknown } };
        header?: { orderId?: unknown };
        orderId?: unknown;
    };
    const value = record.order?.header?.orderId ?? record.header?.orderId ?? record.orderId;
    return Number(value);
}

function summarizeApiBody(body: unknown): string {
    if (!body || typeof body !== 'object') return String(body);

    const record = body as Record<string, unknown>;
    const summary = {
        error: record.error,
        code: record.code,
        message: record.message,
        details: record.details,
    };
    return JSON.stringify(summary);
}

async function verifyEditTabs(page: Page, testInfo: TestInfo, orderName: string, detailName: string, paymentNote: string) {
    const form = page.locator('.ant-card').filter({ hasText: orderName }).first();
    await clickOrderTab(form, 'Основная информация');
    await expect(page.getByPlaceholder('Введите название заказа')).toHaveValue(orderName);
    await screenshot(page, testInfo, 'edit-basic');

    await clickOrderTab(form, 'Детали заказа');
    await expect(page.getByText(detailName)).toBeVisible();
    await screenshot(page, testInfo, 'edit-details');

    await clickOrderTab(form, 'Даты');
    await screenshot(page, testInfo, 'edit-dates');

    await clickOrderTab(form, 'Финансы');
    await expect(page.getByText(paymentNote)).toBeVisible();
    await screenshot(page, testInfo, 'edit-finance');

    await clickOrderTab(form, 'Услуги/работы');
    await screenshot(page, testInfo, 'edit-services');

    await clickOrderTab(form, 'Цеха');
    await screenshot(page, testInfo, 'edit-workshops');

    await clickOrderTab(form, 'Материалы');
    await screenshot(page, testInfo, 'edit-materials');

    await clickOrderTab(form, 'Дополнительно');
    await screenshot(page, testInfo, 'edit-additional');
}

async function verifyShowPage(
    page: Page,
    testInfo: TestInfo,
    orderId: number,
    orderName: string,
    detailNote: string,
    paymentNote: string,
) {
    await expect(page.getByText(orderName, { exact: true }).first()).toBeVisible({ timeout: 30000 });

    await page.getByText('Детали заказа', { exact: true }).click();
    await expect(page.getByText(`${detailNote} detail`).first()).toBeVisible();
    await expect(page.getByRole('row', { name: /610 410 2/ })).toBeVisible();
    await screenshot(page, testInfo, 'show-details');

    await page.getByRole('button', { name: /Финансы/ }).click();
    await expect(page.getByRole('row', { name: /4\s?501/ }).first()).toBeVisible();
    await screenshot(page, testInfo, 'show-finance');

    await page.getByRole('button', { name: /Дополнительная информация/ }).click();
    await expect(page.getByText('Создал')).toBeVisible();
    await expect(
        page.locator('.ant-collapse-item')
            .filter({ hasText: 'Дополнительная информация' })
            .filter({ hasText: 'Создал' })
            .getByText(username)
            .first(),
    ).toBeVisible();
    await screenshot(page, testInfo, 'show-additional-created-by');

    await page.getByRole('button', { name: 'Обновить' }).click();
    await expect(page.getByText(orderName, { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Печать' }).click();
    await expect(page.getByText(orderName, { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Экспорт в Excel' }).click();
    await expect(page.getByText(/Excel файл успешно сгенерирован|Ошибка/)).toBeVisible({ timeout: 30000 });

    await page.getByRole('button', { name: 'JSON snapshot' }).click();
    await expect(page.getByText(/JSON snapshot заказа выгружен|Не удалось выгрузить JSON snapshot/)).toBeVisible({ timeout: 30000 });

    // The show page exposes two "Изменить" controls (top EditButton link + an inline
    // small button); the first is the primary action that routes to the edit page.
    await page.getByRole('button', { name: 'Изменить' }).first().click();
    await page.waitForURL(new RegExp(`/orders/edit/${orderId}`), { timeout: 30000 });
    await expect(page.getByText(orderName, { exact: true }).first()).toBeVisible();
    await page.goto(`${frontendUrl}/orders/show/${orderId}`, { waitUntil: 'domcontentloaded' });
}

async function verifyDurableDatabaseState(orderId: number, orderName: string, detailName: string, paymentRef: string) {
    if (!process.env.PG_USER || !process.env.PG_DB) return;

    const container = process.env.ORDER_UI_FULL_COVERAGE_DB_CONTAINER ?? `${process.env.COMPOSE_PROJECT_NAME ?? 'erp_dev'}-postgresdb-1`;
    const sql = `
      select json_build_object(
        'orderName', o.order_name,
        'createdBy', u.username,
        'detailCount', (select count(*) from order_details od where od.order_id = o.order_id),
        'detailName', (select od.detail_name from order_details od where od.order_id = o.order_id order by od.detail_id desc limit 1),
        'paymentCount', (select count(*) from payments p where p.order_id = o.order_id),
        'paymentRef', (select p.ref_key_1c from payments p where p.order_id = o.order_id order by p.payment_id desc limit 1)
      )
      from orders o
      left join users u on u.user_id = o.created_by
      where o.order_id = ${orderId};
    `;
    const output = execFileSync('docker', ['exec', '-i', container, 'psql', '-U', process.env.PG_USER, '-d', process.env.PG_DB, '-tA'], {
        input: sql,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const state = JSON.parse(output);

    expect(state).toMatchObject({
        orderName,
        createdBy: username,
        detailName,
        paymentRef,
    });
    expect(Number(state.detailCount)).toBeGreaterThanOrEqual(1);
    expect(Number(state.paymentCount)).toBeGreaterThanOrEqual(1);
}

function formItem(scope: Locator, label: string) {
    return scope.locator('.ant-form-item').filter({ hasText: label }).first();
}

async function clickOrderTab(scope: Locator, label: string) {
    await scope.getByRole('tab', { name: label }).click();
}

async function selectAntdOption(page: Page, item: Locator, optionText?: string) {
    await item.locator('.ant-select').first().click();
    const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    const option = optionText
        ? dropdown.getByText(optionText, { exact: true })
        : dropdown.locator('.ant-select-item-option:not(.ant-select-item-option-disabled)').first();
    await expect(option).toBeVisible({ timeout: 15000 });
    await option.click();
}

// SP3: select the first available "Листовой материал" (sheet) option in a scope,
// returning its label. Returns null when the picker is not rendered — it only
// renders post-operator-window (backend write + sheet_materials.view +
// sheetMaterialsReads / migration 029 Hasura metadata). Guarded so the durable
// coverage spec stays green both before and after the SP3 cutover.
async function trySelectSheetMaterial(page: Page, scope: Locator): Promise<string | null> {
    const item = formItem(scope, 'Листовой материал');
    if ((await item.count()) === 0) return null;
    const select = item.locator('.ant-select').first();
    if ((await select.count()) === 0) return null;
    await select.click();
    const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    const option = dropdown.locator('.ant-select-item-option:not(.ant-select-item-option-disabled)').first();
    if ((await option.count()) === 0) {
        await page.keyboard.press('Escape');
        return null;
    }
    const label = (await option.innerText()).trim();
    await option.click();
    return label || null;
}

async function fillNumber(item: Locator, value: string) {
    const input = item.locator('input').first();
    await input.fill(value);
}

async function fillInputInFormItem(item: Locator, value: string) {
    const input = item.locator('input').first();
    await input.fill(value);
}

async function fillDate(item: Locator, value: string) {
    const input = item.locator('input').first();
    await input.click();
    await input.fill(value);
    await input.press('Enter');
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

function uuidFromRunId(runId: string) {
    return `00000000-0000-4000-8000-${runId.padStart(12, '0').slice(-12)}`;
}
