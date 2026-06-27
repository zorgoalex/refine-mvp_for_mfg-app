import { expect, test } from '@playwright/test';

test.describe('Theme preferences auth boundary', () => {
    test('does not load user preferences before authentication', async ({ page, context }) => {
        await context.clearCookies();
        await page.addInitScript(() => {
            localStorage.clear();
            sessionStorage.clear();
        });

        const preferenceRequests: string[] = [];
        await page.route(/\/api\/v1\/me\/preferences$/, async (route) => {
            preferenceRequests.push(route.request().method());
            await route.fulfill({
                status: 401,
                contentType: 'application/json',
                body: JSON.stringify({ message: 'Unauthorized' }),
            });
        });

        await page.route(/\/api\/refresh$/, async (route) => {
            await route.fulfill({
                status: 401,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'Unauthenticated' }),
            });
        });

        await page.route(/\/api\/v1\/auth\/refresh$/, async (route) => {
            await route.fulfill({
                status: 401,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'Unauthenticated' }),
            });
        });

        await page.goto('/login');
        await page.waitForSelector('form', { timeout: 10000 });
        await page.waitForTimeout(500);

        expect(preferenceRequests).toEqual([]);
    });
});
