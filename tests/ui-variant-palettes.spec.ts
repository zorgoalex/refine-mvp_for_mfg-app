import { expect, test } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi } from './helpers/mockWorkflowApi';

type ModernPaletteVariant = 'line' | 'air';

const variants: Array<{
    variant: ModernPaletteVariant;
    canvas: string;
    primary: string;
    sidebar: string;
    selected: string;
}> = [
    {
        variant: 'line',
        canvas: '#f2f5f5',
        primary: '#246b62',
        sidebar: '#153a37',
        selected: '#f4faf8',
    },
    {
        variant: 'air',
        canvas: '#fff8f2',
        primary: '#315bea',
        sidebar: '#ffffff',
        selected: '#315bea',
    },
];

test.describe('LINE/AIR UI palettes', () => {
    test.setTimeout(60000);

    for (const palette of variants) {
        test(`${palette.variant} boots modern shell with scoped palette tokens`, async ({ page }) => {
            const consoleErrors: string[] = [];
            const pageErrors: string[] = [];

            page.on('console', (message) => {
                if (message.type() === 'error') consoleErrors.push(message.text());
            });
            page.on('pageerror', (error) => pageErrors.push(error.message));

            await setupVariantPaletteMocks(page, palette.variant);

            await page.goto('/orders', { waitUntil: 'domcontentloaded' });
            await expect(page.locator('.ant-layout-content')).toBeVisible({ timeout: 30000 });
            await expect(page.locator('html')).toHaveAttribute('data-ui-variant', palette.variant);
            await expect(page.locator(`.evolution-shell--${palette.variant}`)).toBeVisible();
            await expect(page.locator('.evolution-screen-frame[data-modern-route="orders"]')).toBeVisible();

            if (palette.variant === 'air') {
                await expect(page.locator('.evolution-air-topnav')).toBeVisible({ timeout: 30000 });
                await expect(page.locator('.evolution-air-rail')).toBeVisible({ timeout: 30000 });
                await expect(page.locator('.evolution-sider')).toHaveCount(0);
            } else {
                await expect(page.locator('.evolution-sider')).toBeVisible({ timeout: 30000 });
                await expect(page.locator('.evolution-air-topnav')).toHaveCount(0);
            }

            const tokens = await page.evaluate(() => {
                const styles = getComputedStyle(document.documentElement);
                return {
                    canvas: styles.getPropertyValue('--evo-canvas').trim().toLowerCase(),
                    primary: styles.getPropertyValue('--evo-primary').trim().toLowerCase(),
                    sidebar: styles.getPropertyValue('--evo-sidebar').trim().toLowerCase(),
                    selected: styles.getPropertyValue('--evo-sidebar-selected').trim().toLowerCase(),
                    bodyBg: getComputedStyle(document.body).backgroundColor,
                };
            });

            expect(tokens).toMatchObject({
                canvas: palette.canvas,
                primary: palette.primary,
                sidebar: palette.sidebar,
                selected: palette.selected,
            });
            expect(tokens.bodyBg).not.toBe('rgba(0, 0, 0, 0)');
            expect(pageErrors).toEqual([]);
            expect(consoleErrors.filter((message) => !isAllowedConsoleError(message))).toEqual([]);
        });
    }

    test('AIR keeps route-aware operational screen structure beyond color tokens', async ({ page }) => {
        await setupVariantPaletteMocks(page, 'air');

        await page.goto('/calendar', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.evolution-air-topnav')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('.evolution-air-rail')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('.evolution-screen-frame[data-modern-route="calendar"]')).toBeVisible();
        await expect(page.locator('.calendar-navigation')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('.day-column').first()).toBeVisible({ timeout: 30000 });

        const shellMetrics = await page.evaluate(() => {
            const main = document.querySelector<HTMLElement>('.evolution-shell__main');
            const rail = document.querySelector<HTMLElement>('.evolution-air-rail');
            const topnav = document.querySelector<HTMLElement>('.evolution-air-topnav');
            return {
                mainMarginLeft: main ? getComputedStyle(main).marginLeft : '',
                railWidth: rail ? getComputedStyle(rail).width : '',
                topnavHeight: topnav ? getComputedStyle(topnav).height : '',
            };
        });

        expect(shellMetrics).toMatchObject({
            mainMarginLeft: '64px',
            railWidth: '64px',
            topnavHeight: '74px',
        });
    });

    test('profile exposes all four UI design choices', async ({ page }) => {
        await setupVariantPaletteMocks(page, 'air');

        await page.goto('/profile', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('radio', { name: 'Классический' })).toBeVisible();
        await expect(page.getByRole('radio', { name: 'Новый (Evolutionary)' })).toBeVisible();
        await expect(page.getByRole('radio', { name: 'LINE · Деловой минимализм' })).toBeVisible();
        await expect(page.getByRole('radio', { name: 'AIR · Светлая динамика' })).toBeChecked();
    });
});

async function setupVariantPaletteMocks(page: Parameters<typeof setupWorkflowMockApi>[0], uiVariant: ModernPaletteVariant) {
    await setupWorkflowMockApi(page, createWorkflowMockDb(), { uiVariant });
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

function isAllowedConsoleError(message: string): boolean {
    return (
        message.includes('React Router Future Flag Warning') ||
        message.includes('[antd: Menu] `inlineCollapsed` not control Menu under Sider')
    );
}
