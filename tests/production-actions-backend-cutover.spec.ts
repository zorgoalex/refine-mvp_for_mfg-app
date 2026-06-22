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
const initialCalendarDate = relativeDate(0);
const targetCalendarDate = relativeDate(1);

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

        const targetColumn = page.locator('.day-column').filter({
            hasText: `(${targetCalendarDate.display})`,
        });
        await expect(targetColumn).toBeVisible();
        await card.dragTo(targetColumn);
        await expect.poll(() => api.calendarDateBodies.length).toBe(1);
        expect(api.calendarDateBodies[0]).toMatchObject({
            plannedCompletionDate: targetCalendarDate.iso,
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
        await page.getByText('Статус оплаты').click();
        await page.getByText('Оплачено', { exact: true }).click();
        await expect.poll(() => api.paymentStatusBodies.length).toBe(1);
        expect(api.paymentStatusBodies[0]).toMatchObject({
            paymentStatusId: 3,
            version: 5,
        });

        await card.click({ button: 'right' });
        await page.getByText('Статус производства').click();
        await page.getByText('В работе', { exact: true }).click();
        await expect.poll(() => api.stageActivations.length).toBe(1);
        expect(api.stageActivations[0]).toMatchObject({
            orderId: 15,
            productionStatusId: 2,
            body: { version: 6 },
        });

        await card.click({ button: 'right' });
        await page.getByText('Статус производства').click();
        await page.getByText('В работе', { exact: true }).click();
        await expect.poll(() => api.stageDeactivations.length).toBe(1);
        expect(api.stageDeactivations[0]).toMatchObject({
            orderId: 15,
            productionStatusId: 2,
            body: { version: 7 },
        });

        await page.goto('/orders/edit/15');
        const header = page.locator('[title="ПКМ — изменить статусы"]').filter({
            hasText: 'E2E production action order',
        });
        await expect(header).toBeVisible({ timeout: 30000 });
        await header.click({ button: 'right' });
        await page.getByText('Статус оплаты').click();
        await page.getByText('Частично оплачено', { exact: true }).click();
        await expect.poll(() => api.paymentStatusBodies.length).toBe(2);
        expect(api.paymentStatusBodies[1]).toMatchObject({
            paymentStatusId: 2,
            version: 8,
        });

        await header.click({ button: 'right' });
        await page.getByText('Статус заказа').click();
        await page.getByText('Готов к выдаче', { exact: true }).click();
        await expect.poll(() => api.orderStatusBodies.length).toBe(2);
        expect(api.orderStatusBodies[1]).toMatchObject({
            orderStatusId: 3,
            version: 9,
        });

        expect(graphqlProductionMutations).toEqual([]);
    });

    test('routes manual current production status select to backend without Hasura mutations', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedCalendarOrder(db);
        seedOrderDetail(db);

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
        await page.getByRole('tab', { name: 'Основная информация' }).click();
        await expect(page.getByLabel('Статус производства')).toBeVisible({ timeout: 30000 });
        await page.getByText('Автообновление статусов производства').click();
        await page.getByLabel('Статус производства').click();
        await page.getByText('В работе', { exact: true }).click();

        await expect.poll(() => api.productionStatusBodies.length).toBe(1);
        expect(api.productionStatusBodies[0]).toMatchObject({ productionStatusId: 2, version: 3 });
        expect(db.orders[0].production_status_id).toBe(2);
        expect(db.orders[0].version).toBe(4);
        expect(db.order_details[0].production_status_id).toBe(2);
        expect(graphqlProductionMutations).toEqual([]);
    });

    test('keeps detail statuses aligned when saving after manual current production status change', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedCalendarOrder(db);
        seedOrderDetail(db);

        await setupWorkflowMockApi(page, db, {
            runtimeConfig: { backendOrdersWrite: true },
        });
        const api = await setupProductionActionsBackendMock(page, db);

        await page.goto('/orders/edit/15');
        await page.getByRole('tab', { name: 'Основная информация' }).click();
        await expect(page.getByLabel('Статус производства')).toBeVisible({ timeout: 30000 });
        await page.getByText('Автообновление статусов производства').click();
        await page.getByLabel('Статус производства').click();
        await page.getByText('В работе', { exact: true }).click();
        await expect.poll(() => api.productionStatusBodies.length).toBe(1);

        await page.getByRole('button', { name: /Сохранить/ }).click();
        await expect.poll(() => api.orderUpdateBodies.length).toBe(1);

        expect(api.orderUpdateBodies[0].details).toEqual([
            expect.objectContaining({ id: 1501, productionStatusId: 2 }),
        ]);
        expect(db.order_details[0].production_status_id).toBe(2);
    });

    test('refreshes detail statuses before saving after manual current production status conflict', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedCalendarOrder(db);
        seedOrderDetail(db);

        await setupWorkflowMockApi(page, db, {
            runtimeConfig: { backendOrdersWrite: true },
        });
        const api = await setupProductionActionsBackendMock(page, db);

        await page.goto('/orders/edit/15');
        await page.getByRole('tab', { name: 'Основная информация' }).click();
        await expect(page.getByLabel('Статус производства')).toBeVisible({ timeout: 30000 });

        db.orders[0].version = 4;
        db.orders[0].production_status_id = 2;
        db.orders[0].production_status_from_details_enabled = false;
        db.order_details[0].production_status_id = 2;
        api.conflictNextProductionStatus = true;

        await page.getByText('Автообновление статусов производства').click();
        await page.getByLabel('Статус производства').click();
        await page.getByText('В работе', { exact: true }).click();
        await expect.poll(() => api.productionStatusBodies.length).toBe(1);
        await expect(page.getByText('Данные заказа изменились')).toBeVisible();

        await page.getByPlaceholder('Введите название заказа').fill('E2E production action order conflict save');
        await page.getByRole('button', { name: /Сохранить/ }).click();
        await expect.poll(() => api.orderUpdateBodies.length).toBe(1);

        expect(api.orderUpdateBodies[0].details).toEqual([
            expect.objectContaining({ id: 1501, productionStatusId: 2 }),
        ]);
        expect(db.order_details[0].production_status_id).toBe(2);
    });

    test('allows manager to change own order status and drawn stage, then rejects foreign order', async ({
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
        await setMockFrontendUser(page, {
            id: '99',
            user_id: 99,
            username: 'manager',
            role: 'manager',
            role_id: 10,
        });
        const api = await setupProductionActionsBackendMock(page, db);
        api.forbiddenOrderIds.add(16);

        await page.goto('/orders/edit/15');
        const ownHeader = page.locator('[title="ПКМ — изменить статусы"]').filter({
            hasText: 'E2E production action order',
        });
        await expect(ownHeader).toBeVisible({ timeout: 30000 });

        await ownHeader.click({ button: 'right' });
        await page.getByText('Статус заказа').click();
        await page.getByText('Выдан', { exact: true }).click();
        await expect.poll(() => api.orderStatusBodies.length).toBe(1);
        expect(api.orderStatusBodies[0]).toMatchObject({
            orderStatusId: 2,
            version: 3,
        });

        await ownHeader.click({ button: 'right' });
        await page.getByText('Статус производства').click();
        await page.getByText('Отрисован', { exact: true }).click();
        await expect.poll(() => api.stageActivations.length).toBe(1);
        expect(api.stageActivations[0]).toMatchObject({
            orderId: 15,
            productionStatusId: 4,
            body: { version: 4 },
        });

        await page.goto('/orders/edit/16');
        const foreignHeader = page.locator('[title="ПКМ — изменить статусы"]').filter({
            hasText: 'E2E alternate action order',
        });
        await expect(foreignHeader).toBeVisible({ timeout: 30000 });

        await foreignHeader.click({ button: 'right' });
        await page.getByText('Статус заказа').click();
        await page.getByText('Выдан', { exact: true }).click();
        await expect.poll(() => api.orderStatusBodies.length).toBe(2);
        await expect(page.getByText('Ошибка обновления статуса')).toBeVisible();
        await expect(
            page.getByText('Вы не имеете права менять статус на чужом заказе.'),
        ).toBeVisible();

        expect(db.orders.find((order) => order.order_id === 16)?.order_status_id).toBe(1);
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

    test('routes detail production stage activation to backend without Hasura mutations', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedCalendarOrder(db);
        seedOrderDetail(db);

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
        const response = await callDetailStageEndpoint(page, 1501, 2, {
            idempotencyKey: 'detail-stage-key-1',
            note: 'started cutting',
        });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            order: { orderId: 15 },
            event: { productionEventId: 200, productionStatusId: 2, active: true },
            requestId: 'request-detail-stage-on',
        });
        expect(api.detailStageActivations).toEqual([
            {
                detailId: 1501,
                productionStatusId: 2,
                body: { idempotencyKey: 'detail-stage-key-1', note: 'started cutting' },
            },
        ]);
        expect(db.production_status_events).toContainEqual(
            expect.objectContaining({
                event_id: 200,
                order_id: null,
                detail_id: 1501,
                production_status_id: 2,
                note: 'started cutting',
            }),
        );
        expect(graphqlProductionMutations).toEqual([]);
    });

    test('keeps duplicate detail production stage activation idempotent', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedCalendarOrder(db);
        seedOrderDetail(db);

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
        const first = await callDetailStageEndpoint(page, 1501, 2, {
            idempotencyKey: 'detail-stage-key-duplicate-1',
        });
        const second = await callDetailStageEndpoint(page, 1501, 2, {
            idempotencyKey: 'detail-stage-key-duplicate-2',
        });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(first.body.event).toMatchObject({ productionEventId: 200, active: true });
        expect(second.body.event).toMatchObject({ productionEventId: 200, active: true });
        expect(api.detailStageActivations).toHaveLength(2);
        expect(
            db.production_status_events.filter(
                (event) => event.detail_id === 1501 && event.production_status_id === 2,
            ),
        ).toHaveLength(1);
        expect(graphqlProductionMutations).toEqual([]);
    });

    test('rejects detail production stage activation outside scoped order access', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedCalendarOrder(db);
        seedOrderDetail(db, { detailId: 1601, orderId: 16 });

        const graphqlProductionMutations: string[] = [];
        await setupWorkflowMockApi(page, db, {
            onGraphqlQuery: (query) => {
                if (productionHasuraMutationPattern.test(query)) {
                    graphqlProductionMutations.push(query);
                }
            },
        });
        const api = await setupProductionActionsBackendMock(page, db);
        api.forbiddenOrderIds.add(16);

        await page.goto('/calendar');
        const response = await callDetailStageEndpoint(page, 1601, 2, {
            idempotencyKey: 'detail-stage-forbidden-1',
        });

        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({
            error: { code: 'PERMISSION_DENIED' },
        });
        expect(api.detailStageActivations).toEqual([
            {
                detailId: 1601,
                productionStatusId: 2,
                body: { idempotencyKey: 'detail-stage-forbidden-1' },
            },
        ]);
        expect(db.production_status_events).toEqual([]);
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
    db.production_statuses.push({
        production_status_id: 4,
        production_status_code: 'drawn',
        production_status_name: 'Отрисован',
        sort_order: 25,
        color: 'purple',
        is_active: true,
    });
    db.orders.push({
        order_id: 15,
        order_name: 'E2E production action order',
        client_id: 1,
        order_date: initialCalendarDate.iso,
        planned_completion_date: initialCalendarDate.iso,
        order_status_id: 1,
        payment_status_id: 1,
        production_status_id: 1,
        production_status_from_details_enabled: true,
        final_amount: 1000,
        paid_amount: 0,
        parts_count: 1,
        total_area: 2.5,
        delete_flag: false,
        created_by: 1,
        manager_id: 99,
        version: 3,
    });
    db.orders.push({
        order_id: 16,
        order_name: 'E2E alternate action order',
        client_id: 1,
        order_date: initialCalendarDate.iso,
        planned_completion_date: initialCalendarDate.iso,
        order_status_id: 1,
        payment_status_id: 1,
        production_status_id: 1,
        production_status_from_details_enabled: true,
        final_amount: 1000,
        paid_amount: 0,
        parts_count: 1,
        total_area: 1.5,
        delete_flag: false,
        created_by: 1,
        manager_id: 1,
        version: 3,
    });
}

function seedOrderDetail(
    db: WorkflowMockDb,
    options: { detailId?: number; orderId?: number } = {},
) {
    db.order_details.push({
        detail_id: options.detailId ?? 1501,
        order_id: options.orderId ?? 15,
        detail_number: 1,
        detail_name: 'E2E detail production event',
        height: 100,
        width: 200,
        quantity: 1,
        area: 0.02,
        // Variant B: material_id is always null; sheet_material_type_id is authoritative.
        material_id: null,
        sheet_material_type_id: 1,
        milling_type_id: 1,
        edge_type_id: 1,
        film_id: null,
        milling_cost_per_sqm: 10000,
        detail_cost: 1000,
        priority: 100,
        production_status_id: 1,
        joint_order_id: null,
        note: 'existing detail',
        link_cutting_file: null,
        link_cutting_image_file: null,
        link_cad_file: null,
        link_pdf_file: null,
        ref_key_1c: null,
        delete_flag: false,
        version: 0,
    });
}

async function setupProductionActionsBackendMock(page: Page, db: WorkflowMockDb) {
    const api = {
        calendarDateBodies: [] as Array<Record<string, unknown>>,
        orderStatusBodies: [] as Array<Record<string, unknown>>,
        paymentStatusBodies: [] as Array<Record<string, unknown>>,
        productionStatusBodies: [] as Array<Record<string, unknown>>,
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
        detailStageActivations: [] as Array<{
            detailId: number;
            productionStatusId: number;
            body: Record<string, unknown>;
        }>,
        orderUpdateBodies: [] as Array<Record<string, any>>,
        conflictNextCalendarDate: false,
        conflictNextOrderStatus: false,
        conflictNextProductionStatus: false,
        conflictNextStageActivation: false,
        conflictNextStageDeactivation: false,
        forbiddenOrderIds: new Set<number>(),
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
        if (api.forbiddenOrderIds.has(orderId)) {
            await fulfillApiError(route, 403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия');
            return;
        }
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

    await page.route(/\/api\/v1\/orders\/\d+\/payment-status$/, async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        api.paymentStatusBodies.push(body);
        const orderId = readOrderId(route);
        const order = findOrder(db, orderId);
        if (api.forbiddenOrderIds.has(orderId)) {
            await fulfillApiError(route, 403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия');
            return;
        }
        if (api.conflictNextProductionStatus) {
            api.conflictNextProductionStatus = false;
            await fulfillVersionConflict(route, orderId, body.version, order.version);
            return;
        }
        if (Number(body.version) !== Number(order.version)) {
            await fulfillVersionConflict(route, orderId, body.version, order.version);
            return;
        }
        if (Number(order.payment_status_id) !== Number(body.paymentStatusId)) {
            order.payment_status_id = body.paymentStatusId;
            order.version = Number(order.version) + 1;
        }

        await fulfillJson(route, {
            order: {
                orderId,
                paymentStatusId: order.payment_status_id,
                version: order.version,
            },
            requestId: 'request-payment-status',
        });
    });

    await page.route(/\/api\/v1\/orders\/\d+\/production-status$/, async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        api.productionStatusBodies.push(body);
        const orderId = readOrderId(route);
        const order = findOrder(db, orderId);
        if (api.forbiddenOrderIds.has(orderId)) {
            await fulfillApiError(route, 403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия');
            return;
        }
        if (Number(body.version) !== Number(order.version)) {
            await fulfillVersionConflict(route, orderId, body.version, order.version);
            return;
        }
        if (Number(order.production_status_id) !== Number(body.productionStatusId)) {
            order.production_status_id = body.productionStatusId;
            order.production_status_from_details_enabled = false;
            for (const detail of db.order_details) {
                if (Number(detail.order_id) === orderId && !detail.delete_flag) {
                    detail.production_status_id = body.productionStatusId;
                }
            }
            order.version = Number(order.version) + 1;
        }

        await fulfillJson(route, {
            order: {
                orderId,
                productionStatusId: order.production_status_id,
                version: order.version,
            },
            requestId: 'request-production-status',
        });
    });

    await page.route(/\/api\/v1\/orders\/\d+$/, async (route) => {
        const method = route.request().method();
        const orderId = readOrderId(route);
        if (method === 'GET') {
            await fulfillJson(route, toBackendOrderResponse(db, orderId));
            return;
        }
        if (method !== 'PUT') {
            await route.fallback();
            return;
        }

        const body = JSON.parse(route.request().postData() || '{}');
        api.orderUpdateBodies.push(body);
        const order = findOrder(db, orderId);
        order.version = Number(order.version) + 1;
        for (const detailDto of body.details ?? []) {
            const detail = db.order_details.find((item) => Number(item.detail_id) === Number(detailDto.id));
            if (detail && 'productionStatusId' in detailDto) {
                detail.production_status_id = detailDto.productionStatusId;
            }
        }

        await fulfillJson(route, {
            order: {
                ...toBackendOrderResponse(db, orderId).order,
                version: order.version,
            },
        });
    });

    await page.route(/\/api\/v1\/orders\/\d+\/production-stage-events\/\d+$/, async (route) => {
        const method = route.request().method();
        const body = JSON.parse(route.request().postData() || '{}');
        const orderId = readOrderId(route);
        const productionStatusId = Number(new URL(route.request().url()).pathname.split('/').pop());
        const order = findOrder(db, orderId);
        if (api.forbiddenOrderIds.has(orderId)) {
            await fulfillApiError(route, 403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия');
            return;
        }

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
                event_at: `${initialCalendarDate.iso}T00:00:00.000Z`,
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

    await page.route(/\/api\/v1\/order-details\/\d+\/production-stage-events\/\d+$/, async (route) => {
        const method = route.request().method();
        const body = JSON.parse(route.request().postData() || '{}');
        const detailId = readOrderDetailId(route);
        const productionStatusId = Number(new URL(route.request().url()).pathname.split('/').pop());

        if (method !== 'PUT') {
            await route.fallback();
            return;
        }

        api.detailStageActivations.push({ detailId, productionStatusId, body });
        const detail = findOrderDetail(db, detailId);
        const order = findOrder(db, Number(detail.order_id));
        if (api.forbiddenOrderIds.has(Number(order.order_id))) {
            await fulfillApiError(route, 403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия');
            return;
        }

        const existingEvent = db.production_status_events.find(
            (event) =>
                Number(event.detail_id) === detailId &&
                Number(event.production_status_id) === productionStatusId,
        );
        const event = existingEvent ?? {
            event_id: 200,
            order_id: null,
            detail_id: detailId,
            production_status_id: productionStatusId,
            event_at: `${initialCalendarDate.iso}T00:00:00.000Z`,
            event_by: 1,
            note: body.note ?? null,
            payload: {},
        };
        if (!existingEvent) {
            db.production_status_events.push(event);
        }

        await fulfillJson(route, {
            order: { orderId: order.order_id, version: order.version },
            event: {
                productionEventId: event.event_id,
                productionStatusId,
                active: true,
            },
            requestId: 'request-detail-stage-on',
        });
    });

    return api;
}

function toBackendOrderResponse(db: WorkflowMockDb, orderId: number) {
    const order = findOrder(db, orderId);
    return {
        order: {
            header: {
                orderId,
                orderName: order.order_name,
                clientId: order.client_id,
                orderDate: order.order_date,
                plannedCompletionDate: order.planned_completion_date,
                orderStatusId: order.order_status_id,
                paymentStatusId: order.payment_status_id,
                productionStatusId: order.production_status_id,
                productionStatusFromDetailsEnabled: order.production_status_from_details_enabled,
                finalAmount: order.final_amount,
                paidAmount: order.paid_amount,
                partsCount: order.parts_count,
                totalArea: order.total_area,
                version: order.version,
            },
            details: db.order_details
                .filter((detail) => Number(detail.order_id) === orderId && !detail.delete_flag)
                .map((detail) => ({
                    id: detail.detail_id,
                    orderId,
                    detailNumber: detail.detail_number,
                    detailName: detail.detail_name,
                    height: detail.height,
                    width: detail.width,
                    quantity: detail.quantity,
                    area: detail.area,
                    // Variant B: material_id is always null; sheet_material_type_id is authoritative.
                    materialId: null,
                    sheetMaterialTypeId: detail.sheet_material_type_id ?? null,
                    millingTypeId: detail.milling_type_id,
                    edgeTypeId: detail.edge_type_id,
                    filmId: detail.film_id,
                    millingCostPerSqm: detail.milling_cost_per_sqm,
                    detailCost: detail.detail_cost,
                    priority: detail.priority,
                    productionStatusId: detail.production_status_id,
                    jointOrderId: detail.joint_order_id,
                    note: detail.note,
                    linkCuttingFile: detail.link_cutting_file,
                    linkCuttingImageFile: detail.link_cutting_image_file,
                    linkCadFile: detail.link_cad_file,
                    linkPdfFile: detail.link_pdf_file,
                    refKey1c: detail.ref_key_1c,
                })),
            payments: [],
            workshops: [],
            requirements: [],
            dowelingLinks: [],
            totals: {
                totalAmount: order.final_amount,
                discount: 0,
                surcharge: 0,
                finalAmount: order.final_amount,
                paidAmount: order.paid_amount,
                debtAmount: Number(order.final_amount) - Number(order.paid_amount),
                partsCount: order.parts_count,
                totalArea: order.total_area,
            },
            version: order.version,
        },
    };
}

async function callDetailStageEndpoint(
    page: Page,
    detailId: number,
    productionStatusId: number,
    body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
    return page.evaluate(
        async ({ detailId: nextDetailId, productionStatusId: nextProductionStatusId, body: nextBody }) => {
            const response = await fetch(
                `/api/v1/order-details/${nextDetailId}/production-stage-events/${nextProductionStatusId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(nextBody),
                },
            );

            return {
                status: response.status,
                body: await response.json(),
            };
        },
        { detailId, productionStatusId, body },
    );
}

function readOrderId(route: Route): number {
    const parts = new URL(route.request().url()).pathname.split('/');
    const orderIndex = parts.findIndex((part) => part === 'orders');
    return Number(parts[orderIndex + 1]);
}

function readOrderDetailId(route: Route): number {
    const parts = new URL(route.request().url()).pathname.split('/');
    const detailIndex = parts.findIndex((part) => part === 'order-details');
    return Number(parts[detailIndex + 1]);
}

function findOrder(db: WorkflowMockDb, orderId: number) {
    const order = db.orders.find((item) => item.order_id === orderId);
    if (!order) {
        throw new Error(`Missing order ${orderId}`);
    }

    return order;
}

function findOrderDetail(db: WorkflowMockDb, detailId: number) {
    const detail = db.order_details.find((item) => item.detail_id === detailId);
    if (!detail) {
        throw new Error(`Missing order detail ${detailId}`);
    }

    return detail;
}

function relativeDate(offsetDays: number) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + offsetDays);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return {
        iso: `${year}-${month}-${day}`,
        display: `${day}.${month}.${year}`,
    };
}

async function fulfillJson(route: Route, body: unknown) {
    await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
    });
}

async function fulfillApiError(route: Route, status: number, code: string, message: string) {
    await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({
            error: {
                code,
                message,
                requestId: 'request-forbidden',
            },
        }),
    });
}

async function setMockFrontendUser(page: Page, user: Record<string, unknown>) {
    await page.addInitScript((nextUser) => {
        localStorage.setItem('user', JSON.stringify(nextUser));
    }, user);
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
