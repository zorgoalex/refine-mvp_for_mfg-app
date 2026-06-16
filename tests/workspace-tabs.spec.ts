/**
 * Tabbed workspace E2E (mocked-local, deterministic).
 *
 * Runs against the local mocked Playwright harness (webServer boots `dev:full`
 * automatically unless PLAYWRIGHT_SKIP_WEB_SERVER=true). Auth is bypassed by
 * setupWorkflowMockApi (addInitScript token + route mocks); no stage secrets.
 *
 * Covers the workspace tab-bar contract from the tabbed-workspace plan §Task 8:
 *  - route nav creates a tab and dedupes by pathname
 *  - a `?tab=` deep-link into an order tab is NOT stripped
 *  - closing the active tab activates a neighbour; the last tab falls back to /orders
 *  - refresh restores the open tabs from sessionStorage
 *  - a dirty non-order tab (/configuration ProductionWorkflowTab) prompts on CLOSE
 *    but not on a plain tab SWITCH
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi, type WorkflowMockDb } from './helpers/mockWorkflowApi';

// The workspace tab-bar is the first AntD Tabs in the layout (rendered above the
// page content); page-level Tabs (configuration, order form) come after it.
function workspaceTabs(page: Page): Locator {
    return page.locator('.ant-tabs').first();
}

function workspaceTab(page: Page, name: RegExp | string): Locator {
    return workspaceTabs(page).getByRole('tab', { name });
}

// AntD editable-card close control lives in the `.ant-tabs-tab` wrapper next to
// the `[role=tab]` button, so target the wrapper inside the workspace bar.
function workspaceTabWrapper(page: Page, text: string): Locator {
    return workspaceTabs(page).locator('.ant-tabs-tab').filter({ hasText: text }).first();
}

function seedOrder(db: WorkflowMockDb, orderId: number, orderName: string) {
    db.orders.push({
        order_id: orderId,
        order_name: orderName,
        client_id: 1,
        order_date: '2026-05-22',
        planned_completion_date: '2026-05-25',
        order_status_id: 1,
        payment_status_id: 1,
        production_status_id: 1,
        final_amount: 1000,
        total_amount: 1000,
        paid_amount: 0,
        parts_count: 1,
        total_area: 1.0,
        priority: 100,
        delete_flag: false,
        version: 1,
    });
}

test.describe('Tabbed workspace', () => {
    // Mocked-local only; never a stage/prod-data contour run.
    test.skip(process.env.CALENDAR_STAGE_CANARY === 'true', 'Mocked-local spec, not a stage canary');
    test.setTimeout(90_000);

    test('route navigation creates a tab and dedupes by pathname', async ({ page }) => {
        await setupWorkflowMockApi(page);

        await page.goto('/orders');
        await expect(workspaceTab(page, /Заказы/)).toBeVisible({ timeout: 30_000 });

        await page.goto('/calendar');
        await expect(workspaceTab(page, /Календарь/)).toBeVisible({ timeout: 30_000 });

        // Re-visiting /orders must NOT create a second Заказы tab (dedupe by key).
        await page.goto('/orders');
        await expect(workspaceTab(page, /Заказы/)).toBeVisible();
        expect(await workspaceTab(page, /Заказы/).count()).toBe(1);
        await expect(workspaceTab(page, /Календарь/)).toHaveCount(1);
    });

    test('?tab deep-link into an order tab is not stripped', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedOrder(db, 11195, 'E2E Тест deep-link order');
        await setupWorkflowMockApi(page, db);

        await page.goto('/orders/edit/11195?tab=finance');

        // The mount-time ?tab strip was removed: the query survives load.
        await expect(workspaceTab(page, /Заказ #11195/)).toBeVisible({ timeout: 30_000 });
        await expect(page).toHaveURL(/tab=finance/);
    });

    test('closing the active tab activates the left neighbour', async ({ page }) => {
        await setupWorkflowMockApi(page);

        await page.goto('/orders');
        await expect(workspaceTab(page, /Заказы/)).toBeVisible({ timeout: 30_000 });
        await page.goto('/calendar');
        await expect(workspaceTab(page, /Календарь/)).toBeVisible({ timeout: 30_000 });

        await workspaceTabWrapper(page, 'Календарь').locator('.ant-tabs-tab-remove').click();

        await expect(page).toHaveURL(/\/orders(?:$|\?)/);
        await expect(workspaceTab(page, /Календарь/)).toHaveCount(0);
        await expect(workspaceTab(page, /Заказы/)).toBeVisible();
    });

    test('closing the last tab falls back to /orders', async ({ page }) => {
        await setupWorkflowMockApi(page);

        await page.goto('/calendar');
        await expect(workspaceTab(page, /Календарь/)).toBeVisible({ timeout: 30_000 });
        expect(await workspaceTabs(page).getByRole('tab').count()).toBe(1);

        await workspaceTabWrapper(page, 'Календарь').locator('.ant-tabs-tab-remove').click();

        await expect(page).toHaveURL(/\/orders(?:$|\?)/);
    });

    test('refresh restores open tabs from sessionStorage', async ({ page }) => {
        await setupWorkflowMockApi(page);

        await page.goto('/orders');
        await expect(workspaceTab(page, /Заказы/)).toBeVisible({ timeout: 30_000 });
        await page.goto('/calendar');
        await expect(workspaceTab(page, /Календарь/)).toBeVisible({ timeout: 30_000 });

        await page.reload();

        // Both tabs come back even though only /calendar is the current location —
        // proves the tab list rehydrates from sessionStorage, not just useTabSync.
        await expect(workspaceTab(page, /Календарь/)).toBeVisible({ timeout: 30_000 });
        await expect(workspaceTab(page, /Заказы/)).toBeVisible();
    });

    test('dirty non-order tab prompts on close but not on switch', async ({ page }) => {
        await setupWorkflowMockApi(page);

        await page.goto('/orders');
        await expect(workspaceTab(page, /Заказы/)).toBeVisible({ timeout: 30_000 });

        await page.goto('/configuration');
        await expect(workspaceTab(page, /Конфигурация/)).toBeVisible({ timeout: 30_000 });

        // Open the ProductionWorkflowTab editor and make it dirty.
        await page.getByRole('tab', { name: /Этапы производства/ }).click();
        await expect(page.getByText('Статусы производства и использование в workflow')).toBeVisible({
            timeout: 30_000,
        });
        const letterInput = page.locator('input[maxlength="1"]').first();
        await expect(letterInput).toBeVisible();
        await letterInput.fill('Я');

        // Dirty marker (●) appears on the workspace tab label.
        await expect(workspaceTab(page, /●\s*Конфигурация/)).toBeVisible();

        // SWITCH to another tab → no unsaved-changes prompt.
        await workspaceTab(page, /Заказы/).click();
        await expect(page).toHaveURL(/\/orders(?:$|\?)/);
        await expect(page.getByText('Несохраненные изменения')).toHaveCount(0);

        // CLOSE the dirty tab → prompt appears.
        await workspaceTabWrapper(page, 'Конфигурация').locator('.ant-tabs-tab-remove').click();
        await expect(page.getByText('Несохраненные изменения')).toBeVisible();

        // Confirm close and verify the tab is gone.
        await page.getByRole('button', { name: 'Закрыть' }).click();
        await expect(workspaceTab(page, /Конфигурация/)).toHaveCount(0);
    });
});
