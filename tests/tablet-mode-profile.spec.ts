import { expect, test } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi } from './helpers/mockWorkflowApi';

test.use({
    viewport: { width: 1600, height: 900 },
    hasTouch: false,
    isMobile: false,
    ...(process.env.PLAYWRIGHT_BASE_URL ? { baseURL: process.env.PLAYWRIGHT_BASE_URL } : {}),
});

test('profile forces and restores tablet layout on a desktop viewport', async ({ page }) => {
    test.setTimeout(90_000);
    const patchBodies: Array<Record<string, unknown>> = [];
    page.on('request', (request) => {
        if (request.method() === 'PATCH' && /\/api\/v1\/me\/preferences$/.test(request.url())) {
            patchBodies.push(JSON.parse(request.postData() || '{}'));
        }
    });
    await setupWorkflowMockApi(page, createWorkflowMockDb(), {
        uiVariant: 'evolution',
        tabletMode: false,
    });

    await page.goto('/profile');
    await expect(page.locator('.evolution-shell')).toHaveAttribute('data-device-tier', 'desktop', { timeout: 30_000 });
    const enable = page.getByRole('button', { name: 'Включить планшетный вид' });
    await expect(enable).toHaveAttribute('aria-pressed', 'false');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        enable.click(),
    ]);

    await expect(page.locator('.evolution-shell')).toHaveAttribute('data-device-tier', 'tablet-landscape', { timeout: 30_000 });
    await expect(page.locator('.evolution-tablet-rail')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Отключить планшетный вид' }))
        .toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('erp.tabletMode.1')))
        .toBe('true');

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.getByRole('button', { name: 'Отключить планшетный вид' }).click(),
    ]);
    await expect(page.locator('.evolution-shell')).toHaveAttribute('data-device-tier', 'desktop', { timeout: 30_000 });
    await expect(page.locator('.evolution-tablet-rail')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Включить планшетный вид' }))
        .toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('erp.tabletMode.1')))
        .toBe('false');
    expect(patchBodies).toEqual([{ tabletMode: true }, { tabletMode: false }]);
});
