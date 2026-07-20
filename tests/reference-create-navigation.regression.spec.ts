import { expect, test } from '@playwright/test';
import { setupWorkflowMockApi } from './helpers/mockWorkflowApi';

test.describe('Reference create navigation regression', () => {
    test.setTimeout(120000);

    test('returns an underscore-named resource to its registered list route after save', async ({ page }) => {
        const db = await setupWorkflowMockApi(page);

        await page.goto('/milling-types/create');
        await page.locator('#milling_type_name').fill('E2E-Тест навигации справочника');
        await page.getByRole('button', { name: 'Сохранить' }).click();

        await expect
            .poll(() =>
                db.milling_types.find(
                    (row) => row.milling_type_name === 'E2E-Тест навигации справочника',
                )?.milling_type_id,
            )
            .toBeTruthy();
        await expect(page).toHaveURL(/\/milling-types\?highlightId=\d+$/);
        await expect(
            page.locator('.ant-table-row').filter({ hasText: 'E2E-Тест навигации справочника' }),
        ).toBeVisible({ timeout: 30000 });

        await page.reload();

        await expect.poll(() => new URL(page.url()).pathname).toBe('/milling-types');
        await expect(
            page.locator('.ant-table-row').filter({ hasText: 'E2E-Тест навигации справочника' }),
        ).toBeVisible({ timeout: 30000 });
    });
});
