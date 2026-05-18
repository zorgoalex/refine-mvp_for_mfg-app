import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi, type WorkflowMockDb } from './helpers/mockWorkflowApi';

const paymentsCutoverEnabled = process.env.VITE_USE_BACKEND_PAYMENTS === 'true';

test.describe('Payments backend cutover', () => {
    test.skip(!paymentsCutoverEnabled, 'Run with VITE_USE_BACKEND_PAYMENTS=true');
    test.setTimeout(90000);

    test('uses /api/v1 payments for create, update, and delete while keeping Hasura reads', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedOrder(db);

        const graphqlPaymentMutations: string[] = [];
        await setupWorkflowMockApi(page, db, {
            onGraphqlQuery: (query) => {
                if (/\b(?:insert|update|delete)_payments\b/.test(query)) {
                    graphqlPaymentMutations.push(query);
                }
            },
        });
        const api = await setupPaymentsBackendCutoverMock(page, db);

        await page.goto('/payments/create');
        await selectAntdOption(page, formItem(page, 'Заказ'), 'E2E backend payment order');
        await selectAntdOption(page, formItem(page, 'Тип оплаты'), 'Наличные');
        await page.locator('#amount').fill('350');
        await fillDatePicker(page, '#payment_date', '01.05.2026');
        await page.locator('#notes').fill('Backend payment create');
        await page.getByRole('button', { name: 'Сохранить' }).click();

        await expect.poll(() => api.createBodies.length).toBe(1);
        expect(api.createBodies[0]).toMatchObject({
            orderId: 15,
            typePaidId: 1,
            amount: 350,
            paymentDate: '2026-05-01',
            notes: 'Backend payment create',
        });
        expect(graphqlPaymentMutations).toEqual([]);

        await expect(page).toHaveURL(/\/payments\?highlightId=30/);
        await expect(page.getByRole('row', { name: /Backend payment create/ })).toBeVisible({
            timeout: 15000,
        });

        await page.goto('/payments/edit/30');
        await expect(page.getByText('Backend payment create')).toBeVisible({
            timeout: 15000,
        });
        await page.locator('#amount').fill('500');
        await page.locator('#notes').fill('Backend payment update');
        await page.getByRole('button', { name: 'Сохранить' }).click();

        await expect.poll(() => api.updateBodies.length).toBe(1);
        expect(api.updateBodies[0]).toMatchObject({
            amount: 500,
            notes: 'Backend payment update',
        });
        expect(graphqlPaymentMutations).toEqual([]);

        await expect(page).toHaveURL(/\/payments\/show\/30/);
        await expect(page.getByText('Backend payment update')).toBeVisible({
            timeout: 15000,
        });

        const deleteResponse = await page.evaluate(async () => {
            const response = await fetch('/api/v1/payments/30', {
                method: 'DELETE',
                credentials: 'include',
            });
            return response.json();
        });
        expect(deleteResponse).toMatchObject({ paymentId: 30, deleted: true });
        await expect.poll(() => api.deleteIds).toEqual([30]);
        await expect.poll(() => db.payments.some((item) => item.payment_id === 30)).toBe(false);
        expect(graphqlPaymentMutations).toEqual([]);
    });
});

function seedOrder(db: WorkflowMockDb) {
    db.orders.push({
        order_id: 15,
        order_name: 'E2E backend payment order',
        client_id: 1,
        order_status_id: 1,
        payment_status_id: 1,
        production_status_id: 1,
        final_amount: 1000,
        paid_amount: 0,
        order_date: '2026-05-01',
        delete_flag: false,
        version: 1,
    });
}

async function setupPaymentsBackendCutoverMock(page: Page, db: WorkflowMockDb) {
    const api = {
        createBodies: [] as Array<Record<string, unknown>>,
        updateBodies: [] as Array<Record<string, unknown>>,
        deleteIds: [] as number[],
    };

    await page.route(/\/api\/v1\/payments$/, async (route) => {
        if (route.request().method() !== 'POST') {
            await route.fallback();
            return;
        }

        const body = JSON.parse(route.request().postData() || '{}');
        api.createBodies.push(body);

        const payment = {
            payment_id: 30,
            order_id: body.orderId,
            type_paid_id: body.typePaidId,
            amount: body.amount,
            payment_date: body.paymentDate,
            notes: body.notes ?? '',
            ref_key_1c: body.refKey1c ?? null,
            created_by: 1,
            edited_by: null,
            created_at: '2026-05-01T00:00:00.000Z',
            updated_at: null,
        };
        db.payments.push(payment);
        recalculateOrderPayment(db, Number(body.orderId));

        await fulfillJson(route, {
            payment: toBackendPayment(payment),
            order: toBackendOrderSummary(db, Number(body.orderId)),
        });
    });

    await page.route(/\/api\/v1\/payments\/\d+$/, async (route) => {
        const method = route.request().method();
        if (method !== 'PATCH' && method !== 'DELETE') {
            await route.fallback();
            return;
        }

        const paymentId = Number(new URL(route.request().url()).pathname.split('/').pop());
        if (method === 'DELETE') {
            api.deleteIds.push(paymentId);
            const index = db.payments.findIndex((item) => item.payment_id === paymentId);
            const [deleted] = index >= 0 ? db.payments.splice(index, 1) : [];
            if (deleted) {
                recalculateOrderPayment(db, Number(deleted.order_id));
            }

            await fulfillJson(route, {
                paymentId,
                order: toBackendOrderSummary(db, Number(deleted?.order_id ?? 15)),
                deleted: true,
            });
            return;
        }

        const body = JSON.parse(route.request().postData() || '{}');
        api.updateBodies.push(body);

        const payment = db.payments.find((item) => item.payment_id === paymentId);
        if (!payment) {
            await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
            return;
        }

        const previousOrderId = Number(payment.order_id);
        Object.assign(payment, {
            order_id: body.orderId ?? payment.order_id,
            type_paid_id: body.typePaidId ?? payment.type_paid_id,
            amount: body.amount ?? payment.amount,
            payment_date: body.paymentDate ?? payment.payment_date,
            notes: body.notes ?? payment.notes,
            ref_key_1c: body.refKey1c ?? payment.ref_key_1c,
            edited_by: 1,
            updated_at: '2026-05-02T00:00:00.000Z',
        });

        recalculateOrderPayment(db, previousOrderId);
        recalculateOrderPayment(db, Number(payment.order_id));

        await fulfillJson(route, {
            payment: toBackendPayment(payment),
            order: toBackendOrderSummary(db, Number(payment.order_id)),
        });
    });

    return api;
}

function recalculateOrderPayment(db: WorkflowMockDb, orderId: number) {
    const order = db.orders.find((item) => item.order_id === orderId);
    if (!order) return;

    const paidAmount = db.payments
        .filter((item) => item.order_id === orderId)
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);

    order.paid_amount = paidAmount;
    order.payment_date = paidAmount > 0 ? '2026-05-01' : null;
    order.payment_status_id = paidAmount <= 0 ? 1 : paidAmount < Number(order.final_amount || 0) ? 2 : 3;
    order.version = Number(order.version || 0) + 1;
}

function toBackendPayment(payment: Record<string, unknown>) {
    return {
        paymentId: payment.payment_id,
        orderId: payment.order_id,
        typePaidId: payment.type_paid_id,
        amount: payment.amount,
        paymentDate: payment.payment_date,
        notes: payment.notes,
        refKey1c: payment.ref_key_1c,
        createdBy: payment.created_by,
        editedBy: payment.edited_by,
        createdAt: payment.created_at,
        updatedAt: payment.updated_at,
    };
}

function toBackendOrderSummary(db: WorkflowMockDb, orderId: number) {
    const order = db.orders.find((item) => item.order_id === orderId);

    return {
        orderId,
        paidAmount: order?.paid_amount ?? 0,
        debtAmount: Math.max(0, Number(order?.final_amount ?? 0) - Number(order?.paid_amount ?? 0)),
        paymentDate: order?.payment_date ?? null,
        paymentStatusId: order?.payment_status_id ?? 1,
        version: order?.version ?? 0,
    };
}

async function selectAntdOption(page: Page, formItemLocator: Locator, optionText: string) {
    await formItemLocator.locator('.ant-select').first().click();
    const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    await dropdown.getByText(optionText, { exact: true }).click();
}

async function fillDatePicker(page: Page, selector: string, value: string) {
    const input = page.locator(selector);
    await input.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
}

function formItem(page: Page, label: string) {
    return page.locator('.ant-form-item').filter({ hasText: label }).first();
}

async function fulfillJson(route: Route, body: unknown) {
    await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
    });
}
