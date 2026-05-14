import { expect, test, type Page, type Route } from '@playwright/test';
import {
    createWorkflowMockDb,
    setupWorkflowMockApi,
    type WorkflowMockDb,
} from './helpers/mockWorkflowApi';

const productionActionsCutoverEnabled =
    process.env.VITE_USE_BACKEND_PRODUCTION_ACTIONS === 'true';

const productionHasuraMutationPattern =
    /(?:^|[^A-Za-z0-9_])(?:update_orders(?:_by_pk)?|insert_production_status_events(?:_one)?|delete_production_status_events(?:_by_pk)?)\s*\(/;

test.describe('Production actions backend cutover', () => {
    test.skip(
        !productionActionsCutoverEnabled,
        'Run with VITE_USE_BACKEND_PRODUCTION_ACTIONS=true',
    );
    test.setTimeout(90000);

    test('routes calendar/header production actions to backend without Hasura mutations', async ({
        page,
    }) => {
        const db = createWorkflowMockDb();
        seedCalendarOrder(db);

        const graphqlProductionMutations: string[] = [];
        await setupWorkflowMockApi(page, db, {
            onGraphqlQuery: (query) => {
                if (productionHasuraMutationPattern.test(query)) {
                    graphqlProductionMutations.push(query);
                }
            },
        });
        const api = await setupProductionActionsBackendMock(page, db);

        await page.goto('/calendar');
        const card = page.locator('.order-card').filter({ hasText: 'E2E production action order' });
        await expect(card).toBeVisible({ timeout: 30000 });

        const targetColumn = page.locator('.day-column').filter({ hasText: '(12.05.2026)' });
        await expect(targetColumn).toBeVisible();
        await card.dragTo(targetColumn);
        await expect.poll(() => api.calendarDateBodies.length).toBe(1);
        expect(api.calendarDateBodies[0]).toMatchObject({
            plannedCompletionDate: '2026-05-12',
            version: 3,
        });

        const checkbox = card.locator('.ant-checkbox-input');
        await checkbox.click({ force: true });
        await expect.poll(() => api.orderStatusBodies.length).toBe(1);
        expect(api.orderStatusBodies[0]).toMatchObject({
            orderStatusId: 2,
            version: 4,
        });

        await card.click({ button: 'right' });
        await expect(page.getByText('Статус оплаты')).toHaveCount(0);
        await page.getByText('Статус производства').click();
        await page.getByText('В работе', { exact: true }).click();
        await expect.poll(() => api.stageActivations.length).toBe(1);
        expect(api.stageActivations[0]).toMatchObject({
            orderId: 15,
            productionStatusId: 2,
            body: { version: 5 },
        });

        await card.click({ button: 'right' });
        await page.getByText('Статус производства').click();
        await page.getByText('В работе', { exact: true }).click();
        await expect.poll(() => api.stageDeactivations.length).toBe(1);
        expect(api.stageDeactivations[0]).toMatchObject({
            orderId: 15,
            productionStatusId: 2,
            body: { version: 6 },
        });

        await page.goto('/orders/edit/15');
        const header = page.locator('[title="ПКМ — изменить статусы"]').filter({
            hasText: 'E2E production action order',
        });
        await expect(header).toBeVisible({ timeout: 30000 });
        await header.click({ button: 'right' });
        await expect(page.getByText('Статус оплаты')).toHaveCount(0);
        await page.getByText('Статус заказа').click();
        await page.getByText('Готов к выдаче', { exact: true }).click();
        await expect.poll(() => api.orderStatusBodies.length).toBe(2);
        expect(api.orderStatusBodies[1]).toMatchObject({
            orderStatusId: 3,
            version: 7,
        });

        expect(graphqlProductionMutations).toEqual([]);
    });

    test('recovers from backend version conflict without Hasura mutation fallback', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedCalendarOrder(db);

        const graphqlProductionMutations: string[] = [];
        await setupWorkflowMockApi(page, db, {
            onGraphqlQuery: (query) => {
                if (productionHasuraMutationPattern.test(query)) {
                    graphqlProductionMutations.push(query);
                }
            },
        });
        const api = await setupProductionActionsBackendMock(page, db);

        await page.goto('/calendar');
        const card = page.locator('.order-card').filter({ hasText: 'E2E production action order' });
        await expect(card).toBeVisible({ timeout: 30000 });

        api.conflictNextOrderStatus = true;
        await card.locator('.ant-checkbox-input').click({ force: true });
        await expect.poll(() => api.orderStatusBodies.length).toBe(1);
        await expect(page.getByText('Данные заказа изменились')).toBeVisible();

        expect(db.orders[0].order_status_id).toBe(1);
        expect(graphqlProductionMutations).toEqual([]);
    });

    test('does not leak optimistic stage state between calendar orders', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedCalendarOrder(db);

        await setupWorkflowMockApi(page, db);
        const api = await setupProductionActionsBackendMock(page, db);

        await page.goto('/calendar');
        const firstCard = page.locator('.order-card').filter({ hasText: 'E2E production action order' });
        const secondCard = page.locator('.order-card').filter({ hasText: 'E2E alternate action order' });
        await expect(firstCard).toBeVisible({ timeout: 30000 });
        await expect(secondCard).toBeVisible();

        await firstCard.click({ button: 'right' });
        await page.getByText('Статус производства').click();
        await page.getByText('В работе', { exact: true }).click();
        await expect.poll(() => api.stageActivations.length).toBe(1);

        await secondCard.click({ button: 'right' });
        await page.getByText('Статус производства').click();
        const secondOrderStageItem = page.locator('.ant-menu-item').filter({ hasText: 'В работе' }).last();
        await expect(secondOrderStageItem.locator('.anticon-check')).toHaveCount(0);
    });

    test('refreshes order header state after backend version conflict', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedCalendarOrder(db);

        const graphqlProductionMutations: string[] = [];
        await setupWorkflowMockApi(page, db, {
            onGraphqlQuery: (query) => {
                if (productionHasuraMutationPattern.test(query)) {
                    graphqlProductionMutations.push(query);
                }
            },
        });
        const api = await setupProductionActionsBackendMock(page, db);

        await page.goto('/orders/edit/15');
        const header = page.locator('[title="ПКМ — изменить статусы"]').filter({
            hasText: 'E2E production action order',
        });
        await expect(header).toBeVisible({ timeout: 30000 });

        db.orders[0].version = 4;
        api.conflictNextOrderStatus = true;
        await header.click({ button: 'right' });
        await page.getByText('Статус заказа').click();
        await page.getByText('Выдан', { exact: true }).click();
        await expect.poll(() => api.orderStatusBodies.length).toBe(1);
        await expect(page.getByText('Данные заказа изменились')).toBeVisible();

        await header.click({ button: 'right' });
        await page.getByText('Статус заказа').click();
        await page.getByText('Выдан', { exact: true }).click();
        await expect.poll(() => api.orderStatusBodies.length).toBe(2);
        expect(api.orderStatusBodies[1]).toMatchObject({
            orderStatusId: 2,
            version: 4,
        });

        expect(graphqlProductionMutations).toEqual([]);
    });

    test('keeps calendar version cache aligned after backend no-op status response', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedCalendarOrder(db);

        const graphqlProductionMutations: string[] = [];
        await setupWorkflowMockApi(page, db, {
            onGraphqlQuery: (query) => {
                if (productionHasuraMutationPattern.test(query)) {
                    graphqlProductionMutations.push(query);
                }
            },
        });
        const api = await setupProductionActionsBackendMock(page, db);

        await page.goto('/calendar');
        const card = page.locator('.order-card').filter({ hasText: 'E2E production action order' });
        await expect(card).toBeVisible({ timeout: 30000 });

        await card.click({ button: 'right' });
        await page.getByText('Статус заказа').click();
        await page.getByText('Новый', { exact: true }).click();
        await expect.poll(() => api.orderStatusBodies.length).toBe(1);
        expect(api.orderStatusBodies[0]).toMatchObject({
            orderStatusId: 1,
            version: 3,
        });
        expect(db.orders[0].version).toBe(3);

        await card.locator('.ant-checkbox-input').click({ force: true });
        await expect.poll(() => api.orderStatusBodies.length).toBe(2);
        expect(api.orderStatusBodies[1]).toMatchObject({
            orderStatusId: 2,
            version: 3,
        });
        expect(db.orders[0].version).toBe(4);
        expect(graphqlProductionMutations).toEqual([]);
    });

    test('serializes rapid order-header backend status and stage commands', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedCalendarOrder(db);

        const graphqlProductionMutations: string[] = [];
        await setupWorkflowMockApi(page, db, {
            onGraphqlQuery: (query) => {
                if (productionHasuraMutationPattern.test(query)) {
                    graphqlProductionMutations.push(query);
                }
            },
        });
        const api = await setupProductionActionsBackendMock(page, db);
        api.delayNextOrderStatusMs = 500;

        await page.goto('/orders/edit/15');
        const header = page.locator('[title="ПКМ — изменить статусы"]').filter({
            hasText: 'E2E production action order',
        });
        await expect(header).toBeVisible({ timeout: 30000 });

        await header.click({ button: 'right' });
        await page.getByText('Статус заказа').click();
        await page.getByText('Выдан', { exact: true }).click();

        await header.click({ button: 'right' });
        await page.getByText('Статус производства').click();
        await page.getByText('В работе', { exact: true }).click();

        await expect.poll(() => api.orderStatusBodies.length).toBe(1);
        await expect.poll(() => api.stageActivations.length).toBe(1);
        expect(api.orderStatusBodies[0]).toMatchObject({
            orderStatusId: 2,
            version: 3,
        });
        expect(api.stageActivations[0]).toMatchObject({
            orderId: 15,
            productionStatusId: 2,
            body: { version: 4 },
        });
        expect(graphqlProductionMutations).toEqual([]);
    });

    test('uses current stage override state for rapid same-stage toggles', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedCalendarOrder(db);

        const graphqlProductionMutations: string[] = [];
        await setupWorkflowMockApi(page, db, {
            onGraphqlQuery: (query) => {
                if (productionHasuraMutationPattern.test(query)) {
                    graphqlProductionMutations.push(query);
                }
            },
        });
        const api = await setupProductionActionsBackendMock(page, db);
        api.delayNextStageActivationMs = 500;

        await page.goto('/calendar');
        const card = page.locator('.order-card').filter({ hasText: 'E2E production action order' });
        await expect(card).toBeVisible({ timeout: 30000 });

        await card.click({ button: 'right' });
        await page.getByText('Статус производства').click();
        await page.getByText('В работе', { exact: true }).click();

        await card.click({ button: 'right' });
        await page.getByText('Статус производства').click();
        await page.getByText('В работе', { exact: true }).click();

        await expect.poll(() => api.stageActivations.length).toBe(1);
        await expect.poll(() => api.stageDeactivations.length).toBe(1);
        expect(api.stageActivations[0]).toMatchObject({
            orderId: 15,
            productionStatusId: 2,
            body: { version: 3 },
        });
        expect(api.stageDeactivations[0]).toMatchObject({
            orderId: 15,
            productionStatusId: 2,
            body: { version: 4 },
        });
        expect(graphqlProductionMutations).toEqual([]);
    });
});

function seedCalendarOrder(db: WorkflowMockDb) {
    db.order_statuses.push(
        {
            order_status_id: 2,
            order_status_name: 'Выдан',
            sort_order: 20,
            color: 'green',
            is_active: true,
        },
        {
            order_status_id: 3,
            order_status_name: 'Готов к выдаче',
            sort_order: 30,
            color: 'orange',
            is_active: true,
        },
    );
    db.orders.push({
        order_id: 15,
        order_name: 'E2E production action order',
        client_id: 1,
        order_date: '2026-05-10',
        planned_completion_date: '2026-05-11',
        order_status_id: 1,
        payment_status_id: 1,
        production_status_id: 1,
        final_amount: 1000,
        paid_amount: 0,
        parts_count: 1,
        total_area: 2.5,
        delete_flag: false,
        version: 3,
    });
    db.orders.push({
        order_id: 16,
        order_name: 'E2E alternate action order',
        client_id: 1,
        order_date: '2026-05-10',
        planned_completion_date: '2026-05-11',
        order_status_id: 1,
        payment_status_id: 1,
        production_status_id: 1,
        final_amount: 1000,
        paid_amount: 0,
        parts_count: 1,
        total_area: 1.5,
        delete_flag: false,
        version: 3,
    });
}

async function setupProductionActionsBackendMock(page: Page, db: WorkflowMockDb) {
    const api = {
        calendarDateBodies: [] as Array<Record<string, unknown>>,
        orderStatusBodies: [] as Array<Record<string, unknown>>,
        stageActivations: [] as Array<{
            orderId: number;
            productionStatusId: number;
            body: Record<string, unknown>;
        }>,
        stageDeactivations: [] as Array<{
            orderId: number;
            productionStatusId: number;
            body: Record<string, unknown>;
        }>,
        conflictNextCalendarDate: false,
        conflictNextOrderStatus: false,
        conflictNextStageActivation: false,
        conflictNextStageDeactivation: false,
        delayNextOrderStatusMs: 0,
        delayNextStageActivationMs: 0,
    };

    await page.route(/\/api\/v1\/orders\/\d+\/calendar-date$/, async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        api.calendarDateBodies.push(body);
        const orderId = readOrderId(route);
        const order = findOrder(db, orderId);
        if (api.conflictNextCalendarDate) {
            api.conflictNextCalendarDate = false;
            await fulfillVersionConflict(route, orderId, body.version, order.version);
            return;
        }
        if (Number(body.version) !== Number(order.version)) {
            await fulfillVersionConflict(route, orderId, body.version, order.version);
            return;
        }

        order.planned_completion_date = body.plannedCompletionDate;
        order.version = Number(order.version) + 1;

        await fulfillJson(route, {
            order: {
                orderId,
                plannedCompletionDate: order.planned_completion_date,
                version: order.version,
            },
            requestId: 'request-calendar',
        });
    });

    await page.route(/\/api\/v1\/orders\/\d+\/status$/, async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        api.orderStatusBodies.push(body);
        const orderId = readOrderId(route);
        const order = findOrder(db, orderId);
        if (api.conflictNextOrderStatus) {
            api.conflictNextOrderStatus = false;
            await fulfillVersionConflict(route, orderId, body.version, order.version);
            return;
        }
        if (Number(body.version) !== Number(order.version)) {
            await fulfillVersionConflict(route, orderId, body.version, order.version);
            return;
        }
        if (api.delayNextOrderStatusMs > 0) {
            const delayMs = api.delayNextOrderStatusMs;
            api.delayNextOrderStatusMs = 0;
            await delay(delayMs);
        }
        if (Number(order.order_status_id) === Number(body.orderStatusId)) {
            await fulfillJson(route, {
                order: {
                    orderId,
                    orderStatusId: order.order_status_id,
                    version: order.version,
                },
                requestId: 'request-status-noop',
            });
            return;
        }

        order.order_status_id = body.orderStatusId;
        order.version = Number(order.version) + 1;

        await fulfillJson(route, {
            order: {
                orderId,
                orderStatusId: order.order_status_id,
                version: order.version,
            },
            requestId: 'request-status',
        });
    });

    await page.route(/\/api\/v1\/orders\/\d+\/production-stage-events\/\d+$/, async (route) => {
        const method = route.request().method();
        const body = JSON.parse(route.request().postData() || '{}');
        const orderId = readOrderId(route);
        const productionStatusId = Number(new URL(route.request().url()).pathname.split('/').pop());
        const order = findOrder(db, orderId);

        if (method === 'PUT') {
            api.stageActivations.push({ orderId, productionStatusId, body });
            if (api.conflictNextStageActivation) {
                api.conflictNextStageActivation = false;
                await fulfillVersionConflict(route, orderId, body.version, order.version);
                return;
            }
            if (Number(body.version) !== Number(order.version)) {
                await fulfillVersionConflict(route, orderId, body.version, order.version);
                return;
            }
            if (api.delayNextStageActivationMs > 0) {
                const delayMs = api.delayNextStageActivationMs;
                api.delayNextStageActivationMs = 0;
                await delay(delayMs);
            }

            const event = {
                event_id: 100,
                order_id: orderId,
                detail_id: null,
                production_status_id: productionStatusId,
                event_at: '2026-05-11T00:00:00.000Z',
            };
            db.production_status_events.push(event);
            order.version = Number(order.version) + 1;

            await fulfillJson(route, {
                order: { orderId, version: order.version },
                event: {
                    productionEventId: event.event_id,
                    productionStatusId,
                    active: true,
                },
                requestId: 'request-stage-on',
            });
            return;
        }

        if (method === 'DELETE') {
            api.stageDeactivations.push({ orderId, productionStatusId, body });
            if (api.conflictNextStageDeactivation) {
                api.conflictNextStageDeactivation = false;
                await fulfillVersionConflict(route, orderId, body.version, order.version);
                return;
            }
            if (Number(body.version) !== Number(order.version)) {
                await fulfillVersionConflict(route, orderId, body.version, order.version);
                return;
            }

            db.production_status_events = db.production_status_events.filter(
                (event) =>
                    event.order_id !== orderId ||
                    event.production_status_id !== productionStatusId,
            );
            order.version = Number(order.version) + 1;

            await fulfillJson(route, {
                order: { orderId, version: order.version },
                event: { productionEventId: 100, productionStatusId, active: false },
                requestId: 'request-stage-off',
            });
            return;
        }

        await route.fallback();
    });

    return api;
}

function readOrderId(route: Route): number {
    const parts = new URL(route.request().url()).pathname.split('/');
    const orderIndex = parts.findIndex((part) => part === 'orders');
    return Number(parts[orderIndex + 1]);
}

function findOrder(db: WorkflowMockDb, orderId: number) {
    const order = db.orders.find((item) => item.order_id === orderId);
    if (!order) {
        throw new Error(`Missing order ${orderId}`);
    }

    return order;
}

async function fulfillJson(route: Route, body: unknown) {
    await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
    });
}

async function delay(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fulfillVersionConflict(
    route: Route,
    orderId: number,
    expectedVersion: unknown,
    currentVersion: unknown,
) {
    await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
            error: {
                code: 'VERSION_CONFLICT',
                message: 'Order version conflict',
                details: {
                    orderId,
                    expectedVersion,
                    currentVersion,
                },
            },
        }),
    });
}
