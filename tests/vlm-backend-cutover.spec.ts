import { expect, test, type Route } from '@playwright/test';
import { setupWorkflowMockApi } from './helpers/mockWorkflowApi';

const vlmCutoverEnabled = process.env.VITE_USE_BACKEND_VLM === 'true';

test.describe('VLM backend cutover', () => {
    test.skip(!vlmCutoverEnabled, 'Run with VITE_USE_BACKEND_VLM=true');
    test.setTimeout(90000);

    test('configuration health calls backend VLM health endpoint', async ({ page }) => {
        await setupWorkflowMockApi(page);
        let backendHealthCalls = 0;
        let legacyHealthCalls = 0;

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
        await page.getByRole('tab', { name: /Анализ фото/ }).click();

        await expect(page.getByText('Подключено')).toBeVisible();
        await expect.poll(() => backendHealthCalls).toBeGreaterThan(0);
        expect(legacyHealthCalls).toBe(0);
    });

    test('photo import uploads and analyzes through backend with uploadId contract', async ({ page }) => {
        await setupWorkflowMockApi(page);
        const api = {
            uploadCalls: 0,
            analyzeBodies: [] as Array<Record<string, unknown>>,
            legacyCalls: 0,
        };

        await page.route(/\/api\/vlm\/(?:upload|analyze)$/, async (route) => {
            api.legacyCalls += 1;
            await fulfillJson(route, { error: 'legacy VLM endpoint should not be called' }, 500);
        });

        await page.route(/\/api\/v1\/vlm\/upload$/, async (route) => {
            api.uploadCalls += 1;
            const contentType = route.request().headers()['content-type'];
            const postData = route.request().postData();

            expect(contentType).toContain('multipart/form-data');
            if (postData) {
                expect(postData).toContain('purpose');
                expect(postData).toContain('vlm');
            }

            await fulfillJson(
                route,
                {
                    success: true,
                    uploadId: '00000000-0000-4000-8000-000000000001',
                    url: 'https://files.example.test/vlm-cutover.png',
                    key: 'cutover/vlm-cutover.png',
                    size: tinyPng.length,
                    contentType: 'image/png',
                },
                201,
            );
        });

        await page.route(/\/api\/v1\/vlm\/analyze$/, async (route) => {
            const body = JSON.parse(route.request().postData() || '{}');
            api.analyzeBodies.push(body);
            await fulfillJson(route, {
                success: true,
                uploadId: body.uploadId,
                provider: 'zai',
                model: 'vlm-cutover-model',
                result: {
                    items: [
                        {
                            detail_name: 'Фасад VLM',
                            height: 600,
                            width: 400,
                            quantity: 2,
                        },
                    ],
                },
                usage: {
                    inputTokens: 10,
                    outputTokens: 5,
                    cost: null,
                },
            });
        });

        await page.goto('/orders');
        await page.getByRole('button', { name: 'Создать заказ' }).click();

        const orderDialog = page.getByRole('dialog', { name: 'Создание нового заказа' });
        await expect(orderDialog).toBeVisible();
        await orderDialog.getByRole('tab', { name: 'Детали заказа' }).click();
        await orderDialog.getByRole('button', { name: /Импорт/ }).click();
        await page.getByRole('menuitem', { name: /Импорт из фото/ }).click();

        const importDialog = page.getByRole('dialog', { name: /Импорт деталей из фото/ });
        await expect(importDialog).toBeVisible();
        await importDialog.locator('input[type="file"]').setInputFiles({
            name: 'vlm-cutover.png',
            mimeType: 'image/png',
            buffer: tinyPng,
        });
        await importDialog.getByRole('button', { name: 'Анализировать' }).click();

        await expect(importDialog.getByText('Результат анализа')).toBeVisible({ timeout: 15000 });
        await expect.poll(() => api.analyzeBodies.length).toBe(1);
        expect(api.legacyCalls).toBe(0);
        expect(api.uploadCalls).toBe(1);
        expect(api.analyzeBodies[0]).toMatchObject({
            uploadId: '00000000-0000-4000-8000-000000000001',
        });
        expect(api.analyzeBodies[0]).not.toHaveProperty('imageUrl');
        expect(api.analyzeBodies[0]).not.toHaveProperty('image_url');
    });
});

const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64',
);

async function fulfillJson(route: Route, body: unknown, status = 200) {
    await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
    });
}
