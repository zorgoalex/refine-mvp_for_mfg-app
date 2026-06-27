import { expect, test, type Page } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi, type WorkflowMockDb } from './helpers/mockWorkflowApi';

const screenshotDir = '.gstack/qa-reports/screenshots';

test.describe('Order dark theme polish', () => {
    test.setTimeout(120000);

    test('keeps order edit and show surfaces dark across header, finance, tabs, and table footers', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedOrder(db);

        await setupWorkflowMockApi(page, db, { themeMode: 'dark' });
        await setupPageMocks(page);
        await page.addInitScript(() => {
            localStorage.setItem('erp.themeMode.1', 'dark');
        });

        await page.goto('/orders/edit/15', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText('Dark theme QA order', { exact: true })).toBeVisible({ timeout: 30000 });
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expectNoLightSurfaces(page, 'orders-edit-basic');
        await page.screenshot({ path: `${screenshotDir}/dark-orders-edit-basic.png`, fullPage: true });

        await page.getByRole('tab', { name: 'Финансы' }).click();
        await expect(page.getByText(/Сумма заказа/)).toBeVisible({ timeout: 30000 });
        await expectNoLightSurfaces(page, 'orders-edit-finance');
        await page.screenshot({ path: `${screenshotDir}/dark-orders-edit-finance.png`, fullPage: true });

        await page.getByRole('tab', { name: 'Детали заказа' }).click();
        await expect(page.locator('.ant-table-summary').first()).toBeVisible({ timeout: 30000 });
        await expectNoLightSurfaces(page, 'orders-edit-details');
        await page.screenshot({ path: `${screenshotDir}/dark-orders-edit-details.png`, fullPage: true });

        await page.goto('/orders/show/15', { waitUntil: 'domcontentloaded' });
        await expect(page.getByText('Dark theme QA order', { exact: true }).first()).toBeVisible({ timeout: 30000 });
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expectNoLightSurfaces(page, 'orders-show-header');

        for (const tabName of ['Проекты', 'Дедлайны', 'Финансы', 'Дополнительная информация']) {
            await page.getByRole('tab', { name: tabName }).click();
            await expect(page.getByRole('tabpanel').last()).toBeVisible({ timeout: 30000 });
            await expectNoLightSurfaces(page, `orders-show-${tabName}`);
        }

        await expect(page.locator('.ant-table-summary').first()).toBeVisible({ timeout: 30000 });
        await page.screenshot({ path: `${screenshotDir}/dark-orders-show-tabs.png`, fullPage: true });
    });
});

async function expectNoLightSurfaces(page: Page, label: string) {
    await expect
        .poll(
            async () =>
                page.evaluate(() => {
                    const viewportHeight = window.innerHeight;
                    const lightElements = [...document.querySelectorAll<HTMLElement>('body *')]
                        .filter((element) => {
                            const rect = element.getBoundingClientRect();
                            if (rect.width < 20 || rect.height < 10 || rect.bottom < 0 || rect.top > viewportHeight) {
                                return false;
                            }
                            if (!element.offsetParent && getComputedStyle(element).position !== 'fixed') {
                                return false;
                            }
                            const background = getComputedStyle(element).backgroundColor;
                            const match = background.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?/);
                            if (!match) return false;
                            const r = Number(match[1]);
                            const g = Number(match[2]);
                            const b = Number(match[3]);
                            const alpha = match[4] === undefined ? 1 : Number(match[4]);
                            if (alpha < 0.9) return false;
                            return r >= 238 && g >= 238 && b >= 238;
                        })
                        .map((element) => {
                            const rect = element.getBoundingClientRect();
                            return {
                                tag: element.tagName.toLowerCase(),
                                className: String(element.className).slice(0, 120),
                                text: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
                                background: getComputedStyle(element).backgroundColor,
                                size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
                            };
                        });

                    return lightElements.slice(0, 10);
                }),
            { message: `${label} has visible near-white surfaces in dark theme` },
        )
        .toEqual([]);
}

async function setupPageMocks(page: Page) {
    await page.route(/\/api\/vlm\/health$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ok: true,
                providerConfigured: false,
                limits: { maxUploadMb: 20, allowedMimeTypes: ['image/jpeg', 'image/png'] },
            }),
        });
    });

    await page.route(/\/api\/v1\/notifications(?:\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                data: [],
                pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 },
                unreadCount: 0,
            }),
        });
    });
}

function seedOrder(db: WorkflowMockDb) {
    db.orders.push({
        order_id: 15,
        order_name: 'Dark theme QA order',
        client_id: 1,
        manager_id: 1,
        order_date: '2026-05-10',
        planned_completion_date: '2026-05-11',
        order_status_id: 1,
        payment_status_id: 2,
        production_status_id: 1,
        production_status_from_details_enabled: true,
        final_amount: 1000,
        total_amount: 1200,
        paid_amount: 300,
        discount: 100,
        surcharge: 0,
        parts_count: 2,
        total_area: 1.2,
        delete_flag: false,
        version: 3,
        created_at: '2026-05-10T00:00:00+05:00',
        updated_at: '2026-05-10T00:00:00+05:00',
    });

    db.order_details.push({
        detail_id: 1,
        order_id: 15,
        detail_number: 1,
        detail_name: 'Темная фасадная деталь',
        height: 1000,
        width: 500,
        quantity: 2,
        area: 1,
        milling_type_id: 1,
        edge_type_id: 1,
        film_id: 1,
        material_id: null,
        sheet_material_type_id: 1,
        milling_cost_per_sqm: 10000,
        detail_cost: 1000,
        production_status_id: 1,
        delete_flag: false,
        version: 1,
    });

    db.payments.push({
        payment_id: 1,
        order_id: 15,
        amount: 300,
        payment_date: '2026-05-10',
        type_paid_id: 1,
        notes: 'Dark theme payment',
        created_at: '2026-05-10T00:00:00+05:00',
        updated_at: '2026-05-10T00:00:00+05:00',
    });

    db.payments_view.push({
        payment_id: 1,
        order_id: 15,
        amount: 300,
        payment_date: '2026-05-10',
        type_paid_id: 1,
        type_paid_name: 'Наличные',
        order_name: 'Dark theme QA order',
        client_id: 1,
        client_name: 'Базовый клиент',
        notes: 'Dark theme payment',
    });
}
