import { expect, test, type Locator, type Page } from '@playwright/test';
import { setupWorkflowMockApi } from './helpers/mockWorkflowApi';

test.describe('Order workflows', () => {
    test.setTimeout(90000);

    test('creates an order with a detail and a payment', async ({ page }) => {
        const db = await setupWorkflowMockApi(page);

        await page.goto('/orders');
        await page.getByRole('button', { name: 'Создать заказ' }).click();

        const orderDialog = page.getByRole('dialog', { name: 'Создание нового заказа' });
        await expect(orderDialog).toBeVisible();

        await orderDialog.getByRole('tab', { name: 'Основная информация' }).click();
        await selectAntdOption(page, orderDialog.locator('.ant-form-item').filter({ hasText: 'Клиент' }).first(), 'Базовый клиент');
        await orderDialog.getByPlaceholder('Введите название заказа').fill('E2E заказ полный workflow');

        await orderDialog.getByRole('tab', { name: 'Детали заказа' }).click();
        const detailsCard = orderDialog.locator('.ant-card').filter({ hasText: 'Всего позиций' }).first();
        await detailsCard.getByRole('button', { name: 'plus' }).click();

        const detailDialog = page.getByRole('dialog', { name: 'Добавить деталь' });
        await detailDialog.locator('#height').fill('600');
        await detailDialog.locator('#width').fill('400');
        await detailDialog.locator('#quantity').fill('2');
        await detailDialog.locator('#milling_cost_per_sqm').fill('10000');
        await detailDialog.getByRole('button', { name: 'Сохранить' }).click();

        await expect(detailsCard.getByText('Всего позиций: 1')).toBeVisible();

        await orderDialog.getByRole('tab', { name: 'Финансы' }).click();
        await orderDialog.getByRole('button', { name: 'Добавить (форма)' }).click();

        const paymentDialog = page.getByRole('dialog', { name: 'Создать оплату' });
        await selectAntdOption(page, paymentDialog.locator('.ant-form-item').filter({ hasText: 'Тип оплаты' }), 'Наличные');
        await paymentDialog.locator('input[role="spinbutton"]').fill('4800');
        await paymentDialog.getByRole('button', { name: 'Создать' }).click();

        await expect(orderDialog.getByText('Всего платежей: 1')).toBeVisible();

        await orderDialog.getByRole('button', { name: 'Сохранить' }).first().click();

        await expect.poll(() => db.orders.length).toBe(1);
        await expect.poll(() => db.order_details.length).toBe(1);
        await expect.poll(() => db.payments.length).toBe(1);

        const order = db.orders[0];
        expect(order).toMatchObject({
            order_name: 'E2E заказ полный workflow',
            client_id: 1,
            total_amount: 4800,
            final_amount: 4800,
            parts_count: 2,
            total_area: 0.48,
        });

        expect(db.order_details[0]).toMatchObject({
            order_id: order.order_id,
            detail_number: 1,
            height: 600,
            width: 400,
            quantity: 2,
            area: 0.48,
            material_id: 1,
            milling_type_id: 1,
            edge_type_id: 1,
            milling_cost_per_sqm: 10000,
            detail_cost: 4800,
        });

        expect(db.payments[0]).toMatchObject({
            order_id: order.order_id,
            type_paid_id: 1,
            amount: 4800,
        });
    });
});

async function selectAntdOption(page: Page, formItem: Locator, optionText: string) {
    await formItem.locator('.ant-select').first().click();
    const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    await dropdown.getByText(optionText, { exact: true }).click();
}
