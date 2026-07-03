import { test, expect } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi, type WorkflowMockDb } from './helpers/mockWorkflowApi';

// Phone-tier specs for the three mocked mobile page surfaces built in Task 5-9
// of mobile-ui-v1: orders list (OrderCardList), order show (OrderShowHeader +
// DetailCardList), payments list (PaymentCardList). Mirrors the mock setup
// pattern from tests/mobile-shell.spec.ts (Task 4) and the seeding pattern from
// tests/frontend-pages-smoke.spec.ts (~lines 216-306): a fresh
// createWorkflowMockDb() populated with one order/detail/payment, then
// setupWorkflowMockApi(page, db) wires auth + GraphQL/runtime-config mocks.
test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    // Optional escape hatch for local worktree runs where port 5173 (the
    // config default) is already bound by a different worktree's dev server.
    // Unset in normal/CI runs, so this is a no-op there.
    ...(process.env.PLAYWRIGHT_BASE_URL ? { baseURL: process.env.PLAYWRIGHT_BASE_URL } : {}),
});

const ORDER_ID = 501;

function seedOrder(db: WorkflowMockDb) {
    db.orders.push({
        order_id: ORDER_ID,
        order_name: 'E2E Мобильный заказ',
        client_id: 1,
        manager_id: 1,
        order_date: '2026-06-01',
        planned_completion_date: '2026-06-10',
        order_status_id: 1,
        payment_status_id: 2,
        production_status_id: 1,
        final_amount: 12000,
        total_amount: 12000,
        paid_amount: 4501,
        discount: 0,
        surcharge: 0,
        priority: 100,
        parts_count: 2,
        total_area: 1.0,
        delete_flag: false,
        version: 1,
        created_at: '2026-06-01T00:00:00+05:00',
        updated_at: '2026-06-01T00:00:00+05:00',
    });
    // Variant B: material_id is always null; sheet_material_type_id is authoritative
    // (matches the seeding pattern in tests/frontend-pages-smoke.spec.ts).
    db.order_details.push({
        detail_id: 1,
        order_id: ORDER_ID,
        detail_number: 1,
        detail_name: 'Фасад мобильный',
        height: 1000,
        width: 500,
        quantity: 2,
        area: 1.0,
        milling_type_id: 1,
        material_id: null,
        sheet_material_type_id: 1,
        delete_flag: false,
        version: 1,
    });
    db.payments.push({
        payment_id: 1,
        order_id: ORDER_ID,
        amount: 4501,
        payment_date: '2026-06-02',
        type_paid_id: 1,
        notes: 'E2E платёж',
        created_at: '2026-06-02T00:00:00+05:00',
        updated_at: '2026-06-02T00:00:00+05:00',
    });
}

function assertNoHorizontalOverflow(page: import('@playwright/test').Page) {
    return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test('/orders phone: no desktop table, order cards visible, tap navigates to order show', async ({ page }) => {
    const db = createWorkflowMockDb();
    seedOrder(db);
    await setupWorkflowMockApi(page, db);

    await page.goto('/orders', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Заказы/i).first()).toBeVisible({ timeout: 30000 });

    // Desktop table must be absent on phone (OrderList branches to OrderCardList).
    await expect(page.locator('.ant-table')).toHaveCount(0);

    // Order cards render as AntD Cards inside the mobile List. (AntD renders the
    // Card directly under ul.ant-list-items here — renderItem returns a bare
    // Card, not <List.Item>, so there is no .ant-list-item wrapper class.)
    const cards = page.locator('.ant-list-items .ant-card');
    await expect(cards.first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('E2E Мобильный заказ')).toBeVisible();

    // Tap the card -> navigates to the order show page (show("orders_view", id, "push")).
    await cards.first().click();
    await expect(page).toHaveURL(new RegExp(`/orders/show/${ORDER_ID}$`));

    expect(await assertNoHorizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test('/orders/show/:id phone: readable header, detail cards, "Ещё действия" menu', async ({ page }) => {
    const db = createWorkflowMockDb();
    seedOrder(db);
    await setupWorkflowMockApi(page, db);

    await page.goto(`/orders/show/${ORDER_ID}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('E2E Мобильный заказ').first()).toBeVisible({ timeout: 30000 });

    // Header rows stack in a column on phone (mobile.css .order-show-header__row).
    // Regression check for the letter-per-line crush this task's brief calls out:
    // the order-name block must retain a real (>200px) width once stacked, not
    // collapse to the intrinsic width of a single glyph column.
    const headerRow = page.locator('.order-show-header__row').first();
    const nameBlock = headerRow.locator('> div').first();
    await expect(nameBlock).toBeVisible();
    const nameBox = await nameBlock.boundingBox();
    expect(nameBox?.width ?? 0).toBeGreaterThan(200);

    // Detail cards render via the mobile-only DetailCardList; desktop details
    // table must be absent.
    await expect(page.locator('.ant-table')).toHaveCount(0);
    const detailCards = page.locator('.ant-card').filter({ hasText: '№1' });
    await expect(detailCards.first()).toBeVisible();

    // "Ещё действия" opens the collapsed actions dropdown menu.
    const moreButton = page.getByRole('button', { name: 'Ещё действия' });
    await expect(moreButton).toBeVisible();
    await moreButton.click();
    await expect(page.getByRole('menuitem', { name: /Печать/ })).toBeVisible();

    expect(await assertNoHorizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test('/payments phone: no desktop table, payment cards visible, amounts formatted', async ({ page }) => {
    const db = createWorkflowMockDb();
    seedOrder(db);
    await setupWorkflowMockApi(page, db);

    await page.goto('/payments', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Платежи/i).first()).toBeVisible({ timeout: 30000 });

    // Desktop table must be absent on phone (PaymentList branches to PaymentCardList).
    await expect(page.locator('.ant-table')).toHaveCount(0);

    const cards = page.locator('.ant-list-items .ant-card');
    await expect(cards.first()).toBeVisible({ timeout: 30000 });

    // Amount formatted via formatMoney: thousands-grouped with a regular space
    // and the ₸ currency symbol (src/pages/orders/mobile/orderCardModel.ts).
    await expect(page.getByText('4 501 ₸')).toBeVisible();

    expect(await assertNoHorizontalOverflow(page)).toBeLessThanOrEqual(0);
});
