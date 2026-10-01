import { expect, test, type Page } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi, type WorkflowMockDb } from './helpers/mockWorkflowApi';

// Presentation-only polish of the «NewLine» variant: the orders list and the order card
// must keep every column, action and section of the other variants.
const shotsDir = process.env.WORKBENCH_SHOTS_DIR;
if (process.env.PLAYWRIGHT_BASE_URL) test.use({ baseURL: process.env.PLAYWRIGHT_BASE_URL });
test.use({ viewport: { width: 1440, height: 900 } });

const ORIGINAL_SECTIONS = ['Группы заказа', 'Дедлайны', 'Финансы', 'Раскрой', 'Дополнительная информация'];

test.describe('Workbench orders polish', () => {
    test.setTimeout(180000);

    test('orders list keeps its columns and actions and shows statuses in full', async ({ page }) => {
        const pageErrors = await openWithVariant(page, 'workbench');

        await page.goto('/orders', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('html')).toHaveAttribute('data-ui-variant', 'workbench');
        const table = page.locator('.orders-table');
        await expect(table.locator('tr[data-row-key="15"]')).toBeVisible({ timeout: 60000 });

        for (const title of ['Заказ', 'Дата заказа', 'Клиент', 'Материал', 'Статус заказа', 'Статус оплаты', 'Этапы', 'Действия']) {
            await expect(table.locator('thead th', { hasText: title }).first()).toBeAttached();
        }
        for (const name of ['Найти', 'Фильтры', 'Создать заказ']) {
            await expect(page.getByRole('button', { name }).first()).toBeVisible();
        }
        await expect(page.getByText('Мои заказы')).toBeVisible();

        // статусы — пилюли с полным текстом, срок — с подсказкой
        const row = table.locator('tr[data-row-key="15"]');
        const pay = row.locator('td.payment-status .wb-pill');
        await pay.scrollIntoViewIfNeeded();
        await expect(pay).toHaveText('Частично оплачен');
        await expect(pay).toHaveAttribute('data-tone', 'warning');
        expect(await pay.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(false);
        await expect(row.locator('td.order-status .wb-pill')).toHaveText('В производстве');
        await expect(row.locator('td.orders-col--planned-date .wb-deadline small')).toHaveText(/через \d+ дн\.|сегодня|завтра|просрочено/);
        expect(await row.locator('td.orders-col--order-date').evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('nowrap');
        await page.locator('.orders-table .ant-table-body, .orders-table .ant-table-content').first().evaluate((element) => { element.scrollLeft = 0; });

        await shot(page, 'orders-list');
        expect(pageErrors).toEqual([]);
    });

    test('order card: «Ход производства» is a collapsed spoiler next to the original sections', async ({ page }) => {
        const pageErrors = await openWithVariant(page, 'workbench');

        await page.goto('/orders/show/15', { waitUntil: 'domcontentloaded' });
        const tabs = page.getByRole('tablist', { name: 'Секции заказа' });
        await expect(tabs).toBeVisible({ timeout: 60000 });

        for (const name of ['Ход производства', ...ORIGINAL_SECTIONS]) {
            await expect(tabs.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'false');
        }
        await expect(page.locator('.order-show-info-panel')).toHaveCount(0);
        await expect(page.locator('.order-production-flow')).toHaveCount(0);

        // шапка «NewLine» несёт те же сведения, что прежняя сводка
        const head = page.locator('.wb-order-head');
        await expect(head.locator('.wb-order-head__number')).toHaveText('Тест-2972');
        await expect(head.locator('.wb-pill').first()).toHaveText('В производстве');
        for (const label of ['Сумма', 'Оплачено', 'Срок выполнения', 'Производство', 'Состав', 'Материал', 'Примечание']) {
            await expect(head.locator('.wb-order-head__label', { hasText: label })).toBeVisible();
        }
        await expect(head).toContainText('скидка');
        await expect(head).toContainText('остаток');
        await expect(head).toContainText('Фасады кухни, срочно к пятнице');
        for (const name of ['Изменить', 'Обновить', 'Печать']) {
            await expect(page.getByRole('button', { name }).first()).toBeVisible();
        }
        await expect(page.locator('.order-show-details-table')).toBeVisible();
        await shot(page, 'order-card');

        await tabs.getByRole('tab', { name: 'Ход производства' }).click();
        const flow = page.locator('.order-production-flow');
        await expect(flow).toBeVisible();
        await expect(flow.locator('.order-production-flow__stage', { hasText: 'Распилен' })).toContainText('2 поз. · 5 шт.');
        await expect(flow.locator('.order-production-flow__stage', { hasText: 'Закатан' })).toContainText('1 поз. · 1 шт.');
        await expect(flow.locator('.order-production-flow__stage', { hasText: 'Упакован' })).toHaveAttribute('data-empty', 'true');
        await expect(flow).toContainText('Всего 3 поз. · 6 шт.');
        await shot(page, 'order-card-flow');

        await tabs.getByRole('tab', { name: 'Ход производства' }).click();
        await expect(flow).toHaveCount(0);

        await tabs.getByRole('tab', { name: 'Финансы' }).click();
        await expect(page.locator('.order-show-info-panel')).toBeVisible();
        await shot(page, 'order-card-finance');
        expect(pageErrors).toEqual([]);
    });

    test('dark theme keeps the card readable', async ({ page }) => {
        await openWithVariant(page, 'workbench', 'dark');

        await page.goto('/orders/show/15', { waitUntil: 'domcontentloaded' });
        const tabs = page.getByRole('tablist', { name: 'Секции заказа' });
        await expect(tabs).toBeVisible({ timeout: 60000 });
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await tabs.getByRole('tab', { name: 'Ход производства' }).click();
        await expect(page.locator('.order-production-flow')).toBeVisible();
        await shot(page, 'order-card-dark');

        await page.goto('/orders', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.orders-table tr[data-row-key="15"]')).toBeVisible({ timeout: 60000 });
        await shot(page, 'orders-list-dark');
    });

    test('other variants keep the original five sections', async ({ page }) => {
        await openWithVariant(page, 'evolution');

        await page.goto('/orders/show/15', { waitUntil: 'domcontentloaded' });
        const tabs = page.getByRole('tablist', { name: 'Секции заказа' });
        await expect(tabs).toBeVisible({ timeout: 60000 });
        await expect(tabs.getByRole('tab')).toHaveText(ORIGINAL_SECTIONS.map((name) => new RegExp(name)));
    });
});

async function shot(page: Page, name: string) {
    if (!shotsDir) return;
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${shotsDir}/${name}.png` });
}

async function openWithVariant(page: Page, uiVariant: 'workbench' | 'evolution', themeMode: 'light' | 'dark' = 'light') {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const db = createWorkflowMockDb();
    seed(db);
    await setupWorkflowMockApi(page, db, { uiVariant, themeMode });
    if (themeMode === 'dark') {
        await page.addInitScript(() => {
            localStorage.setItem('erp.themeMode.1', 'dark');
        });
    }
    await page.route(/\/api\/vlm\/health$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, providerConfigured: false, limits: { maxUploadMb: 20, allowedMimeTypes: ['image/jpeg'] } }),
        });
    });
    await page.route(/\/api\/v1\/notifications(?:\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 }, unreadCount: 0 }),
        });
    });
    return pageErrors;
}

function seed(db: WorkflowMockDb) {
    db.order_statuses.splice(0, db.order_statuses.length,
        { order_status_id: 1, order_status_name: 'Предварительный', sort_order: 10, color: 'blue', is_active: true },
        { order_status_id: 2, order_status_name: 'В производстве', sort_order: 20, color: 'blue', is_active: true },
        { order_status_id: 3, order_status_name: 'Готов к выдаче', sort_order: 30, color: 'green', is_active: true },
    );
    db.payment_statuses.splice(0, db.payment_statuses.length,
        { payment_status_id: 1, payment_status_name: 'Не оплачен', sort_order: 10, color: 'red', is_active: true },
        { payment_status_id: 2, payment_status_name: 'Частично оплачен', sort_order: 20, color: 'orange', is_active: true },
        { payment_status_id: 3, payment_status_name: 'Оплачен', sort_order: 30, color: 'green', is_active: true },
    );
    db.production_statuses.splice(0, db.production_statuses.length,
        { production_status_id: 1, production_status_code: 'new', production_status_name: 'Новый', sort_order: 10, color: 'blue', is_active: true },
        { production_status_id: 2, production_status_code: 'drawn', production_status_name: 'Отрисован', sort_order: 20, color: 'blue', is_active: true },
        { production_status_id: 3, production_status_code: 'cut', production_status_name: 'Распилен', sort_order: 30, color: 'orange', is_active: true },
        { production_status_id: 4, production_status_code: 'sanded', production_status_name: 'Отшлифован', sort_order: 40, color: 'orange', is_active: true },
        { production_status_id: 5, production_status_code: 'laminated', production_status_name: 'Закатан', sort_order: 50, color: 'green', is_active: true },
        { production_status_id: 6, production_status_code: 'packed', production_status_name: 'Упакован', sort_order: 60, color: 'green', is_active: true },
        { production_status_id: 7, production_status_code: 'issued', production_status_name: 'Выдан', sort_order: 70, color: 'green', is_active: true },
    );

    const orders: Array<[number, string, number, number, number, number, number, string]> = [
        [15, 'Тест-2972', 2, 2, 3, 160381, 60000, 'Фасады кухни, срочно к пятнице'],
        [16, 'Тест-2971', 1, 1, 1, 84500, 0, ''],
        [17, 'Тест-2970', 3, 3, 6, 231900, 231900, 'Выдача со склада'],
        [18, 'Тест-2969', 2, 2, 5, 47200, 20000, ''],
        [19, 'Тест-2968', 2, 1, 2, 318640, 0, 'Два цвета плёнки'],
        [20, 'Тест-2967', 1, 3, 1, 12900, 12900, ''],
    ];
    orders.forEach(([orderId, name, orderStatusId, paymentStatusId, productionStatusId, total, paid, notes], index) => {
        db.orders.push({
            order_id: orderId,
            order_name: name,
            client_id: 1,
            manager_id: 1,
            order_date: `2026-09-${String(25 - index).padStart(2, '0')}`,
            planned_completion_date: `2026-10-${String(5 + index).padStart(2, '0')}`,
            order_status_id: orderStatusId,
            payment_status_id: paymentStatusId,
            production_status_id: productionStatusId,
            production_status_from_details_enabled: true,
            final_amount: total,
            total_amount: total + (index === 0 ? 5000 : 0),
            paid_amount: paid,
            discount: index === 0 ? 5000 : 0,
            surcharge: 0,
            parts_count: 6,
            total_area: 4.2,
            priority: index === 0 ? 20 : 100,
            notes,
            delete_flag: false,
            version: 3,
            created_at: '2026-09-25T00:00:00+05:00',
            updated_at: '2026-09-25T00:00:00+05:00',
        });
    });

    const details: Array<[number, number, number, number, number]> = [
        [1, 2005, 495, 2, 3],
        [2, 778, 595, 3, 3],
        [3, 726, 595, 1, 5],
    ];
    details.forEach(([detailId, height, width, quantity, productionStatusId]) => {
        db.order_details.push({
            detail_id: detailId,
            order_id: 15,
            detail_number: detailId,
            detail_name: `Тест фасад ${detailId}`,
            height,
            width,
            quantity,
            area: Number(((height * width * quantity) / 1e6).toFixed(2)),
            milling_type_id: 1,
            edge_type_id: 1,
            film_id: 1,
            material_id: null,
            sheet_material_type_id: 1,
            milling_cost_per_sqm: 16900,
            detail_cost: 10000,
            production_status_id: productionStatusId,
            delete_flag: false,
            version: 1,
        });
    });

    db.payments.push({
        payment_id: 1,
        order_id: 15,
        amount: 60000,
        payment_date: '2026-09-25',
        type_paid_id: 1,
        notes: 'Тест предоплата',
        created_at: '2026-09-25T00:00:00+05:00',
        updated_at: '2026-09-25T00:00:00+05:00',
    });
    db.payments_view.push({
        payment_id: 1,
        order_id: 15,
        amount: 60000,
        payment_date: '2026-09-25',
        type_paid_id: 1,
        type_paid_name: 'Наличные',
        order_name: 'Тест-2972',
        client_id: 1,
        client_name: 'Базовый клиент',
        notes: 'Тест предоплата',
    });
}
