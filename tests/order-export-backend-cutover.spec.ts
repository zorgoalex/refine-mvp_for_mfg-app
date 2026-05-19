import { expect, test, type Locator, type Page } from '@playwright/test';
import { setupWorkflowMockApi } from './helpers/mockWorkflowApi';

const exportCutoverEnabled = process.env.VITE_USE_BACKEND_ORDER_EXPORT === 'true';

test.describe('Order export backend cutover', () => {
    test.skip(!exportCutoverEnabled, 'Run with VITE_USE_BACKEND_ORDER_EXPORT=true');
    test.setTimeout(90000);

    test('auto-export after order save calls backend export with minimal payload', async ({ page }) => {
        const db = await setupWorkflowMockApi(page, undefined, {
            runtimeConfig: { backendPayments: false },
        });
        let backendExportBody: Record<string, unknown> | null = null;
        let legacyExportCalls = 0;

        await page.route(/\/api\/order-export-to-drive$/, async (route) => {
            legacyExportCalls += 1;
            await route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'legacy export should not be called' }),
            });
        });

        await page.route('**/api/v1/orders/*/export/google-drive', async (route) => {
            backendExportBody = JSON.parse(route.request().postData() || '{}');
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    fileName: 'backend-export.xlsx',
                    folder: 'cutover-smoke',
                    xlsxUrl: 'https://example.test/backend-export.xlsx',
                    externalId: 'file-cutover-smoke',
                }),
            });
        });

        await page.goto('/orders');
        await page.getByRole('button', { name: 'Создать заказ' }).click();

        const orderDialog = page.getByRole('dialog', { name: 'Создание нового заказа' });
        await expect(orderDialog).toBeVisible();

        await orderDialog.getByRole('tab', { name: 'Основная информация' }).click();
        await selectAntdOption(page, orderDialog.locator('.ant-form-item').filter({ hasText: 'Клиент' }).first(), 'Базовый клиент');
        await orderDialog.getByPlaceholder('Введите название заказа').fill('E2E order export cutover');

        await orderDialog.getByRole('tab', { name: 'Детали заказа' }).click();
        const detailsCard = orderDialog.locator('.ant-card').filter({ hasText: 'Всего позиций' }).first();
        await detailsCard.getByRole('button', { name: 'plus' }).click();

        const detailDialog = page.getByRole('dialog', { name: 'Добавить деталь' });
        await detailDialog.locator('#height').fill('600');
        await detailDialog.locator('#width').fill('400');
        await detailDialog.locator('#quantity').fill('2');
        await detailDialog.locator('#milling_cost_per_sqm').fill('10000');
        await detailDialog.getByRole('button', { name: 'Сохранить' }).click();

        await orderDialog.getByRole('tab', { name: 'Финансы' }).click();
        await orderDialog.getByRole('button', { name: 'Добавить (форма)' }).click();
        const paymentDialog = page.getByRole('dialog', { name: 'Создать оплату' });
        await selectAntdOption(page, paymentDialog.locator('.ant-form-item').filter({ hasText: 'Тип оплаты' }), 'Наличные');
        await paymentDialog.locator('input[role="spinbutton"]').fill('4800');
        await paymentDialog.getByRole('button', { name: 'Создать' }).click();

        await orderDialog.getByRole('button', { name: 'Сохранить' }).first().click();

        await expect.poll(() => db.orders.length).toBe(1);
        await expect.poll(() => backendExportBody, { timeout: 30000 }).not.toBeNull();
        expect(legacyExportCalls).toBe(0);
        expect(backendExportBody).toEqual({ format: 'xlsx' });
        expect(backendExportBody).not.toHaveProperty('items');
        expect(backendExportBody).not.toHaveProperty('payments');
        expect(backendExportBody).not.toHaveProperty('clientPhone');
        expect(backendExportBody).not.toHaveProperty('apiKey');
    });
});

async function selectAntdOption(page: Page, formItem: Locator, optionText: string) {
    await formItem.locator('.ant-select').first().click();
    const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    await dropdown.getByText(optionText, { exact: true }).click();
}
