import { expect, test, type Route } from '@playwright/test';
import { setupWorkflowMockApi } from './helpers/mockWorkflowApi';

test.describe('Frontend runtime config', () => {
    test('loads feature flags before app bootstrap and routes VLM health by runtime flag', async ({ page }) => {
        await setupWorkflowMockApi(page);
        let backendHealthCalls = 0;
        let legacyHealthCalls = 0;

        await page.route(/\/runtime-config\.json$/, async (route) => {
            await fulfillJson(route, {
                apiUrl: '',
                features: {
                    backendVlm: true,
                },
            });
        });

        await page.route(/\/api\/vlm\/health$/, async (route) => {
            legacyHealthCalls += 1;
            await fulfillJson(route, { status: 'error' }, 500);
        });

        await page.route(/\/api\/v1\/vlm\/health$/, async (route) => {
            backendHealthCalls += 1;
            await fulfillJson(route, {
                status: 'ok',
                detailsVisible: true,
                providers: [{ name: 'vlm-api', configured: true, available: true }],
            });
        });

        await page.goto('/configuration');
        await page
            .locator('.ant-tabs-tab-btn', { hasText: 'Анализ фото' })
            .evaluate((element) => (element as HTMLElement).click());

        await expect(page.getByText('Статус VLM API')).toBeVisible();
        await expect(page.getByText('Подключено')).toBeVisible();
        await expect.poll(() => backendHealthCalls).toBeGreaterThan(0);
        expect(legacyHealthCalls).toBe(0);
    });
});

async function fulfillJson(route: Route, body: unknown, status = 200) {
    await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
    });
}
