import { expect, test, type Page, type Route } from '@playwright/test';

import { createWorkflowMockDb, setupWorkflowMockApi } from './helpers/mockWorkflowApi';
import {
    cleanupPerformanceCaptureArtifacts,
    retainPrivacySafePerformanceArtifacts,
} from './helpers/performanceArtifactPrivacy';

const PRIMARY_START_TARGET_MS = 800;
const HARD_LOAD_CONSTRAINED_CEILING_MS = 800;
const INSTRUMENTED_ARTIFACT_SANITY_CEILING_MS = 2_500;

test.describe('order primary early fetch', () => {
    test('starts list/show primary reads before lazy route modules and keeps one request', async ({
        page,
    }) => {
        test.setTimeout(120_000);
        const db = createWorkflowMockDb();
        db.orders_view.push(createOrderViewRow(15));
        const orderRequestPaths: string[] = [];
        const pageErrors: string[] = [];
        page.on('request', (request) => {
            const url = new URL(request.url());
            if (url.pathname.includes('/orders')) {
                orderRequestPaths.push(url.pathname.replace(/\/orders\/[^/]+$/, '/orders/:id'));
            }
        });
        page.on('pageerror', (error) => pageErrors.push(error.message));

        let listPrimaryCount = 0;
        let showPrimaryCount = 0;
        let editPrimaryCount = 0;
        let formDataPrimaryCount = 0;
        let resolveListPrimary!: () => void;
        let resolveShowPrimary!: () => void;
        let listPrimaryAt = 0;
        let showPrimaryAt = 0;
        let editPrimaryAt = 0;
        let formDataPrimaryAt = 0;
        const listPrimarySeen = new Promise<void>((resolve) => {
            resolveListPrimary = resolve;
        });
        const showPrimarySeen = new Promise<void>((resolve) => {
            resolveShowPrimary = resolve;
        });

        await setupWorkflowMockApi(page, db, {
            runtimeConfig: false,
        });
        await page.route(/\/runtime-config\.json$/, (route) => fulfillRuntimeConfig(route));
        await page.route(/\/api\/v1\/orders(?:\?.*)?$/, async (route) => {
            if (route.request().method() !== 'GET') return route.fallback();
            listPrimaryCount += 1;
            listPrimaryAt ||= Date.now();
            resolveListPrimary();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    data: [createOrderListItem(15)],
                    pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
                }),
            });
        });
        await page.route(/\/api\/v1\/orders\/15$/, async (route) => {
            if (route.request().method() !== 'GET') return route.fallback();
            showPrimaryCount += 1;
            showPrimaryAt ||= Date.now();
            resolveShowPrimary();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ order: createOrderDto(15) }),
            });
        });
        await page.route(/\/api\/v1\/orders\/form-data$/, async (route) => {
            if (route.request().method() !== 'GET') return route.fallback();
            formDataPrimaryCount += 1;
            formDataPrimaryAt ||= Date.now();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(createOrderFormData()),
            });
        });
        await page.route(/\/api\/v1\/orders\/23$/, async (route) => {
            if (route.request().method() !== 'GET') return route.fallback();
            editPrimaryCount += 1;
            editPrimaryAt ||= Date.now();
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ order: createOrderDto(23) }),
            });
        });

        // Warm only the application shell. The orders route modules remain lazy.
        await page.goto('/login', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('input[autocomplete="username"]')).toBeVisible({
            timeout: 90_000,
        });
        expect(await page.evaluate(() => Boolean(localStorage.getItem('access_token')))).toBe(true);

        let listPrimaryBeforeModuleRelease = false;
        let listModuleIntercepted = false;
        await page.route(/\/src\/pages\/orders\/list\.tsx(?:\?.*)?$/, async (route) => {
            listModuleIntercepted = true;
            listPrimaryBeforeModuleRelease = await waitForPrimaryBeforeRelease(listPrimarySeen);
            await route.continue();
        });

        const internalListNavigationStartedAt = Date.now();
        await navigateSpa(page, '/orders');
        await expect.poll(() => listPrimaryCount).toBe(1);
        const internalListRequestStartMs = listPrimaryAt - internalListNavigationStartedAt;
        if (listModuleIntercepted) expect(listPrimaryBeforeModuleRelease).toBe(true);
        expect(internalListRequestStartMs).toBeLessThan(PRIMARY_START_TARGET_MS);
        await page.waitForTimeout(250);
        expect(listPrimaryCount).toBe(1);

        listPrimaryCount = 0;
        listPrimaryAt = 0;
        const hardNavigationStartedAt = Date.now();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect.poll(() => listPrimaryCount).toBe(1);
        const hardListPrimaryRequestStartMs = listPrimaryAt - hardNavigationStartedAt;
        expect(hardListPrimaryRequestStartMs).toBeLessThan(
            HARD_LOAD_CONSTRAINED_CEILING_MS,
        );
        await expectPrimaryBeforeApp(page, ['/api/v1/orders']);
        await page.waitForTimeout(250);
        expect(listPrimaryCount).toBe(1);

        let showPrimaryBeforeModuleRelease = false;
        let showModuleIntercepted = false;
        await page.route(/\/src\/pages\/orders\/show\.tsx(?:\?.*)?$/, async (route) => {
            showModuleIntercepted = true;
            showPrimaryBeforeModuleRelease = await waitForPrimaryBeforeRelease(showPrimarySeen);
            await route.continue();
        });

        const internalNavigationStartedAt = Date.now();
        await navigateSpa(page, '/orders/show/15');
        await expect.poll(() => showPrimaryCount).toBe(1);
        if (showModuleIntercepted) expect(showPrimaryBeforeModuleRelease).toBe(true);
        const internalShowPrimaryRequestStartMs = showPrimaryAt - internalNavigationStartedAt;
        expect(internalShowPrimaryRequestStartMs).toBeLessThan(
            PRIMARY_START_TARGET_MS,
        );
        await page.waitForTimeout(250);
        expect(showPrimaryCount).toBe(1);

        showPrimaryCount = 0;
        showPrimaryAt = 0;
        const hardShowNavigationStartedAt = Date.now();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect.poll(() => showPrimaryCount).toBe(1);
        const hardShowPrimaryRequestStartMs = showPrimaryAt - hardShowNavigationStartedAt;
        expect(hardShowPrimaryRequestStartMs).toBeLessThan(HARD_LOAD_CONSTRAINED_CEILING_MS);
        await expectPrimaryBeforeApp(page, ['/api/v1/orders/15']);

        const internalEditNavigationStartedAt = Date.now();
        await navigateSpa(page, '/orders/edit/23');
        await expect.poll(() => editPrimaryCount).toBe(1);
        await expect.poll(() => formDataPrimaryCount).toBe(1);
        const internalEditPrimaryRequestStartMs = editPrimaryAt - internalEditNavigationStartedAt;
        const internalFormDataPrimaryRequestStartMs = formDataPrimaryAt - internalEditNavigationStartedAt;
        expect(internalEditPrimaryRequestStartMs).toBeLessThan(PRIMARY_START_TARGET_MS);
        expect(internalFormDataPrimaryRequestStartMs).toBeLessThan(PRIMARY_START_TARGET_MS);

        editPrimaryCount = 0;
        formDataPrimaryCount = 0;
        editPrimaryAt = 0;
        formDataPrimaryAt = 0;
        const hardEditNavigationStartedAt = Date.now();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect.poll(() => editPrimaryCount).toBe(1);
        await expect.poll(() => formDataPrimaryCount).toBe(1);
        const hardEditPrimaryRequestStartMs = editPrimaryAt - hardEditNavigationStartedAt;
        const hardFormDataPrimaryRequestStartMs = formDataPrimaryAt - hardEditNavigationStartedAt;
        expect(hardEditPrimaryRequestStartMs).toBeLessThan(HARD_LOAD_CONSTRAINED_CEILING_MS);
        expect(hardFormDataPrimaryRequestStartMs).toBeLessThan(HARD_LOAD_CONSTRAINED_CEILING_MS);
        await expectPrimaryBeforeApp(page, [
            '/api/v1/orders/23',
            '/api/v1/orders/form-data',
        ]);
        await page.waitForTimeout(250);
        expect(editPrimaryCount).toBe(1);
        expect(formDataPrimaryCount).toBe(1);

        console.log(JSON.stringify({
            hardListPrimaryRequestStartMs,
            hardShowPrimaryRequestStartMs,
            hardEditPrimaryRequestStartMs,
            hardFormDataPrimaryRequestStartMs,
            internalListPrimaryRequestStartMs: internalListRequestStartMs,
            internalShowPrimaryRequestStartMs,
            internalEditPrimaryRequestStartMs,
            internalFormDataPrimaryRequestStartMs,
            listPrimaryCount,
            showPrimaryCount,
            editPrimaryCount,
            formDataPrimaryCount,
            listModuleIntercepted,
            listPrimaryBeforeModuleRelease,
            showModuleIntercepted,
            showPrimaryBeforeModuleRelease,
            orderRequestPaths,
            pageErrors,
        }));
        expect(pageErrors).toEqual([]);
    });

    test('captures privacy-safe warm hard-list evidence', async ({ browser }, testInfo) => {
        test.skip(process.env.ORDER_PRIMARY_ARTIFACT_CAPTURE !== 'true');
        test.setTimeout(120_000);
        const harPath = process.env.ORDER_PRIMARY_HAR_PATH;
        if (!harPath) throw new Error('ORDER_PRIMARY_HAR_PATH is required for artifact capture');
        const rawHarPath = `${harPath}.raw`;
        const tracePath = testInfo.outputPath('trace.zip');
        await cleanupPerformanceCaptureArtifacts({
            rawHarPath,
            safeHarPath: harPath,
            tracePath,
        });
        const context = await browser.newContext({
            baseURL: 'http://localhost:5173',
            recordHar: { path: rawHarPath, content: 'omit', mode: 'full' },
        });
        const page = await context.newPage();
        let tracingStarted = false;
        const db = createWorkflowMockDb();
        const pageErrors: string[] = [];
        let listPrimaryCount = 0;
        let listPrimaryAt = 0;

        try {
            page.on('pageerror', (error) => pageErrors.push(error.message));
            await setupWorkflowMockApi(page, db, {
                runtimeConfig: false,
                authUser: {
                    id: 'synthetic-actor',
                    username: 'synthetic-artifact-user',
                    role: 'admin',
                    permissions: ['orders.view'],
                },
            });
            await page.route(/\/runtime-config\.json$/, (route) => fulfillRuntimeConfig(route));
            await page.route(/\/api\/v1\/orders(?:\?.*)?$/, async (route) => {
                if (route.request().method() !== 'GET') return route.fallback();
                listPrimaryCount += 1;
                listPrimaryAt ||= Date.now();
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        data: [],
                        pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
                    }),
                });
            });
            // Keep retained trace/HAR free of auth material before Playwright
            // creates a network request. Mock endpoints do not need credentials;
            // authSession/cohort readiness remains unchanged in application memory.
            await page.addInitScript(() => {
                const originalFetch = window.fetch.bind(window);
                window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
                    const headers = new Headers(input instanceof Request ? input.headers : undefined);
                    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
                    headers.delete('authorization');
                    return originalFetch(input, { ...init, headers });
                };
            });
            await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
            tracingStarted = true;

            await page.goto('/login', { waitUntil: 'domcontentloaded' });
            await expect(page.locator('input[autocomplete="username"]')).toBeVisible({
                timeout: 90_000,
            });
            await navigateSpa(page, '/orders');
            await expect.poll(() => listPrimaryCount).toBe(1);

            listPrimaryCount = 0;
            listPrimaryAt = 0;
            const hardNavigationStartedAt = Date.now();
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect.poll(() => listPrimaryCount).toBe(1);
            const hardListPrimaryRequestStartMs = listPrimaryAt - hardNavigationStartedAt;
            console.log(JSON.stringify({
                contour: 'production-preview-warm-cache-single-leased-cpu-trace-har',
                hardListPrimaryRequestStartMs,
                listPrimaryCount,
                pageErrorCount: pageErrors.length,
            }));
            expect(hardListPrimaryRequestStartMs).toBeLessThan(
                INSTRUMENTED_ARTIFACT_SANITY_CEILING_MS,
            );
            expect(pageErrors).toEqual([]);
        } finally {
            try {
                if (tracingStarted) await context.tracing.stop({ path: tracePath });
                await context.close();
                if (tracingStarted) {
                    await retainPrivacySafePerformanceArtifacts({
                        rawHarPath,
                        safeHarPath: harPath,
                        tracePath,
                    });
                    await testInfo.attach('trace', {
                        path: tracePath,
                        contentType: 'application/zip',
                    });
                } else {
                    await cleanupPerformanceCaptureArtifacts({
                        rawHarPath,
                        safeHarPath: harPath,
                        tracePath,
                    });
                }
            } catch (error) {
                await context.close().catch(() => undefined);
                await cleanupPerformanceCaptureArtifacts({
                    rawHarPath,
                    safeHarPath: harPath,
                    tracePath,
                });
                throw error;
            }
        }
    });
});

async function waitForPrimaryBeforeRelease(primarySeen: Promise<void>): Promise<boolean> {
    return Promise.race([
        primarySeen.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
}

async function navigateSpa(page: Page, path: string): Promise<void> {
    await page.evaluate((nextPath) => {
        window.history.pushState({}, '', nextPath);
        window.dispatchEvent(new PopStateEvent('popstate'));
    }, path);
}

async function fulfillRuntimeConfig(route: Route): Promise<void> {
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
                backendReferences: true,
                orderRealtime: false,
                enableLegacyHasura: true,
            },
            rollouts: {
                orderLifecycleV2: {
                    enabled: true,
                    percent: 100,
                    allocationSalt: 'playwright-stage1',
                    configVersion: 'stage1-pr10-v1',
                },
            },
        }),
    });
}

async function expectPrimaryBeforeApp(page: Page, primaryPaths: string[]): Promise<void> {
    let timings: { appStart?: number; primaryStarts: Array<number | undefined> } = {
        primaryStarts: [],
    };
    await expect.poll(async () => {
        timings = await page.evaluate((expectedPaths) => {
            const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
            const appStart = resources.find((entry) => /\/assets\/App-[^/]+\.js$/.test(new URL(entry.name).pathname))
                ?.startTime;
            const primaryStarts = expectedPaths.map((path) => resources.find((entry) => {
                const url = new URL(entry.name);
                return url.pathname === path;
            })?.startTime);
            return { appStart, primaryStarts };
        }, primaryPaths);
        return timings.appStart !== undefined
            && timings.primaryStarts.every((value) => value !== undefined);
    }).toBe(true);

    expect(timings.appStart).toBeDefined();
    for (const primaryStart of timings.primaryStarts) {
        expect(primaryStart).toBeDefined();
        expect(primaryStart).toBeLessThanOrEqual(timings.appStart!);
    }
}

function createOrderViewRow(orderId: number): Record<string, unknown> {
    return {
        order_id: orderId,
        order_name: 'Performance fixture',
        client_id: 1,
        client_name: 'Базовый клиент',
        order_date: '2026-08-15',
        priority: 100,
        order_status_name: 'Новый',
        payment_status_name: 'Не оплачено',
        final_amount: 0,
        paid_amount: 0,
        parts_count: 0,
        total_area: 0,
        version: 1,
        delete_flag: false,
    };
}

function createOrderListItem(orderId: number): Record<string, unknown> {
    return {
        orderId,
        orderName: 'Performance fixture',
        clientId: 1,
        clientName: 'Базовый клиент',
        orderDate: '2026-08-15',
        priority: 100,
        orderStatusId: 1,
        orderStatusName: 'Новый',
        paymentStatusId: 1,
        paymentStatusName: 'Не оплачено',
        productionStatusId: null,
        productionStatusName: null,
        totalAmount: 0,
        discount: 0,
        surcharge: 0,
        finalAmount: 0,
        paidAmount: 0,
        debtAmount: 0,
        partsCount: 0,
        totalArea: 0,
        updatedAt: '2026-08-15T00:00:00.000Z',
        version: 1,
    };
}

function createOrderDto(orderId: number): Record<string, unknown> {
    return {
        header: {
            orderId,
            orderName: 'Performance fixture',
            clientId: 1,
            orderDate: '2026-08-15',
            orderStatusId: 1,
            paymentStatusId: 1,
            priority: 100,
            version: 1,
        },
        details: [],
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
            partsCount: 0,
            totalArea: 0,
        },
        version: 1,
    };
}

function createOrderFormData(): Record<string, unknown> {
    return {
        clients: [],
        materials: [],
        millingTypes: [],
        edgeTypes: [],
        films: [],
        orderStatuses: [],
        paymentStatuses: [],
        paymentTypes: [],
        productionStatuses: [],
        workshops: [],
        employees: [],
        units: [],
    };
}
