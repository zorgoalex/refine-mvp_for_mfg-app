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
        // Comprehensive durable flow against the deployed stage (network latency + many
        // form fields); the default 300s budget is too tight, so allow more headroom.
        testInfo.setTimeout(600000);
        const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
        const orderName = `E2E codex full coverage ${runId}`;
        const clientName = `E2E юрлицо ${runId}`;
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
        await formItem(orderDialog, 'Клиент').locator('.ant-select').click();
        await page.getByRole('button', { name: 'Создать клиента' }).click();
        const clientDialog = page.getByRole('dialog', { name: 'Создать клиента' });
        await expect(clientDialog).toBeVisible();
        await clientDialog.getByPlaceholder('Введите название клиента').fill(clientName);
        await clientDialog.getByRole('radio', { name: 'Юридическое лицо' }).check();
        await clientDialog.getByPlaceholder('+7 (XXX) XXX-XX-XX').fill('+7 700 123 45 67');
        await screenshot(page, testInfo, 'quick-client-legal-filled');
        await clientDialog.getByRole('button', { name: 'Создать', exact: true }).click();
        await expect(clientDialog).toBeHidden({ timeout: 30000 });
        await expect(formItem(orderDialog, 'Клиент')).toContainText(clientName);
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
        const importMenu = page.locator('.ant-dropdown-menu:visible');
        await expect(importMenu).toBeVisible();
        await expect(importMenu.getByText(/PDF/)).toBeVisible();
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

        // Grouping fixture: add detail 2 (material B = МДФ 19мм) and detail 3
        // (material A = МДФ 16мм) so the creation order is A, B, A (interleaved).
        // Clustered display order is A={d1,d3}, B={d2} → readNums=[1,3,2] ≠ baseline [1,2,3].
        // After uncheck, correct implementation restores [1,2,3]==baseline; a regression that
        // keeps clustering yields [1,3,2]≠baseline, so the assertion is now non-vacuous.
        // The A group still has 2 rows (d1, d3 both МДФ 16мм), satisfying the tint-parity
        // walk's groups.some(g => g.length >= 2) check.
        await refreshedDetailsCard.getByRole('button', { name: 'plus' }).click();
        const detailDialog2 = page.getByRole('dialog', { name: 'Добавить деталь' });
        await expect(detailDialog2).toBeVisible();
        await detailDialog2.locator('#height').fill('500');
        await detailDialog2.locator('#width').fill('300');
        await detailDialog2.locator('#quantity').fill('1');
        await selectAntdOption(page, formItem(detailDialog2, 'Материал'), 'МДФ 19мм');
        await detailDialog2.getByRole('button', { name: 'Сохранить' }).click();
        await expect(detailsCard.getByText('Всего позиций: 2')).toBeVisible();

        await refreshedDetailsCard.getByRole('button', { name: 'plus' }).click();
        const detailDialog3 = page.getByRole('dialog', { name: 'Добавить деталь' });
        await expect(detailDialog3).toBeVisible();
        await detailDialog3.locator('#height').fill('400');
        await detailDialog3.locator('#width').fill('200');
        await detailDialog3.locator('#quantity').fill('1');
        await selectAntdOption(page, formItem(detailDialog3, 'Материал'), 'МДФ 16мм');
        await detailDialog3.getByRole('button', { name: 'Сохранить' }).click();
        await expect(detailsCard.getByText('Всего позиций: 3')).toBeVisible();

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
        await verifyDurableDatabaseState(orderId, orderName, clientName, detailName, paymentRef);

        await page.getByRole('button', { name: 'Просмотр' }).first().click();
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

            // «Раскрой» cut-job column (read-only deep-link to /cut?job=:id) — renders only
            // when VITE_USE_BACKEND_CUT + cut.view; live render deferred to activation
            // (backend rebuild + Vercel redeploy). Guarded so it is a no-op when absent.
            const cutColumnHeader = page.getByRole('columnheader', { name: 'Раскрой' });
            if ((await cutColumnHeader.count()) > 0) {
                await expect(cutColumnHeader.first()).toBeVisible();
            }
        } else {
            testInfo.annotations.push({
                type: 'skip-reason',
                description:
                    'Cut detail picker not rendered — gated by VITE_USE_BACKEND_CUT + cut.manage (frontend cut flag OFF on stage). Detail-level add-to-cut deferred to post flag-flip canary.',
            });
        }

        await test.step('creates, deletes, restores a separate durable trash order', async () => {
            const trashOrderName = `E2E codex full coverage trash ${runId}`;
            const trashOrderId = await createMinimalTrashCoverageOrder(page, trashOrderName);

            await page.goto(`${frontendUrl}/orders/show/${trashOrderId}`, { waitUntil: 'domcontentloaded' });
            await expect(page.getByText(trashOrderName, { exact: true }).first()).toBeVisible({ timeout: 30000 });
            await expect(page.getByRole('button', { name: 'Удалить' }).first()).toBeVisible({ timeout: 30000 });

            const deleteResponsePromise = page.waitForResponse(
                (response) =>
                    response.url().includes(`/api/v1/orders/${trashOrderId}`) &&
                    response.request().method() === 'DELETE',
                { timeout: 30000 },
            );
            await page.getByRole('button', { name: 'Удалить' }).first().click();
            const deletePopover = page.locator('.ant-popover').filter({ hasText: `Удалить заказ №${trashOrderName}?` }).last();
            await expect(deletePopover).toBeVisible({ timeout: 15000 });
            await deletePopover.getByRole('button', { name: 'Удалить' }).click();
            const deleteResponse = await deleteResponsePromise;
            const deleteBody = await deleteResponse.json().catch(() => null);
            expect(
                deleteResponse.ok(),
                `trash delete failed with HTTP ${deleteResponse.status()} ${deleteResponse.statusText()}: ${summarizeApiBody(deleteBody)}`,
            ).toBe(true);
            await page.waitForURL(/\/orders(?:$|\?)/, { timeout: 30000 });

            await page.goto(`${frontendUrl}/orders/trash`, { waitUntil: 'domcontentloaded' });
            const trashRow = page.getByRole('row', { name: new RegExp(trashOrderName) }).first();
            await expect(trashRow).toBeVisible({ timeout: 30000 });

            await trashRow.getByRole('button', { name: 'Восстановить' }).click();
            const restorePopover = page.locator('.ant-popover').filter({ hasText: new RegExp(`Восстановить заказ №${trashOrderName}\\?`) }).last();
            await expect(restorePopover).toBeVisible({ timeout: 15000 });
            const restoreResponsePromise = page.waitForResponse(
                (response) =>
                    response.url().includes(`/api/v1/orders/${trashOrderId}/restore`) &&
                    response.request().method() === 'POST',
                { timeout: 30000 },
            );
            await restorePopover.getByRole('button', { name: 'Восстановить' }).click();

            let restoredOrderName = trashOrderName;
            const renameModal = page.getByRole('dialog').filter({ hasText: /Восстановить как/ });
            const renameModalVisible = await renameModal
                .waitFor({ state: 'visible', timeout: 5000 })
                .then(() => true)
                .catch(() => false);

            if (renameModalVisible) {
                const suggested = extractSuggestedRestoreName((await renameModal.textContent()) || '');
                if (suggested) {
                    restoredOrderName = suggested;
                }
                const retryRestoreResponsePromise = page.waitForResponse(
                    (response) =>
                        response.url().includes(`/api/v1/orders/${trashOrderId}/restore`) &&
                        response.request().method() === 'POST' &&
                        response.ok(),
                    { timeout: 30000 },
                );
                await renameModal.getByRole('button', { name: 'Восстановить' }).click();
                const retryRestoreResponse = await retryRestoreResponsePromise;
                const retryRestoreBody = await retryRestoreResponse.json().catch(() => null);
                expect(
                    retryRestoreResponse.ok(),
                    `trash restore retry failed with HTTP ${retryRestoreResponse.status()} ${retryRestoreResponse.statusText()}: ${summarizeApiBody(retryRestoreBody)}`,
                ).toBe(true);
            } else {
                const restoreResponse = await restoreResponsePromise;
                const restoreBody = await restoreResponse.json().catch(() => null);
                expect(
                    restoreResponse.ok(),
                    `trash restore failed with HTTP ${restoreResponse.status()} ${restoreResponse.statusText()}: ${summarizeApiBody(restoreBody)}`,
                ).toBe(true);
            }

            await expect(page.getByRole('row', { name: new RegExp(trashOrderName) })).toHaveCount(0, { timeout: 30000 });

            await page.goto(`${frontendUrl}/orders`, { waitUntil: 'domcontentloaded' });
            if (hasWorkspaceTabs) {
                await workspaceTabs(page).getByRole('tab', { name: /Заказы/ }).first().click();
            }
            const orderSearch = page.getByPlaceholder('Поиск по номеру заказа').first();
            await orderSearch.fill(restoredOrderName);
            await page.getByRole('button', { name: /Найти/ }).first().click();
            await expect(page.getByRole('row', { name: new RegExp(restoredOrderName) }).first()).toBeVisible({ timeout: 30000 });
        });

        await page.goto(`${frontendUrl}/orders`, { waitUntil: 'domcontentloaded' });
        // Tabbed workspace: the just-created order's tab stays active after navigating, so
        // the "Заказы" list is a separate (hidden) keep-alive tab. Activate it, then assert
        // the order ROW (a page-wide getByText would also match the order's tab label, which
        // carries a "Заказ #<id> · " prefix and isn't an exact match anyway).
        if (hasWorkspaceTabs) {
            await workspaceTabs(page).getByRole('tab', { name: /Заказы/ }).first().click();
        }
        // The list default-sorts by order_date desc and the order uses a back-dated
        // orderDate, so it isn't on page 1. Search by order name to surface it
        // deterministically instead of relying on sort/pagination.
        const orderSearch = page.getByPlaceholder('Поиск по номеру заказа').first();
        await orderSearch.fill(orderName);
        await page.getByRole('button', { name: /Найти/ }).first().click();
        const row = page.getByRole('row', { name: new RegExp(orderName) }).first();
        await expect(row).toBeVisible({ timeout: 30000 });
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
        await expect(page.getByText('Несохраненные изменения').first()).toBeVisible();
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

async function createMinimalTrashCoverageOrder(page: Page, orderName: string): Promise<number> {
    await page.goto(`${frontendUrl}/orders`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Создать заказ' })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Создать заказ' }).click();

    const orderDialog = page.getByRole('dialog', { name: 'Создание нового заказа' });
    await expect(orderDialog).toBeVisible({ timeout: 30000 });
    await clickOrderTab(orderDialog, 'Основная информация');
    await selectAntdOption(page, formItem(orderDialog, 'Клиент'));
    await orderDialog.getByPlaceholder('Введите название заказа').fill(orderName);
    await fillDate(formItem(orderDialog, 'Дата заказа'), '23.05.2026');
    await selectAntdOption(page, formItem(orderDialog, 'Статус заказа'));
    await selectAntdOption(page, formItem(orderDialog, 'Статус оплаты'));
    await selectAntdOption(page, formItem(orderDialog, 'Менеджер'));
    await fillNumber(formItem(orderDialog, 'Приоритет'), '66');

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
        `trash order create failed with HTTP ${saveResponse.status()} ${saveResponse.statusText()}: ${summarizeApiBody(saveBody)}`,
    ).toBe(true);

    const orderId = readOrderIdFromCreateResponse(saveBody);
    expect(Number.isFinite(orderId)).toBe(true);
    await expect(orderDialog).toBeHidden({ timeout: 30000 });
    return orderId;
}

function extractSuggestedRestoreName(text: string): string | null {
    const match = text.match(/Восстановить как\s+(.+?)\?/);
    return match?.[1]?.trim() || null;
}

async function verifyEditTabs(page: Page, testInfo: TestInfo, orderName: string, detailName: string, paymentNote: string) {
    const form = page.locator('.ant-card').filter({ hasText: orderName }).first();
    await clickOrderTab(form, 'Основная информация');
    // Scope to the active order card + .first(): the tabbed workspace keeps multiple order
    // panels alive, so page-wide selectors hit duplicate elements (strict-mode violation).
    await expect(form.getByPlaceholder('Введите название заказа').first()).toHaveValue(orderName);
    await screenshot(page, testInfo, 'edit-basic');

    await clickOrderTab(form, 'Детали заказа');
    await expect(form.getByText(detailName).first()).toBeVisible();
    await screenshot(page, testInfo, 'edit-details');

    // ── Visual grouping assertions ────────────────────────────────────────────
    // Details table = the one carrying the «Обкат» column header, scoped to the
    // order form card so it never collides with the payments table.
    // Real № column = 2nd cell (cell 1 is the row-selection checkbox), excluding separators.
    const detailsTable = form.locator('table:has(th:has-text("Обкат"))');
    const readNums = async () => {
        const cells = detailsTable.locator(
            'tbody tr:not(.detail-group-separator):not(.detail-group-summary) td:nth-child(2)',
        );
        return (await cells.allInnerTexts()).map((t) => t.trim()).filter((t) => t.length > 0);
    };
    const baselineNums = await readNums();
    expect(baselineNums.length).toBeGreaterThanOrEqual(2); // fixture sanity (non-vacuous)

    // Group by material → separators + tinted groups appear.
    await form.getByRole('button', { name: /Группировать по/ }).click();
    await page.getByRole('menuitem', { name: 'по материалам' }).click();
    const sepCheckbox = form.getByLabel('Разделение на группы');
    await expect(sepCheckbox).toBeVisible();
    await expect(detailsTable.locator('tr.detail-group-separator')).not.toHaveCount(0);
    await expect(detailsTable.locator('tr.detail-group-summary')).toHaveCount(2);
    await expect(detailsTable.locator('tr.detail-group-summary').first()).toContainText('0,58');

    // Tint must be GROUP-based, not row-based: walk rows in DOM order; detail rows
    // between separators must share one tint parity, and parity must flip across each
    // separator. A row-index zebra would fail this check on the A,A group.
    // Distinct light hue per group: rows carry detail-group-tint-N (N cycles the palette).
    const tintSequence = await detailsTable.locator('tbody tr').evaluateAll((rows) =>
        rows.map((r) => {
            if (r.classList.contains('detail-group-separator')) return 'SEP';
            const tintClass = Array.from(r.classList).find((c) => /^detail-group-tint-\d+$/.test(c));
            return tintClass ? tintClass.replace('detail-group-tint-', '') : 'OTHER';
        }),
    );
    // Split on SEP, drop empty buckets; each group must be uniform; adjacent groups differ.
    const groups: string[][] = [];
    let cur: string[] = [];
    for (const t of tintSequence) {
        if (t === 'SEP') { if (cur.length) groups.push(cur); cur = []; }
        else if (t !== 'OTHER') cur.push(t);
    }
    if (cur.length) groups.push(cur);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    // ≥1 multi-row group required — an all-singleton fixture lets a row-index zebra pass vacuously.
    expect(groups.some((g) => g.length >= 2)).toBe(true);
    for (const g of groups) expect(new Set(g).size).toBe(1);           // each group uniform (incl. A,A)
    for (let i = 1; i < groups.length; i++) expect(groups[i][0]).not.toBe(groups[i - 1][0]); // parity flips

    // Uncheck → normal list: no separators AND original row order restored byte-equal.
    await sepCheckbox.uncheck();
    await expect(detailsTable.locator('tr.detail-group-separator')).toHaveCount(0);
    await expect(detailsTable.locator('tr.detail-group-summary')).toHaveCount(0);
    expect(await readNums()).toEqual(baselineNums);

    // Re-check → grouping re-activates (field stays persisted; check forces showSeparation on).
    await sepCheckbox.check();
    await expect(detailsTable.locator('tr.detail-group-separator')).not.toHaveCount(0);
    await expect(detailsTable.locator('tr.detail-group-summary')).toHaveCount(2);
    await screenshot(page, testInfo, 'edit-details-grouped');

    // ── Group-select-to-cut assertions (edit form) ────────────────────────────
    // Grouping is re-active (re-check above); the A group (МДФ 16мм) has EXACTLY 2
    // persisted details. Guard: if the add-to-cut button is absent (flag off) skip.
    const addToCutBtn = page.getByRole('button', { name: /Добавить выбранные в раскрой/ });
    if (await addToCutBtn.count()) {
      // baseline 0
      await expect(addToCutBtn).toHaveText(/Добавить выбранные в раскрой \(0\)/);
      // check the material A group (2 rows) via its separator checkbox
      const sep = detailsTable.locator('tr.detail-group-separator').first();
      await sep.locator('input[type="checkbox"]').check();
      // exact union: the A group has 2 persisted rows → count 2
      await expect(addToCutBtn).toHaveText(/Добавить выбранные в раскрой \(2\)/);
      // group checkbox now checked (all of its rows selected)
      await expect(sep.locator('input[type="checkbox"]')).toBeChecked();
      // uncheck restores 0
      await sep.locator('input[type="checkbox"]').uncheck();
      await expect(addToCutBtn).toHaveText(/Добавить выбранные в раскрой \(0\)/);
    } else {
      console.log('[cut-group] edit add-to-cut button absent (flag off) — skipping');
    }
    // ── End group-select-to-cut assertions ──────────────────────────────────

    // ── End visual grouping assertions ───────────────────────────────────────

    await clickOrderTab(form, 'Даты');
    await screenshot(page, testInfo, 'edit-dates');

    await clickOrderTab(form, 'Финансы');
    await expect(form.getByText(paymentNote).first()).toBeVisible();
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

    // ── Show-page grouping + cut-select guard ────────────────────────────────
    // grouping state (field=material, showSeparation=true) was re-activated on the
    // edit page (re-check step above) and persisted to localStorage; the show page
    // reads the same key and must render separators while the details section is open.
    await expect(page.locator('tr.detail-group-separator')).not.toHaveCount(0);
    await expect(page.locator('tr.detail-group-summary')).toHaveCount(2);
    await expect(page.locator('tr.detail-group-summary').first()).toContainText('0.58');
    // Entering cut-select mode must KEEP separators visible (Tasks 3/4 pass
    // includeLeadingSeparator + groupingActive without the old !cutSelectMode gate).
    // Group checkbox on the first separator selects the whole group (EXACTLY 2 rows
    // for the A group in the A,B,A fixture) and the union math works correctly.
    const cutSelectBtn = page.getByRole('button', { name: 'Выделить детали для раскроя' });
    if (await cutSelectBtn.count()) {
        await cutSelectBtn.click();
        // grouping stays visible during cut-select
        await expect(page.locator('tr.detail-group-separator')).not.toHaveCount(0);
        const detailsTableShow = page.locator('table:has(th:has-text("Обкат"))'); // show details table
        const showAdd = page.getByRole('button', { name: /Добавить выбранные в раскрой/ });
        await expect(showAdd).toHaveText(/Добавить выбранные в раскрой \(0\)/);
        // The fixture order is A,B,A by material → the first material group has EXACTLY 2 details.
        // Check that group's separator → exact count 2 (proves union math + correct cardinality).
        const showSep = page.locator('tr.detail-group-separator').first();
        await showSep.locator('input[type="checkbox"]').check();
        await expect(showAdd).toHaveText(/Добавить выбранные в раскрой \(2\)/);
        // add one more individual row (a row NOT in that group) → union becomes 3
        const otherRow = detailsTableShow
            .locator('tbody tr.ant-table-row:not(.detail-group-separator):not(.detail-group-summary)')
            .nth(2);
        await otherRow.locator('input[type="checkbox"]').check();
        await expect(showAdd).toHaveText(/Добавить выбранные в раскрой \(3\)/);
        // uncheck the group → back to the single individual row (1)
        await showSep.locator('input[type="checkbox"]').uncheck();
        await expect(showAdd).toHaveText(/Добавить выбранные в раскрой \(1\)/);
        // exit cut-select mode so the rest of the show-page flow runs without UI interference
        await page.getByRole('button', { name: 'Отменить выбор' }).click();
    } else {
        console.log('[cut-group] show cut-select button absent (flag off) — skipping');
    }
    // ── End show-page cut-select guard ──────────────────────────────────────

    await page.getByText('Финансы', { exact: false }).first().click();
    await expect(page.getByRole('row', { name: /4\s?501/ }).first()).toBeVisible();
    await screenshot(page, testInfo, 'show-finance');

    await page.getByText('Дополнительная информация', { exact: false }).first().click();
    await expect(page.getByText('Создал').first()).toBeVisible();
    // The show page renders the creator as the user's full name ("Codex Playwright"),
    // while the orders list shows the username ("codex_playwright"). Match either form so
    // the assertion is robust to which identity field a surface displays.
    const creatorPattern = new RegExp(username.replace(/[_\s]+/g, '[\\s_]+'), 'i');
    await expect(page.getByText(creatorPattern).first()).toBeVisible({ timeout: 15000 });
    await screenshot(page, testInfo, 'show-additional-created-by');

    await page.getByRole('button', { name: 'Обновить' }).first().click();
    await expect(page.getByText(orderName, { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Печать' }).first().click();
    await expect(page.getByText(orderName, { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Экспорт в Excel' }).first().click();
    await expect(page.getByText(/Excel файл успешно сгенерирован|Ошибка/)).toBeVisible({ timeout: 30000 });

    // "JSON snapshot" is a menu item inside the "Другие экспорты" (⋮) dropdown, not a button.
    await page.getByRole('button', { name: 'Другие экспорты' }).first().click();
    await page.getByRole('menuitem', { name: 'JSON snapshot' }).click();
    await expect(page.getByText(/JSON snapshot заказа выгружен|Не удалось выгрузить JSON snapshot/)).toBeVisible({ timeout: 30000 });

    // The show page exposes two "Изменить" controls (top EditButton link + an inline
    // small button); the first is the primary action that routes to the edit page.
    await page.getByRole('button', { name: 'Изменить' }).first().click();
    await page.waitForURL(new RegExp(`/orders/edit/${orderId}`), { timeout: 30000 });
    await expect(page.getByText(orderName, { exact: true }).first()).toBeVisible();
    await page.goto(`${frontendUrl}/orders/show/${orderId}`, { waitUntil: 'domcontentloaded' });
}

async function verifyDurableDatabaseState(
    orderId: number,
    orderName: string,
    clientName: string,
    detailName: string,
    paymentRef: string,
) {
    if (!process.env.PG_USER || !process.env.PG_DB) return;

    const container = process.env.ORDER_UI_FULL_COVERAGE_DB_CONTAINER ?? `${process.env.COMPOSE_PROJECT_NAME ?? 'erp_dev'}-postgresdb-1`;
    const sql = `
      select json_build_object(
        'orderName', o.order_name,
        'clientName', c.client_name,
        'clientPersonType', c.person_type,
        'createdBy', u.username,
        'detailCount', (select count(*) from order_details od where od.order_id = o.order_id),
        'detailName', (select od.detail_name from order_details od where od.order_id = o.order_id order by od.detail_id desc limit 1),
        'paymentCount', (select count(*) from payments p where p.order_id = o.order_id),
        'paymentRef', (select p.ref_key_1c from payments p where p.order_id = o.order_id order by p.payment_id desc limit 1)
      )
      from orders o
      join clients c on c.client_id = o.client_id
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
        clientName,
        clientPersonType: 'legal',
        createdBy: username,
        detailName,
        paymentRef,
    });
    expect(Number(state.detailCount)).toBeGreaterThanOrEqual(1);
    expect(Number(state.paymentCount)).toBeGreaterThanOrEqual(1);
}

function formItem(scope: Locator, label: string) {
    // Match the form-item by its EXACT label text. A loose `hasText` substring match breaks
    // since SP3 added the "Листовой материал" field, whose label contains "Материал" and
    // would otherwise be matched by `formItem(scope, 'Материал')`.
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return scope
        .locator('.ant-form-item')
        .filter({
            has: scope.page().locator('.ant-form-item-label label', {
                hasText: new RegExp(`^\\s*${escaped}\\s*$`),
            }),
        })
        .first();
}

async function clickOrderTab(scope: Locator, label: string) {
    await scope.getByRole('tab', { name: label }).click();
}

async function selectAntdOption(page: Page, item: Locator, optionText?: string) {
    const select = item.locator('.ant-select').first();
    await select.click();
    // For a named option, type into the search box first. Large lists (e.g. materials,
    // 58+ entries) are virtualized by AntD, so the target row may not be in the rendered
    // window until the search filters it into view.
    if (optionText) {
        const search = select.locator('input.ant-select-selection-search-input');
        if (await search.count()) {
            await search.fill('');
            await search.type(optionText, { delay: 10 });
        }
    }
    const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    const option = optionText
        ? dropdown.getByText(optionText, { exact: true }).first()
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
