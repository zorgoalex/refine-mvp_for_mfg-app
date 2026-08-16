import { expect, test, type Page, type Request, type Route } from '@playwright/test';

import { createWorkflowMockDb, setupWorkflowMockApi } from './helpers/mockWorkflowApi';

test.describe('order workspace lifecycle', () => {
    test('keeps ten hidden edit workspaces silent through three focus cycles', async ({ page }) => {
        test.setTimeout(300_000);
        const db = createWorkflowMockDb();
        let releaseFirstTelegramPreview!: () => void;
        const firstTelegramPreviewGate = new Promise<void>((resolve) => {
            releaseFirstTelegramPreview = resolve;
        });
        let telegramPreviewRequests = 0;
        for (let orderId = 1; orderId <= 10; orderId += 1) {
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

        for (let orderId = 1; orderId <= 10; orderId += 1) {
            await navigateSpa(page, `/orders/edit/${orderId}`);
            await expect(page.locator(`[data-workspace-key="/orders/edit/${orderId}"]`))
                .toHaveCount(1, { timeout: 90_000 });
            if (orderId === 1) {
                const detailsTab = page.getByRole('tab', { name: /^(Детали заказа|Состав)$/ });
                const basicTab = page.getByRole('tab', { name: /^(Основная информация|Обзор)$/ });
                await expect(detailsTab).toBeVisible({ timeout: 90_000 });
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
            }
        }
        await navigateSpa(page, '/orders');
        await expect(page.locator('[data-workspace-key="/orders"]'))
            .toHaveCount(1, { timeout: 90_000 });
        await page.waitForTimeout(750);

        await expect.poll(async () => page.locator('[data-workspace-key][hidden]').count())
            .toBeGreaterThanOrEqual(10);

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
        const additionalTab = page.getByRole('tab', { name: /^(Бирки|Дополнительно)$/ });
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
        releaseManualDownload();
        await page.waitForTimeout(500);
        page.off('download', countDownload);
        expect(downloadEvents).toBe(0);
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

async function navigateSpa(page: Page, path: string): Promise<void> {
    await page.evaluate((nextPath) => {
        window.history.pushState({}, '', nextPath);
        window.dispatchEvent(new PopStateEvent('popstate'));
    }, path);
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
