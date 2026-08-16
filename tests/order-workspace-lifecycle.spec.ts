import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createWorkflowMockDb, setupWorkflowMockApi } from './helpers/mockWorkflowApi';

test.describe('order workspace lifecycle', () => {
    test('bounds ten edit workspaces, restores evicted draft and keeps hidden reads silent', async ({ page }, testInfo) => {
        test.setTimeout(900_000);
        const orderCount = Math.max(4, Number(process.env.ORDER_WORKSPACE_TAB_COUNT ?? 10));
        const db = createWorkflowMockDb();
        let releaseFirstTelegramPreview!: () => void;
        const firstTelegramPreviewGate = new Promise<void>((resolve) => {
            releaseFirstTelegramPreview = resolve;
        });
        let telegramPreviewRequests = 0;
        for (let orderId = 1; orderId <= orderCount; orderId += 1) {
            db.orders.push(createOrderRow(orderId));
            db.order_details.push(createOrderDetailRow(orderId));
        }

        await setupWorkflowMockApi(page, db, { runtimeConfig: false });
        await page.route(/\/runtime-config\.json$/, fulfillTreatmentRuntimeConfig);
        await page.route(/\/api\/v1\/cut-jobs\/detail-last-ready(?:\?.*)?$/, async (route) => {
            const ids = new URL(route.request().url()).searchParams.get('detailIds')
                ?.split(',')
                .map(Number)
                .filter((id) => Number.isInteger(id) && id > 0) ?? [];
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    details: ids.map((detailId) => ({
                        orderDetailId: detailId,
                        cutJob: null,
                        bathCutJob: {
                            cutJobId: 9_000 + detailId,
                            resultNo: 1,
                            cutNumber: `CUT-${detailId}`,
                            name: `Раскрой ${detailId}`,
                            paramProfileId: null,
                            profileName: null,
                            profileIsActive: null,
                        },
                    })),
                }),
            });
        });
        await page.route(/\/api\/v1\/cut-jobs\/\d+$/, async (route) => {
            const cutJobId = Number(new URL(route.request().url()).pathname.split('/').pop());
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ cutJobId, name: `Раскрой ${cutJobId}`, items: [], groups: [] }),
            });
        });
        await page.route(/\/api\/v1\/label-templates(?:\?.*)?$/, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([{
                    labelTemplateId: 1,
                    name: 'Lifecycle template',
                    description: null,
                    version: 1,
                    isActive: true,
                    canvasWidthMm: 100,
                    canvasHeightMm: 50,
                    dpi: 203,
                    defaultExportFormats: ['svg'],
                    customFieldSchema: {},
                    fieldCatalogSnapshot: { fields: [] },
                    elements: [],
                }]),
            });
        });
        await page.route(/\/api\/v1\/orders\/\d+\/label-data(?:\?.*)?$/, async (route) => {
            const orderId = Number(new URL(route.request().url()).pathname.split('/')[4]);
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    orderId,
                    templateId: 1,
                    templateVersion: 1,
                    customFieldSchema: {},
                    details: [],
                }),
            });
        });
        await page.route(/\/api\/v1\/orders\/\d+\/labels\/latest$/, async (route) => {
            await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
        });
        await page.route(/\/api\/v1\/cnc-telegram\/orders\/\d+\/screenshots$/, async (route) => {
            const orderId = Number(new URL(route.request().url()).pathname.split('/')[5]);
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    orderId,
                    generatedAt: '2026-08-15T00:00:00.000Z',
                    originalRetentionDays: 30,
                    screenshots: [{
                        kind: 'telegram',
                        packetId: '00000000-0000-4000-8000-000000000001',
                        sourceMessageId: 1,
                        sourceCreatedAt: '2026-08-15T00:00:00.000Z',
                        programName: 'Lifecycle',
                        materialName: 'МДФ',
                        matchedDetailCount: 1,
                        itemQuantityTotal: 1,
                        previewUrl: null,
                        imageUrl: null,
                        originalAvailable: true,
                        availableUntil: '2026-09-15T00:00:00.000Z',
                        restore: null,
                    }],
                    manualFiles: [],
                }),
            });
        });
        await page.route(/\/api\/v1\/cnc-telegram\/orders\/\d+\/screenshots\/[^/]+\/preview$/, async (route) => {
            telegramPreviewRequests += 1;
            if (telegramPreviewRequests === 1) await firstTelegramPreviewGate;
            await route.fulfill({ status: 200, contentType: 'image/png', body: 'preview' });
        });
        await page.goto('/login', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('input[autocomplete="username"]')).toBeVisible({
            timeout: 90_000,
        });

        for (let orderId = 1; orderId <= orderCount; orderId += 1) {
            await navigateSpa(page, `/orders/edit/${orderId}`);
            await expect(page.locator(`[data-workspace-key="/orders/edit/${orderId}"]`))
                .toHaveCount(1, { timeout: 90_000 });
            const checkpointDiagnostics = await readCheckpointDiagnostics(page);
            if (checkpointDiagnostics.circuitOpen) {
                await testInfo.attach(`checkpoint-circuit-order-${orderId}.json`, {
                    body: Buffer.from(JSON.stringify(checkpointDiagnostics, null, 2)),
                    contentType: 'application/json',
                });
                throw new Error(`Checkpoint circuit opened at order ${orderId}: ${JSON.stringify(checkpointDiagnostics)}`);
            }
            if (orderId === 1) {
                const detailsTab = page.getByRole('tab', { name: /^(Детали заказа|Состав)$/ });
                const basicTab = page.getByRole('tab', { name: /^(Основная информация|Обзор)$/ });
                await expect(detailsTab).toBeVisible({ timeout: 90_000 });
                await basicTab.click();
                await expect(basicTab).toHaveAttribute('aria-selected', 'true');
                const orderNameInput = page.getByPlaceholder('Введите название заказа');
                await expect(orderNameInput).toBeVisible({ timeout: 30_000 });
                await orderNameInput.fill('Lifecycle 1 unsaved draft');
                if (await detailsTab.getAttribute('aria-selected') !== 'true') {
                    await detailsTab.click();
                    await expect(detailsTab).toHaveAttribute('aria-selected', 'true');
                }
                await page.waitForTimeout(750);
                const materialsTab = page.getByRole('tab', { name: 'Материалы' });
                const additionalTab = page.getByRole('tab', { name: /^(Бирки|Дополнительно)$/ });
                await materialsTab.click();
                await expect(materialsTab).toHaveAttribute('aria-selected', 'true');
                await page.waitForTimeout(750);
                await additionalTab.click();
                await expect(additionalTab).toHaveAttribute('aria-selected', 'true');
                await page.getByText('Ссылки на файлы', { exact: true }).click();
                await expect(page.locator('.order-telegram-screenshot-card')).toHaveCount(1, { timeout: 30_000 });
                await expect.poll(() => telegramPreviewRequests).toBe(1);
                await page.waitForTimeout(750);
                await basicTab.click();
                await expect(basicTab).toHaveAttribute('aria-selected', 'true');
                releaseFirstTelegramPreview();
                await page.waitForTimeout(250);
                await expect(page.locator('.order-telegram-screenshot-card img')).toHaveCount(0);
                await additionalTab.click();
                await expect(additionalTab).toHaveAttribute('aria-selected', 'true');
                await expect.poll(() => telegramPreviewRequests).toBe(2);
                await expect(page.locator('.order-telegram-screenshot-card img')).toHaveCount(1, { timeout: 30_000 });
                await basicTab.click();
                await expect(basicTab).toHaveAttribute('aria-selected', 'true');

                let inactiveSurfaceReads = 0;
                const countInactiveSurfaceRead = (request: Request) => {
                    if (isOrderInactiveSurfaceRead(request)) inactiveSurfaceReads += 1;
                };
                page.on('request', countInactiveSurfaceRead);
                for (let cycle = 0; cycle < 3; cycle += 1) {
                    await page.evaluate(() => {
                        window.dispatchEvent(new Event('blur'));
                        window.dispatchEvent(new Event('focus'));
                    });
                    await page.waitForTimeout(250);
                }
                page.off('request', countInactiveSurfaceRead);
                expect(inactiveSurfaceReads).toBe(0);
                await detailsTab.click();
                await expect(detailsTab).toHaveAttribute('aria-selected', 'true');
            }
        }
        await navigateSpa(page, '/orders');
        await expect(page.locator('[data-workspace-key="/orders"]:not([hidden])'))
            .toBeVisible({ timeout: 90_000 });
        const listTransitionDiagnostics = await readCheckpointDiagnostics(page);
        await testInfo.attach('checkpoint-diagnostics-after-list-transition.json', {
            body: Buffer.from(JSON.stringify(listTransitionDiagnostics, null, 2)),
            contentType: 'application/json',
        });
        if (listTransitionDiagnostics.circuitOpen) {
            throw new Error(`Checkpoint circuit opened on list transition: ${JSON.stringify(listTransitionDiagnostics)}`);
        }

        const mountedHeavy = page.locator('[data-workspace-key^="/orders/edit/"]');
        try {
            await expect.poll(async () => mountedHeavy.count(), { timeout: 30_000 }).toBe(2);
        } catch {
            const failedDiagnostics = {
                domMountedHeavyViewCount: await mountedHeavy.count(),
                ...await readCheckpointDiagnostics(page),
            };
            throw new Error(`Bounded keep-alive mismatch: ${JSON.stringify(failedDiagnostics)}`);
        }
        await expect(page.locator(`[data-workspace-key="/orders/edit/${orderCount - 1}"]`)).toHaveCount(1);
        await expect(page.locator(`[data-workspace-key="/orders/edit/${orderCount}"]`)).toHaveCount(1);
        for (let evictedOrderId = 1; evictedOrderId <= orderCount - 2; evictedOrderId += 1) {
            await expect(page.locator(`[data-workspace-key="/orders/edit/${evictedOrderId}"]`))
                .toHaveCount(0);
        }

        let inventoryReads = 0;
        const countInventoryRead = (request: Request) => {
            if (isOrderInventoryRead(request)) inventoryReads += 1;
        };
        page.on('request', countInventoryRead);

        for (let cycle = 0; cycle < 3; cycle += 1) {
            await page.evaluate(() => {
                window.dispatchEvent(new Event('blur'));
                window.dispatchEvent(new Event('focus'));
            });
            await page.waitForTimeout(250);
        }

        page.off('request', countInventoryRead);
        expect(inventoryReads).toBe(0);

        const steadyStateEvidence = await collectBoundedKeepAliveEvidence(page);
        expect(steadyStateEvidence.heavyWorkspaceKeys).toEqual([
            `/orders/edit/${orderCount}`,
            `/orders/edit/${orderCount - 1}`,
        ].sort());

        await navigateSpa(page, '/orders/edit/1');
        const restoredWorkspace = page.locator(
            '[data-workspace-key="/orders/edit/1"]:not([hidden])',
        );
        await expect(restoredWorkspace).toBeVisible({ timeout: 90_000 });
        const restoredDetailsTab = restoredWorkspace.getByRole('tab', {
            name: /^(Детали заказа|Состав)$/,
        });
        await expect(restoredDetailsTab).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
        await expect(restoredWorkspace.getByText('Lifecycle 1 unsaved draft', { exact: true }).first())
            .toBeVisible({ timeout: 30_000 });
        const restoredEvidence = await collectBoundedKeepAliveEvidence(page);
        expect(restoredEvidence.heavyWorkspaceKeys).toEqual([
            '/orders/edit/1',
            `/orders/edit/${orderCount}`,
            `/orders/edit/${orderCount - 1}`,
        ].sort());

        const evidence = {
            schemaVersion: 1,
            scenario: `${orderCount}-order-edit-tabs-treatment`,
            listTransitionDiagnostics,
            steadyState: steadyStateEvidence,
            restored: restoredEvidence,
            restoredDiagnostics: await readCheckpointDiagnostics(page),
            hiddenInventoryReadsAcrossThreeFocusCycles: inventoryReads,
            restoredOrderId: 1,
            restoredActiveSubtab: 'details',
            restoredUnsavedOrderName: true,
        };
        const evidenceBody = JSON.stringify(evidence, null, 2);
        await testInfo.attach('bounded-keep-alive-10-tab-evidence.json', {
            body: Buffer.from(evidenceBody),
            contentType: 'application/json',
        });
        const evidencePath = process.env.ORDER_WORKSPACE_EVIDENCE_PATH;
        if (evidencePath) {
            await mkdir(dirname(evidencePath), { recursive: true });
            await writeFile(evidencePath, `${evidenceBody}\n`, 'utf8');
        }

    });

    test('suppresses a manual file completion after the auth actor changes', async ({ page }) => {
        test.setTimeout(150_000);
        const db = createWorkflowMockDb();
        db.orders.push(createOrderRow(1));
        db.order_details.push(createOrderDetailRow(1));
        let releaseManualDownload!: () => void;
        const manualDownloadGate = new Promise<void>((resolve) => {
            releaseManualDownload = resolve;
        });
        let manualDownloadRequests = 0;

        await setupWorkflowMockApi(page, db, { runtimeConfig: false });
        await page.route(/\/runtime-config\.json$/, fulfillTreatmentRuntimeConfig);
        await page.route(/\/api\/v1\/cnc-telegram\/orders\/\d+\/screenshots$/, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    orderId: 1,
                    generatedAt: '2026-08-15T00:00:00.000Z',
                    originalRetentionDays: 30,
                    screenshots: [],
                    manualFiles: [{
                        fileId: '00000000-0000-4000-8000-000000000002',
                        packetId: '00000000-0000-4000-8000-000000000003',
                        kind: 'screenshot',
                        fileName: 'manual-lifecycle.png',
                        contentType: 'image/png',
                        sizeBytes: 7,
                        sha256: 'manual-lifecycle-sha256',
                        generated: false,
                        createdAt: '2026-08-15T00:00:00.000Z',
                        expiresAt: '2026-09-15T00:00:00.000Z',
                        downloadUrl: '/api/v1/cnc-telegram/orders/1/manual-svg-files/00000000-0000-4000-8000-000000000002',
                        cutJobId: 9001,
                        cutJobDisplayNumber: '1',
                        cutResultId: 9101,
                        cutResultNo: 1,
                        telegramSendStatus: 'sent',
                    }],
                }),
            });
        });
        await page.route(/\/api\/v1\/cnc-telegram\/orders\/\d+\/manual-svg-files\/[^/]+$/, async (route) => {
            manualDownloadRequests += 1;
            await manualDownloadGate;
            await route.fulfill({
                status: 200,
                contentType: 'image/png',
                headers: { 'content-disposition': 'attachment; filename="manual-lifecycle.png"' },
                body: 'manual',
            });
        });

        await page.goto('/login', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('input[autocomplete="username"]')).toBeVisible({ timeout: 90_000 });
        await navigateSpa(page, '/orders/edit/1');
        await expect(page.locator('[data-workspace-key="/orders/edit/1"]'))
            .toHaveCount(1, { timeout: 90_000 });
        const actorAWorkspace = page.locator('[data-workspace-key="/orders/edit/1"]:not([hidden])');
        const basicTab = actorAWorkspace.getByRole('tab', { name: /^(Основная информация|Обзор)$/ });
        const additionalTab = page.getByRole('tab', { name: /^(Бирки|Дополнительно)$/ });
        await basicTab.click();
        const actorAOrderName = actorAWorkspace.getByPlaceholder('Введите название заказа');
        await expect(actorAOrderName).toBeVisible({ timeout: 30_000 });
        await actorAOrderName.fill('Actor A secret draft');
        await additionalTab.click();
        await expect(additionalTab).toHaveAttribute('aria-selected', 'true');
        await page.getByText('Ссылки на файлы', { exact: true }).click();
        const manualFile = page.getByRole('button', {
            name: /Скачать файл раскроя manual-lifecycle\.png/,
        });
        await expect(manualFile).toBeVisible({ timeout: 30_000 });

        let downloadEvents = 0;
        const countDownload = () => {
            downloadEvents += 1;
        };
        page.on('download', countDownload);
        await manualFile.click();
        await expect.poll(() => manualDownloadRequests).toBe(1);
        await page.evaluate(async () => {
            const { authSession } = await import('/src/api/authSession.ts');
            authSession.setUser({
                id: 'actor-b',
                username: 'actor-b',
                role: 'admin',
                permissions: ['orders.view', 'orders.update', 'labels.view'],
            });
        });
        const actorBWorkspace = page.locator('[data-workspace-key="/orders/edit/1"]:not([hidden])');
        await expect(actorBWorkspace).toHaveCount(1, { timeout: 30_000 });
        const actorBBasicTab = actorBWorkspace.getByRole('tab', { name: /^(Основная информация|Обзор)$/ });
        await actorBBasicTab.click();
        const actorBOrderName = actorBWorkspace.getByPlaceholder('Введите название заказа');
        await expect(actorBOrderName).toBeVisible({ timeout: 30_000 });
        await expect(actorBOrderName).toHaveValue('');
        await expect(actorBOrderName).not.toHaveValue('Actor A secret draft');
        releaseManualDownload();
        await page.waitForTimeout(500);
        page.off('download', countDownload);
        expect(downloadEvents).toBe(0);
    });

    test('coalesces flag-off show and edit focus refresh without realtime reads', async ({ page }) => {
        test.setTimeout(180_000);
        const db = createWorkflowMockDb();
        db.orders.push(createOrderRow(1));
        db.order_details.push(createOrderDetailRow(1));

        await setupWorkflowMockApi(page, db, {
            runtimeConfig: false,
            authUser: {
                id: '1',
                user_id: 1,
                username: 'admin',
                role: 'admin',
                role_id: 1,
                permissions: ['orders.view', 'orders.update', 'cut.view'],
            },
        });
        await page.route(/\/runtime-config\.json$/, fulfillTreatmentBackendReadRuntimeConfig);
        let orderDtoResponses = 0;
        await page.route(/\/api\/v1\/orders\/1$/, async (route) => {
            orderDtoResponses += 1;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ order: createLifecycleOrderDto(1) }),
            });
        });
        await page.route(/\/api\/v1\/cut-jobs\/detail-last-ready(?:\?.*)?$/, async (route) => {
            const ids = new URL(route.request().url()).searchParams.get('detailIds')
                ?.split(',')
                .map(Number)
                .filter((id) => Number.isInteger(id) && id > 0) ?? [];
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    details: ids.map((detailId) => ({
                        orderDetailId: detailId,
                        cutJob: null,
                        bathCutJob: null,
                    })),
                }),
            });
        });

        let legacyStatusReads = 0;
        let cutReads = 0;
        let realtimeReads = 0;
        const countRefreshRead = (request: Request) => {
            if (isFlagOffDetailStatusRead(request)) legacyStatusReads += 1;
            if (new URL(request.url()).pathname === '/api/v1/cut-jobs/detail-last-ready') {
                cutReads += 1;
            }
            if (isOrderRealtimeRead(request)) realtimeReads += 1;
        };
        page.on('request', countRefreshRead);

        await page.goto('/login', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('input[autocomplete="username"]')).toBeVisible({ timeout: 90_000 });
        await installControllableDateNow(page);
        await navigateSpa(page, '/orders/show/1');
        await expect(page).toHaveURL(/\/orders\/show\/1$/, { timeout: 90_000 });
        await expect(page.getByRole('heading', { name: 'Просмотр заказа' }))
            .toBeVisible({ timeout: 90_000 });
        await expect.poll(() => cutReads, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
        await page.waitForTimeout(500);

        legacyStatusReads = 0;
        cutReads = 0;
        await dispatchFocusBurst(page);
        await page.waitForTimeout(250);
        expect(legacyStatusReads).toBe(0);
        expect(cutReads).toBe(0);

        await advanceBrowserClock(page, 16_000);
        await dispatchFocusBurst(page);
        await expect.poll(() => legacyStatusReads).toBe(1);
        await expect.poll(() => cutReads).toBe(1);
        await page.waitForTimeout(250);
        expect(legacyStatusReads).toBe(1);
        expect(cutReads).toBe(1);
        expect(realtimeReads).toBe(0);

        legacyStatusReads = 0;
        cutReads = 0;
        orderDtoResponses = 0;
        await navigateSpa(page, '/orders/edit/1');
        await expect(page).toHaveURL(/\/orders\/edit\/1$/, { timeout: 90_000 });
        await expect.poll(() => orderDtoResponses, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
        const editDetailsTab = page.getByRole('tab', { name: /^(Детали заказа|Состав)$/ });
        await expect(editDetailsTab).toBeVisible({ timeout: 30_000 });
        if (await editDetailsTab.getAttribute('aria-selected') !== 'true') {
            await editDetailsTab.click();
            await expect(editDetailsTab).toHaveAttribute('aria-selected', 'true');
        }
        await expect.poll(() => cutReads, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
        await page.waitForTimeout(500);
        legacyStatusReads = 0;
        cutReads = 0;

        await dispatchFocusBurst(page);
        await page.waitForTimeout(250);
        expect(legacyStatusReads).toBe(0);
        expect(cutReads).toBe(0);

        await advanceBrowserClock(page, 16_000);
        await dispatchFocusBurst(page);
        await expect.poll(() => cutReads).toBe(1);
        await page.waitForTimeout(250);
        expect(legacyStatusReads).toBe(0);
        expect(cutReads).toBe(1);
        expect(realtimeReads).toBe(0);

        page.off('request', countRefreshRead);
    });
});

function isOrderInventoryRead(request: Request): boolean {
    const url = new URL(request.url());
    if (url.pathname === '/v1/graphql') return true;
    if (isOrderManualSurfaceRead(request)) return true;
    return /^\/api\/v1\/orders(?:\/|$)/.test(url.pathname)
        && request.method() === 'GET';
}

function isOrderInactiveSurfaceRead(request: Request): boolean {
    const url = new URL(request.url());
    if (isOrderManualSurfaceRead(request)) return true;
    return url.pathname === '/v1/graphql'
        && /\border_details(?:_view)?\b/.test(request.postData() ?? '');
}

function isOrderManualSurfaceRead(request: Request): boolean {
    if (request.method() !== 'GET') return false;
    const path = new URL(request.url()).pathname;
    return path === '/api/v1/cut-jobs/detail-last-ready'
        || path === '/api/v1/bazis-cut-sets/order-memberships'
        || /^\/api\/v1\/cut-jobs\/\d+$/.test(path)
        || path === '/api/v1/label-templates'
        || /^\/api\/v1\/orders\/\d+\/label-data$/.test(path)
        || /^\/api\/v1\/orders\/\d+\/labels\/latest$/.test(path)
        || /^\/api\/v1\/cnc-telegram\/orders\/\d+\/screenshots$/.test(path)
        || /^\/api\/v1\/cnc-telegram\/orders\/\d+\/screenshots\/[^/]+\/(?:preview|image)$/.test(path)
        || /^\/api\/v1\/cut-jobs\/\d+\/groups\/\d+\/sheets\/\d+\/png$/.test(path);
}

function isFlagOffDetailStatusRead(request: Request): boolean {
    return request.method() === 'GET'
        && new URL(request.url()).pathname === '/api/v1/orders/1';
}

function isOrderRealtimeRead(request: Request): boolean {
    const path = new URL(request.url()).pathname;
    return /^\/api\/v1\/orders\/\d+\/(detail-live-state|live-events)$/.test(path);
}

async function installControllableDateNow(page: Page): Promise<void> {
    await page.evaluate(() => {
        const browserWindow = window as typeof window & {
            __erpRealDateNow?: () => number;
            __erpDateBaseMs?: number;
            __erpDateOffsetMs?: number;
        };
        browserWindow.__erpRealDateNow ??= Date.now.bind(Date);
        browserWindow.__erpDateBaseMs = browserWindow.__erpRealDateNow();
        browserWindow.__erpDateOffsetMs = 0;
        Date.now = () => (
            browserWindow.__erpDateBaseMs ?? 0
        ) + (browserWindow.__erpDateOffsetMs ?? 0);
    });
}

async function advanceBrowserClock(page: Page, deltaMs: number): Promise<void> {
    await page.evaluate((delta) => {
        const browserWindow = window as typeof window & { __erpDateOffsetMs?: number };
        browserWindow.__erpDateOffsetMs = (browserWindow.__erpDateOffsetMs ?? 0) + delta;
    }, deltaMs);
}

async function dispatchFocusBurst(page: Page): Promise<void> {
    await page.evaluate(() => {
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('focus'));
    });
}

async function navigateSpa(page: Page, path: string): Promise<void> {
    await page.evaluate((nextPath) => {
        window.history.pushState({}, '', nextPath);
        window.dispatchEvent(new PopStateEvent('popstate'));
    }, path);
}

async function collectBoundedKeepAliveEvidence(page: Page): Promise<{
    heavyWorkspaceKeys: string[];
    hiddenWorkspaceCount: number;
    usedJsHeapSize: number | null;
    totalJsHeapSize: number | null;
}> {
    return page.evaluate(() => {
        const heavyWorkspaceKeys = [...document.querySelectorAll<HTMLElement>(
            '[data-workspace-key^="/orders/edit/"]',
        )].map((element) => element.dataset.workspaceKey ?? '').filter(Boolean).sort();
        const memory = (performance as Performance & {
            memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number };
        }).memory;
        return {
            heavyWorkspaceKeys,
            hiddenWorkspaceCount: document.querySelectorAll('[data-workspace-key][hidden]').length,
            usedJsHeapSize: Number.isFinite(memory?.usedJSHeapSize)
                ? Number(memory?.usedJSHeapSize)
                : null,
            totalJsHeapSize: Number.isFinite(memory?.totalJSHeapSize)
                ? Number(memory?.totalJSHeapSize)
                : null,
        };
    });
}

async function readCheckpointDiagnostics(page: Page): Promise<{
    checkpointCaptureFailures: number;
    unsnapshottedTransientSurfaces: number;
    circuitOpen: boolean;
    lastFailure: { kind: string; adapterKey: string | null } | null;
    cohort: string;
    mountedHeavyViewCount: number;
    peakMountedHeavyViewCount: number;
}> {
    return page.evaluate(async () => {
        const [registry, cohortStore, keepAliveDiagnostics] = await Promise.all([
            import('/src/workspace/workspaceCheckpointRegistry.ts'),
            import('/src/performance/orderLifecycleCohortStore.ts'),
            import('/src/workspace/workspaceKeepAliveDiagnostics.ts'),
        ]);
        return {
            ...registry.getWorkspaceCheckpointDiagnostics(),
            cohort: cohortStore.getCurrentOrderLifecycleCohort(),
            ...keepAliveDiagnostics.getWorkspaceKeepAliveDiagnostics(),
        };
    });
}

async function fulfillTreatmentRuntimeConfig(route: Route): Promise<void> {
    await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
            apiUrl: '',
            observability: { performanceRum: false },
            features: {
                backendAuth: false,
                backendPermissions: false,
                backendOrdersRead: false,
                backendOrdersWrite: false,
                backendReferences: false,
                orderRealtime: false,
                enableLegacyHasura: true,
            },
            rollouts: {
                orderLifecycleV2: {
                    enabled: true,
                    percent: 100,
                    allocationSalt: 'playwright-stage1-workspace',
                    configVersion: 'stage1-pr11-v1',
                },
            },
        }),
    });
}

async function fulfillTreatmentBackendReadRuntimeConfig(route: Route): Promise<void> {
    await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
            apiUrl: '',
            observability: { performanceRum: false },
            features: {
                backendAuth: false,
                backendPermissions: false,
                backendOrdersRead: true,
                backendOrdersWrite: false,
                backendReferences: false,
                backendCut: true,
                orderRealtime: false,
                enableLegacyHasura: true,
            },
            rollouts: {
                orderLifecycleV2: {
                    enabled: true,
                    percent: 100,
                    allocationSalt: 'playwright-stage1-pr12',
                    configVersion: 'stage1-pr12-v1',
                },
            },
        }),
    });
}

function createOrderRow(orderId: number): Record<string, unknown> {
    return {
        order_id: orderId,
        order_name: `Lifecycle ${orderId}`,
        client_id: 1,
        order_date: '2026-08-15',
        order_status_id: 1,
        payment_status_id: 1,
        production_status_id: 1,
        priority: 100,
        total_amount: 0,
        final_amount: 0,
        paid_amount: 0,
        parts_count: 0,
        total_area: 0,
        version: 1,
        delete_flag: false,
    };
}

function createOrderDetailRow(orderId: number): Record<string, unknown> {
    return {
        detail_id: orderId,
        order_id: orderId,
        detail_number: '1',
        detail_name: `Деталь ${orderId}`,
        height: 600,
        width: 400,
        quantity: 1,
        area: 0.24,
        material_id: 1,
        film_id: 1,
        version: 1,
        delete_flag: false,
    };
}

function createLifecycleOrderDto(orderId: number): Record<string, unknown> {
    return {
        header: {
            orderId,
            orderName: `Lifecycle ${orderId}`,
            clientId: 1,
            clientName: 'Базовый клиент',
            orderDate: '2026-08-15',
            orderStatusId: 1,
            paymentStatusId: 1,
            productionStatusId: 1,
            priority: 100,
            version: 1,
        },
        details: [{
            id: orderId,
            orderId,
            detailNumber: 1,
            detailName: `Деталь ${orderId}`,
            height: 600,
            width: 400,
            quantity: 1,
            area: 0.24,
            materialId: 1,
            millingTypeId: 1,
            edgeTypeId: 1,
            filmId: 1,
            detailCost: 0,
            bazisProjectId: null,
            productionStatusId: 1,
            priority: 100,
            version: 1,
        }],
        payments: [],
        workshops: [],
        requirements: [],
        dowelingLinks: [],
        totals: {
            totalAmount: 0,
            discount: 0,
            surcharge: 0,
            finalAmount: 0,
            paidAmount: 0,
            debtAmount: 0,
            partsCount: 1,
            totalArea: 0.24,
        },
        version: 1,
    };
}
