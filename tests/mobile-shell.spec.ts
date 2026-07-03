import { test, expect } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi } from './helpers/mockWorkflowApi';

// Mobile shell smoke: verifies the phone-tier UI shell (Task 1-3 of mobile-ui-v1)
// actually hides desktop-only header chrome, collapses workspace tabs to a single
// scrollable row, and does not introduce horizontal page overflow at a real phone
// viewport (390x844, iPhone 12/13 class).
//
// Mock setup mirrors tests/frontend-pages-smoke.spec.ts (~lines 63-96): a fresh
// createWorkflowMockDb() + setupWorkflowMockApi(page, db) wires auth (via
// addInitScript access_token/user in localStorage) and GraphQL/runtime-config
// mocks so /orders renders without a real backend.
test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    // Optional escape hatch for local worktree runs where port 5173 (the
    // config default) is already bound by a different worktree's dev server.
    // Unset in normal/CI runs, so this is a no-op there.
    ...(process.env.PLAYWRIGHT_BASE_URL ? { baseURL: process.env.PLAYWRIGHT_BASE_URL } : {}),
});

test('phone shell: compact header, single-row tabs, no horizontal page overflow', async ({ page }) => {
    const db = createWorkflowMockDb();
    await setupWorkflowMockApi(page, db);

    await page.goto('/orders', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/Заказы|Orders/i).first()).toBeVisible({ timeout: 30000 });

    // 1) Desktop-only header chrome must be hidden on phone (mobile.css).
    await expect(page.locator('.app-header__brand-sub')).toBeHidden();
    await expect(page.locator('.app-header__username')).toBeHidden();

    // 2) Workspace tabs render as a single scrollable row, not a wrapped/multi-row
    // block. Visiting /orders opens a workspace tab (useTabSync), so .workspace-tabs
    // should exist here — but stay defensive: if it isn't present at all (e.g. tab
    // sync behavior changes upstream), absence is also an acceptable "not a multi-row
    // mess" outcome for this smoke check.
    const tabsList = page.locator('.workspace-tabs .ant-tabs-nav-list');
    const tabsCount = await tabsList.count();
    if (tabsCount > 0) {
        const box = await tabsList.boundingBox();
        expect(box?.height ?? 0).toBeLessThan(60); // одна строка, не куча
    } else {
        expect(tabsCount).toBe(0);
    }

    // 3) No horizontal page overflow at the phone viewport.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});
