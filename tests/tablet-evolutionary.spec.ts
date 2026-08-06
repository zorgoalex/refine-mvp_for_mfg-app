import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import {
    createWorkflowMockDb,
    setupWorkflowMockApi,
    type WorkflowMockDb,
} from './helpers/mockWorkflowApi';

const PRIMARY_VIEWPORT = { width: 1340, height: 800 };
const LOCAL_MOCK_MARKER = 'tablet-touch-local-mock-v1';
const ORDER_ID = 15;

test.use({
    viewport: PRIMARY_VIEWPORT,
    hasTouch: true,
    isMobile: false,
    ...(process.env.PLAYWRIGHT_BASE_URL ? { baseURL: process.env.PLAYWRIGHT_BASE_URL } : {}),
});

test.describe('Evolutionary tablet UI', () => {
    test.setTimeout(240_000);

    test('renders and exercises all non-board reference screens at 1340x800', async ({ page }, testInfo) => {
        const db = createWorkflowMockDb();
        seedTabletData(db);
        const health = collectPageHealth(page);
        await setupGeneralTabletMocks(page, db);

        const states = [
            { name: '01-orders-list', path: '/orders?view=list', family: 'orders', ready: '.orders-table' },
            { name: '02-orders-cards', path: '/orders?view=cards', family: 'orders', ready: '.order-card-list--tablet .ant-card' },
            { name: '06-order-detail', path: `/orders/show/${ORDER_ID}`, family: 'order-detail', readyText: 'Tablet QA 015' },
            { name: '07-order-create', path: '/orders/create', family: 'order-edit', readyText: 'Создание заказа' },
            { name: '08-calendar', path: '/calendar', family: 'calendar', ready: '.calendar-board' },
            { name: '09-clients', path: '/clients', family: 'clients-list', readyText: 'Базовый клиент' },
            { name: '10-client-detail', path: '/clients/show/1', family: 'client-detail', readyText: 'Базовый клиент' },
            { name: '11-payments', path: '/payments', family: 'payments-list', readyText: 'Tablet QA 015' },
            { name: '12-materials', path: '/materials', family: 'materials-list', readyText: 'МДФ' },
            { name: '13-cut', path: '/cut', family: 'cut', ready: '.cut-page-modern' },
            { name: '14-configuration', path: '/configuration', family: 'configuration', ready: '.configuration-tabs-wrap' },
        ] as const;

        const requestedStates = new Set((process.env.TABLET_SCREEN ?? '').split(',').filter(Boolean));
        const selectedStates = process.env.TABLET_POST_ONLY === 'true'
            ? []
            : requestedStates.size > 0
                ? states.filter((state) => requestedStates.has(state.name))
                : states;
        for (const state of selectedStates) {
            await test.step(state.name, async () => {
                await page.goto(state.path, { waitUntil: 'domcontentloaded' });
                await expectTabletShell(page, state.family);
                if ('ready' in state) await expect(page.locator(state.ready).first()).toBeVisible({ timeout: 30_000 });
                if ('readyText' in state) await expect(page.getByText(state.readyText, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
                await expectNoDocumentOverflow(page);
                await expectRepresentativeTouchTargets(page);
                await captureTabletState(page, testInfo, state.name);
            });
        }

        if (!process.env.TABLET_SCREEN) {
            await page.goto('/orders?view=list');
            await expectTabletShell(page, 'orders');
            const viewSwitch = page.locator('.orders-tablet-view-switch');
            await expect(viewSwitch).toBeVisible();
            await viewSwitch.locator('.ant-segmented-item').nth(1).click();
            await expect(page).toHaveURL(/(?:\?|&)view=cards(?:&|$)/);
            await expect(page.locator('.order-card-list--tablet .ant-card').first()).toBeVisible();
            await viewSwitch.locator('.ant-segmented-item').nth(0).click();
            await expect(page).toHaveURL(/(?:\?|&)view=list(?:&|$)/);
            await expect(page.locator('.orders-table')).toBeVisible();

            await page.goto('/clients/show/1', { waitUntil: 'domcontentloaded' });
            await expectTabletShell(page, 'client-detail');
            await expect(page.getByText('Базовый клиент', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
            const content = page.locator('.evolution-shell__content');
            await content.evaluate((element) => {
                const spacer = document.createElement('div');
                spacer.dataset.tabletE2eVerticalContent = 'true';
                spacer.style.height = '900px';
                spacer.style.pointerEvents = 'none';
                element.querySelector('.evolution-screen-frame')?.append(spacer);
            });
            await expect(content).toBeVisible();
            const didScroll = await content.evaluate((element) => {
                const candidates = [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))];
                const target = candidates.find((candidate) => {
                    const style = getComputedStyle(candidate);
                    return candidate.scrollHeight > candidate.clientHeight + 40 && /auto|scroll/.test(style.overflowY);
                });
                if (!target) return false;
                target.dataset.tabletE2eScrollTarget = 'true';
                target.scrollTop = Math.min(120, target.scrollHeight - target.clientHeight);
                target.dispatchEvent(new Event('scroll', { bubbles: true }));
                return target.scrollTop >= 32;
            });
            expect(didScroll, 'client detail exposes a real vertical scroll surface').toBe(true);
            await expect(content).toHaveAttribute('data-tablet-header-compact', 'true');
            await content.evaluate((element) => {
                const target = element.dataset.tabletE2eScrollTarget === 'true'
                    ? element
                    : element.querySelector<HTMLElement>('[data-tablet-e2e-scroll-target="true"]');
                if (!target) return;
                target.scrollTop = 0;
                target.dispatchEvent(new Event('scroll', { bubbles: true }));
                delete target.dataset.tabletE2eScrollTarget;
                element.querySelector('[data-tablet-e2e-vertical-content="true"]')?.remove();
            });
            await expect(content).toHaveAttribute('data-tablet-header-compact', 'false');
        }

        expect(health.pageErrors, 'page errors').toEqual([]);
        expect(health.consoleErrors, 'console errors').toEqual([]);
        expect(health.serverErrors, 'HTTP 5xx responses').toEqual([]);
    });

    test('adapts shell and content across tablet viewports without regressing landscape phones', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedTabletData(db);
        db.app_settings.push({
            setting_id: 1,
            setting_key: 'navigation.resource_visibility_by_role',
            value_json: { 'order-status-board': { admin: false } },
            is_active: true,
        });
        await setupGeneralTabletMocks(page, db);

        await page.addInitScript(() => {
            localStorage.setItem('erp.ui.tablet.orders.view.1', 'board');
        });
        await page.goto('/orders?view=board');
        await expectTabletShell(page, 'orders');
        await expect(page).toHaveURL(/\/orders\?view=list$/, { timeout: 30_000 });
        await expect(page.locator('.orders-table')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.orders-tablet-view-switch .ant-segmented-item')).toHaveCount(2);

        const tabletViewports = [
            { width: 1340, height: 800, tier: 'tablet-landscape' },
            { width: 1280, height: 800, tier: 'tablet-landscape' },
            { width: 1024, height: 768, tier: 'tablet-landscape' },
            { width: 800, height: 1280, tier: 'tablet' },
            { width: 1024, height: 1366, tier: 'tablet' },
        ] as const;
        for (const viewport of tabletViewports) {
            await page.setViewportSize(viewport);
            await page.goto('/orders?view=cards');
            await expect(page.locator('.evolution-shell')).toHaveAttribute('data-device-tier', viewport.tier, { timeout: 30_000 });
            await expect(page.locator('.ui-variant-root')).toHaveAttribute('data-ui-variant', 'evolution', { timeout: 30_000 });
            await expectNoDocumentOverflow(page);
            if (viewport.tier === 'tablet') {
                await expect(page.locator('.evolution-tablet-rail')).toHaveCount(0);
                await expect(page.getByRole('button', { name: /Открыть меню/i })).toBeVisible();
                expect(await page.locator('.evolution-shell__main').evaluate((element) => getComputedStyle(element).marginLeft)).toBe('0px');
            } else {
                const rail = page.locator('.evolution-tablet-rail');
                await expect(rail).toBeVisible();
                expect(Math.round((await rail.boundingBox())?.width ?? 0)).toBe(68);
            }
        }

        for (const viewport of [{ width: 844, height: 390 }, { width: 932, height: 430 }]) {
            await page.setViewportSize(viewport);
            await page.goto('/orders');
            await expect(page.locator('.evolution-shell')).toHaveCount(0);
            await expect(page.locator('.ui-variant-root')).toHaveAttribute('data-ui-variant', 'legacy', { timeout: 30_000 });
            await expect(page.getByRole('heading', { name: 'Заказы' })).toBeVisible({ timeout: 30_000 });
            await expect(page.locator('.ant-table')).toHaveCount(0);
            await expect(page.locator('.ant-list')).toBeVisible({ timeout: 30_000 });
        }
    });

    test('moves order and production cards with real CDP touch input and keeps CNC drag-free', async ({ page, context }, testInfo) => {
        const db = createWorkflowMockDb();
        seedTabletData(db);
        const health = collectPageHealth(page);
        const boardMock = await setupBoardTabletMocks(page, db);

        await page.goto('/order-status-board');
        await expectTabletShell(page, 'status-board');
        await expect(page.locator('[data-status-board-order-id="15"]')).toBeVisible({ timeout: 30_000 });
        await touchDragCard(context, page, 'Tablet QA 015', 'order-2');
        await expect.poll(() => boardMock.orderStatusBodies.length).toBe(1);
        expect(boardMock.orderStatusBodies[0]).toMatchObject({ orderStatusId: 2, version: 3 });
        await expect(page.locator('[data-status-board-column-key="order-2"] [data-status-board-order-id="15"]')).toBeVisible();
        await captureTabletState(page, testInfo, '03-order-board');

        await page.goto('/order-status-board?board=production');
        await expectTabletShell(page, 'status-board');
        await touchDragCard(context, page, 'Tablet QA 015', 'production-2');
        await expect.poll(() => boardMock.productionStatusBodies.length).toBe(1);
        expect(boardMock.productionStatusBodies[0]).toMatchObject({ productionStatusId: 2, version: 4 });
        await expect(page.locator('[data-status-board-column-key="production-2"] [data-status-board-order-id="15"]')).toBeVisible();
        await captureTabletState(page, testInfo, '04-production-board');

        await page.goto('/mdf-work-board');
        await expectTabletShell(page, 'status-board');
        await expect(page.locator('.status-board-columns--cnc .status-board-column')).toHaveCount(5);
        await expect(page.locator('.status-board-card__drag--touch')).toHaveCount(0);
        await captureTabletState(page, testInfo, '05-cnc-board');

        expect(boardMock.unexpectedWrites, 'unmocked writes must fail closed').toEqual([]);
        expect(health.pageErrors, 'page errors').toEqual([]);
        expect(health.consoleErrors, 'console errors').toEqual([]);
        expect(health.serverErrors, 'HTTP 5xx responses').toEqual([]);

        // Regression-only phone check. The legacy Refine layout emits its known
        // upstream AntD Menu deprecation warning; tablet health is asserted above.
        await page.setViewportSize({ width: 932, height: 430 });
        await page.goto('/order-status-board');
        await expect(page.locator('.evolution-shell')).toHaveCount(0);
        await expect(page.locator('[data-status-board-order-id="15"]')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.status-board-card__drag--touch')).toHaveCount(0);
    });
});

async function setupGeneralTabletMocks(page: Page, db: WorkflowMockDb) {
    assertLocalMockBaseUrl();
    await setupWorkflowMockApi(page, db, {
        uiVariant: 'legacy',
        runtimeConfig: {
            backendCut: true,
            backendOrdersRead: true,
            backendProductionActions: false,
            orderStatusBoard: false,
        },
    });
    await page.addInitScript((marker) => {
        sessionStorage.setItem('tablet-e2e-mock', marker);
        const raw = localStorage.getItem('user');
        if (!raw) return;
        const user = JSON.parse(raw);
        user.permissions = Array.from(new Set([...(user.permissions ?? []), 'cut.view']));
        localStorage.setItem('user', JSON.stringify(user));
    }, LOCAL_MOCK_MARKER);
    await setupSharedReadMocks(page);
    await setupOrderReadMocks(page, db);
}

async function setupBoardTabletMocks(page: Page, db: WorkflowMockDb) {
    assertLocalMockBaseUrl();
    await setupWorkflowMockApi(page, db, {
        uiVariant: 'legacy',
        runtimeConfig: {
            backendOrdersRead: true,
            backendProductionActions: true,
            orderStatusBoard: true,
            cncTelegram: true,
        },
    });
    await page.addInitScript((marker) => sessionStorage.setItem('tablet-e2e-mock', marker), LOCAL_MOCK_MARKER);
    await setupSharedReadMocks(page);

    const orderStatusBodies: Array<Record<string, unknown>> = [];
    const productionStatusBodies: Array<Record<string, unknown>> = [];
    const unexpectedWrites: string[] = [];
    let orderStatusId = 1;
    let productionStatusId = 1;
    let version = 3;

    await page.route(/\/api\//, async (route) => {
        const method = route.request().method();
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            unexpectedWrites.push(`${method} ${new URL(route.request().url()).pathname}`);
            await route.abort('blockedbyclient');
            return;
        }
        await route.fallback();
    });

    await page.route(/\/api\/v1\/orders\/status-board(?:\?.*)?$/, async (route) => {
        const url = new URL(route.request().url());
        const board = url.searchParams.get('board') === 'production' ? 'production' : 'order';
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(buildBoardResponse(board, orderStatusId, productionStatusId, version)),
        });
    });
    await page.route(/\/api\/v1\/cnc-telegram\/today(?:\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                workday: '2026-08-05',
                generatedAt: '2026-08-05T10:00:00.000Z',
                columns: ['parsed', 'completed', 'baths', 'baths_ready'].map((key) => ({
                    key,
                    title: key,
                    total: 0,
                    packets: [],
                    baths: [],
                })),
            }),
        });
    });
    await page.route(/\/api\/v1\/orders\/15\/status$/, async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        orderStatusBodies.push(body);
        orderStatusId = Number(body.orderStatusId);
        version += 1;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ order: { orderId: ORDER_ID, orderStatusId, version }, requestId: 'tablet-order-status' }),
        });
    });
    await page.route(/\/api\/v1\/orders\/15\/production-status$/, async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        productionStatusBodies.push(body);
        productionStatusId = Number(body.productionStatusId);
        version += 1;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ order: { orderId: ORDER_ID, productionStatusId, version }, requestId: 'tablet-production-status' }),
        });
    });

    return { orderStatusBodies, productionStatusBodies, unexpectedWrites };
}

async function setupSharedReadMocks(page: Page) {
    await page.route(/\/api\/v1\/notifications(?:\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 }, unreadCount: 0 }),
        });
    });
    await page.route(/\/api\/v1\/cut-config$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ settings: [], paramProfiles: [], renderPresets: [], pdfTemplates: [] }),
        });
    });
    await page.route(/\/api\/v1\/cut-jobs\/detail-last-ready(?:\?.*)?$/, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ details: [] }) });
    });
    await page.route(/\/api\/v1\/cut-jobs\/placements(?:\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ jobs: [], hasArchived: false }),
        });
    });
    await page.route(/\/api\/v1\/cnc-telegram\/orders\/\d+\/cutting-sequences$/, async (route) => {
        const orderId = Number(new URL(route.request().url()).pathname.split('/').at(-2));
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ orderId, sequences: [] }),
        });
    });
    await page.route(/\/api\/v1\/cut-jobs(?:\/sheet-types|\/film-options)?(?:\?.*)?$/, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
}

async function setupOrderReadMocks(page: Page, db: WorkflowMockDb) {
    await page.route(/\/api\/v1\/orders\/\d+(?:\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') {
            await route.fallback();
            return;
        }
        const orderId = Number(new URL(route.request().url()).pathname.split('/').pop());
        const order = db.orders.find((row) => Number(row.order_id) === orderId);
        if (!order) {
            await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Order not found' }) });
            return;
        }
        const details = db.order_details.filter((row) => Number(row.order_id) === orderId);
        const payments = db.payments.filter((row) => Number(row.order_id) === orderId);
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                order: {
                    header: {
                        orderId,
                        orderName: order.order_name,
                        clientId: order.client_id,
                        clientName: 'Базовый клиент',
                        projectId: order.project_id ?? 1,
                        projectCode: order.project_code ?? 'ФК26',
                        orderDate: order.order_date,
                        managerId: order.manager_id,
                        priority: order.priority,
                        orderStatusId: order.order_status_id,
                        orderStatusName: 'Новый',
                        paymentStatusId: order.payment_status_id,
                        paymentStatusName: 'Частично оплачено',
                        productionStatusId: order.production_status_id,
                        productionStatusName: 'Новый',
                        productionStatusFromDetailsEnabled: false,
                        plannedCompletionDate: order.planned_completion_date,
                        discount: order.discount,
                        surcharge: order.surcharge,
                        sheetMaterialTypeId: 1,
                        materialName: 'МДФ 16 мм',
                        version: order.version,
                    },
                    details: details.map((detail) => ({
                        id: detail.detail_id,
                        orderId,
                        detailNumber: detail.detail_number,
                        detailName: detail.detail_name,
                        height: detail.height,
                        width: detail.width,
                        quantity: detail.quantity,
                        area: detail.area,
                        materialId: detail.material_id,
                        sheetMaterialTypeId: detail.sheet_material_type_id,
                        materialName: 'МДФ 16 мм',
                        millingTypeId: detail.milling_type_id,
                        edgeTypeId: detail.edge_type_id,
                        filmId: detail.film_id,
                        detailCost: detail.detail_cost,
                    })),
                    payments: payments.map((payment) => ({
                        id: payment.payment_id,
                        orderId,
                        typePaidId: payment.type_paid_id,
                        typePaidName: 'Наличные',
                        amount: payment.amount,
                        paymentDate: payment.payment_date,
                        notes: payment.notes,
                    })),
                    workshops: [],
                    requirements: [],
                    dowelingLinks: [],
                    primaryGroup: null,
                    groups: [],
                    totals: {
                        totalAmount: order.total_amount,
                        discount: order.discount,
                        surcharge: order.surcharge,
                        finalAmount: order.final_amount,
                        paidAmount: order.paid_amount,
                        debtAmount: Math.max(0, Number(order.final_amount) - Number(order.paid_amount)),
                        partsCount: order.parts_count,
                        totalArea: order.total_area,
                    },
                    version: order.version,
                },
            }),
        });
    });
    await page.route(/\/api\/v1\/orders(?:\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') {
            await route.fallback();
            return;
        }
        const url = new URL(route.request().url());
        const pageNumber = Math.max(1, Number(url.searchParams.get('page') ?? 1));
        const pageSize = Math.max(1, Number(url.searchParams.get('pageSize') ?? 20));
        const search = (url.searchParams.get('search') ?? '').toLowerCase();
        const filtered = db.orders.filter((row) => !search || String(row.order_name).toLowerCase().includes(search));
        const data = filtered.slice((pageNumber - 1) * pageSize, pageNumber * pageSize).map((order) => ({
            orderId: order.order_id,
            orderName: order.order_name,
            clientId: order.client_id,
            clientName: 'Базовый клиент',
            projectId: order.project_id ?? 1,
            projectCode: order.project_code ?? 'ФК26',
            fullNumber: order.order_name,
            orderDate: order.order_date,
            plannedCompletionDate: order.planned_completion_date,
            orderStatusId: order.order_status_id,
            orderStatusName: 'Новый',
            paymentStatusId: order.payment_status_id,
            paymentStatusName: 'Частично оплачено',
            productionStatusId: order.production_status_id,
            productionStatusName: 'Новый',
            totalAmount: order.total_amount,
            finalAmount: order.final_amount,
            paidAmount: order.paid_amount,
            debtAmount: Math.max(0, Number(order.final_amount) - Number(order.paid_amount)),
            partsCount: order.parts_count,
            totalArea: order.total_area,
            managerId: order.manager_id,
            priority: order.priority,
            materialNames: ['МДФ 16 мм'],
            sheetMaterialTypeIds: [1],
            version: order.version,
        }));
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                data,
                pagination: {
                    page: pageNumber,
                    pageSize,
                    total: filtered.length,
                    totalPages: Math.ceil(filtered.length / pageSize),
                },
            }),
        });
    });
}

function buildBoardResponse(board: 'order' | 'production', orderStatusId: number, productionStatusId: number, version: number) {
    const orderStatuses = [
        { id: 1, code: 'new', name: 'Новый', color: '#1677ff' },
        { id: 2, code: 'approved', name: 'Согласован', color: '#13a8a8' },
        { id: 3, code: 'issued', name: 'Выдан', color: '#52c41a' },
    ];
    const productionStatuses = [
        { id: 1, code: 'new', name: 'Новый', color: '#1677ff' },
        { id: 2, code: 'in_progress', name: 'В работе', color: '#fa8c16' },
        { id: 3, code: 'done', name: 'Готово', color: '#52c41a' },
    ];
    const statuses = board === 'order' ? orderStatuses : productionStatuses;
    const currentId = board === 'order' ? orderStatusId : productionStatusId;
    const card = {
        orderId: ORDER_ID,
        orderName: 'Tablet QA 015',
        fullNumber: 'Tablet QA 015',
        clientId: 1,
        clientName: 'Базовый клиент',
        priority: 50,
        plannedCompletionDate: '2026-08-10',
        pastPlannedDate: false,
        orderStatusId,
        orderStatusName: orderStatuses.find((status) => status.id === orderStatusId)?.name ?? 'Новый',
        orderStatusIssuedOrLater: false,
        productionStatusId,
        productionStatusName: productionStatuses.find((status) => status.id === productionStatusId)?.name ?? 'Новый',
        productionStatusFromDetailsEnabled: false,
        paymentStatusId: 2,
        paymentStatusName: 'Частично оплачено',
        finalAmount: 12000,
        paidAmount: 4500,
        debtAmount: 7500,
        partsCount: 3,
        totalArea: 1.5,
        managerId: 1,
        managerName: 'Администратор Тестов',
        updatedAt: '2026-08-05T10:00:00.000Z',
        version,
        canChangeOrderStatus: true,
        canChangeProductionStatus: true,
    };
    return {
        board,
        generatedAt: '2026-08-05T10:00:00.000Z',
        filterKey: `tablet-${board}-${orderStatusId}-${productionStatusId}-${version}`,
        financialsVisible: true,
        columns: statuses.map((status) => ({
            key: `${board}-${status.id}`,
            status: { ...status, sortOrder: status.id * 10, isActive: true },
            total: status.id === currentId ? 1 : 0,
            cards: status.id === currentId ? [card] : [],
            nextCursor: null,
        })),
    };
}

async function touchDragCard(context: BrowserContext, page: Page, orderNumber: string, targetColumnKey: string) {
    const handle = page.getByRole('button', { name: `Удерживайте и перетащите заказ ${orderNumber}` });
    const target = page.locator(`[data-status-board-column-key="${targetColumnKey}"]`);
    await expect(handle).toBeVisible();
    await expect(target).toBeVisible();
    const sourceBox = await handle.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    const start = { x: sourceBox!.x + sourceBox!.width / 2, y: sourceBox!.y + sourceBox!.height / 2 };
    const end = { x: targetBox!.x + targetBox!.width / 2, y: targetBox!.y + 96 };
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...start, id: 1, radiusX: 8, radiusY: 8, force: 1 }],
    });
    await page.waitForTimeout(330);
    await expect(page.getByTestId('status-board-touch-ghost')).toBeVisible();
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ ...end, id: 1, radiusX: 8, radiusY: 8, force: 1 }],
    });
    await expect(target).toHaveAttribute('data-touch-drop-over', 'true');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
}

async function expectTabletShell(page: Page, family: string) {
    const shell = page.locator('.evolution-shell');
    await expect(shell).toHaveAttribute('data-device-tier', 'tablet-landscape', { timeout: 30_000 });
    await expect(page.locator('.ui-variant-root')).toHaveAttribute('data-ui-variant', 'evolution');
    await expect(page.locator('.evolution-tablet-rail')).toBeVisible();
    await expect(page.locator(`.evolution-shell__content[data-modern-route="${family}"]`)).toBeVisible();
}

async function expectNoDocumentOverflow(page: Page) {
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

async function expectRepresentativeTouchTargets(page: Page) {
    const sizes = await page.locator('.evolution-shell__content .ant-btn:visible').evaluateAll((buttons) =>
        buttons.slice(0, 8).map((button) => {
            const box = button.getBoundingClientRect();
            const styles = getComputedStyle(button);
            return {
                width: box.width,
                height: box.height,
                minWidth: styles.minWidth,
                minHeight: styles.minHeight,
                className: button.className,
                label: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
            };
        }),
    );
    for (const size of sizes) {
        expect(size.width, JSON.stringify(size)).toBeGreaterThanOrEqual(43.5);
        expect(size.height, JSON.stringify(size)).toBeGreaterThanOrEqual(43.5);
    }
}

async function captureTabletState(page: Page, testInfo: TestInfo, name: string) {
    const path = testInfo.outputPath('tablet-screens', `${name}-1340x800.png`);
    await mkdir(dirname(path), { recursive: true });
    await page.screenshot({ path, fullPage: false });
    await testInfo.attach(name, { path, contentType: 'image/png' });
}

function collectPageHealth(page: Page) {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const serverErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
        const text = message.text();
        const knownAntdDevelopmentWarning = text.includes('Instance created by `useForm` is not connected to any Form element');
        if (message.type() === 'error' && !knownAntdDevelopmentWarning) consoleErrors.push(text);
    });
    page.on('response', (response) => {
        if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
    });
    return { pageErrors, consoleErrors, serverErrors };
}

function assertLocalMockBaseUrl() {
    const raw = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';
    const hostname = new URL(raw).hostname;
    if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
        throw new Error(`Refusing tablet mutation mocks against non-local host: ${hostname}`);
    }
}

function seedTabletData(db: WorkflowMockDb) {
    for (let phoneId = 2; phoneId <= 14; phoneId += 1) {
        db.client_phones.push({
            phone_id: phoneId,
            client_id: 1,
            phone_number: `+7 701 000 ${String(phoneId).padStart(4, '0')}`,
            phone_type: phoneId % 2 === 0 ? 'mobile' : 'work',
            is_primary: false,
        });
    }
    db.order_statuses.push(
        { order_status_id: 2, order_status_name: 'Согласован', sort_order: 20, color: 'cyan', is_active: true },
        { order_status_id: 3, order_status_name: 'Выдан', sort_order: 30, color: 'green', is_active: true },
    );
    for (let index = 0; index < 26; index += 1) {
        const orderId = ORDER_ID + index;
        db.orders.push({
            order_id: orderId,
            order_name: index === 0 ? 'Tablet QA 015' : `Tablet QA ${String(orderId).padStart(3, '0')}`,
            client_id: 1,
            manager_id: 1,
            created_by: 1,
            order_date: '2026-08-05',
            planned_completion_date: index === 1 ? '2026-07-01' : '2026-08-10',
            order_status_id: 1,
            payment_status_id: 2,
            production_status_id: 1,
            production_status_from_details_enabled: false,
            final_amount: 12000 + index * 100,
            total_amount: 12000 + index * 100,
            paid_amount: 4500,
            discount: 0,
            surcharge: 0,
            priority: index === 2 ? 50 : 100,
            parts_count: 3,
            total_area: 1.5,
            delete_flag: false,
            version: index === 0 ? 3 : 1,
            created_at: '2026-08-05T10:00:00.000Z',
            updated_at: '2026-08-05T10:00:00.000Z',
        });
    }
    db.order_details.push({
        detail_id: 1501,
        order_id: ORDER_ID,
        detail_number: 1,
        detail_name: 'Tablet фасад',
        height: 1000,
        width: 500,
        quantity: 3,
        area: 1.5,
        milling_type_id: 1,
        edge_type_id: 1,
        film_id: 1,
        material_id: null,
        sheet_material_type_id: 1,
        detail_cost: 12000,
        delete_flag: false,
        version: 1,
    });
    db.payments.push({
        payment_id: 1,
        order_id: ORDER_ID,
        amount: 4500,
        payment_date: '2026-08-05',
        type_paid_id: 1,
        notes: 'Tablet payment',
        created_at: '2026-08-05T10:00:00.000Z',
        updated_at: '2026-08-05T10:00:00.000Z',
    });
    db.payments_view.push({
        payment_id: 1,
        order_id: ORDER_ID,
        order_name: 'Tablet QA 015',
        client_id: 1,
        client_name: 'Базовый клиент',
        amount: 4500,
        payment_date: '2026-08-05',
        type_paid_id: 1,
        type_paid_name: 'Наличные',
        notes: 'Tablet payment',
    });
}
