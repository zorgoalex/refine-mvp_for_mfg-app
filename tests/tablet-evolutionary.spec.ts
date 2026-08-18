import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import {
    createWorkflowMockDb,
    setupWorkflowMockApi,
    type WorkflowMockDb,
} from './helpers/mockWorkflowApi';

const PRIMARY_VIEWPORT = { width: 1340, height: 800 };
const REAL_87_TABLET_CSS_VIEWPORT = { width: 1012, height: 429 };
const LOCAL_MOCK_MARKER = 'tablet-touch-local-mock-v1';
const ORDER_ID = 15;

test.use({
    viewport: PRIMARY_VIEWPORT,
    hasTouch: true,
    isMobile: false,
    ...(process.env.PLAYWRIGHT_BASE_URL ? { baseURL: process.env.PLAYWRIGHT_BASE_URL } : {}),
});

test.describe('Evolutionary tablet UI', () => {
    test.setTimeout(240_000);

    test('renders and exercises all non-board reference screens at 1340x800', async ({ page }, testInfo) => {
        const db = createWorkflowMockDb();
        seedTabletData(db);
        const health = collectPageHealth(page);
        await setupGeneralTabletMocks(page, db);

        const states = [
            { name: '01-orders-list', path: '/orders?view=list', family: 'orders', ready: '.orders-table' },
            { name: '02-orders-cards', path: '/orders?view=cards', family: 'orders', ready: '.order-card-list--tablet .ant-card' },
            { name: '06-order-detail', path: `/orders/show/${ORDER_ID}`, family: 'order-detail', readyText: 'Tablet QA 015' },
            { name: '07-order-create', path: '/orders/create', family: 'order-edit', readyText: 'Создание заказа' },
            { name: '08-calendar', path: '/calendar', family: 'calendar', ready: '.calendar-board' },
            { name: '09-clients', path: '/clients', family: 'clients-list', readyText: 'Базовый клиент' },
            { name: '10-client-detail', path: '/clients/show/1', family: 'client-detail', readyText: 'Базовый клиент' },
            { name: '11-payments', path: '/payments', family: 'payments-list', readyText: 'Tablet QA 015' },
            { name: '12-materials', path: '/materials', family: 'materials-list', readyText: 'МДФ' },
            { name: '13-cut', path: '/cut', family: 'cut', ready: '.cut-page-modern' },
            { name: '14-configuration', path: '/configuration', family: 'configuration', ready: '.configuration-tabs-wrap' },
        ] as const;

        const requestedStates = new Set((process.env.TABLET_SCREEN ?? '').split(',').filter(Boolean));
        const selectedStates = process.env.TABLET_POST_ONLY === 'true'
            ? []
            : requestedStates.size > 0
                ? states.filter((state) => requestedStates.has(state.name))
                : states;
        for (const state of selectedStates) {
            await test.step(state.name, async () => {
                await page.goto(state.path, { waitUntil: 'domcontentloaded' });
                await expectTabletShell(page, state.family);
                if ('ready' in state) await expect(page.locator(state.ready).first()).toBeVisible({ timeout: 30_000 });
                if ('readyText' in state) await expect(page.getByText(state.readyText, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
                if (state.name === '02-orders-cards') await expectConfiguredOrderCardStatusColors(page);
                await expectNoDocumentOverflow(page);
                await expectRepresentativeTouchTargets(page);
                await captureTabletState(page, testInfo, state.name);
            });
        }

        if (!process.env.TABLET_SCREEN) {
            await page.goto('/orders?view=list');
            await expectTabletShell(page, 'orders');
            await expect(page.locator('.evolution-header')).toHaveCount(0);
            const landscapeContentBox = await page.locator('.evolution-shell__content').boundingBox();
            expect(landscapeContentBox?.height ?? 0, 'landscape content uses height freed by shell header').toBeGreaterThanOrEqual(748);
            await expect(page.getByRole('button', { name: 'Открыть быстрый переход' })).toHaveCount(0);
            const personalUtilities = page.getByRole('group', { name: 'Персональные действия' });
            await expect(personalUtilities).toBeVisible();
            await expect(personalUtilities.getByRole('button', { name: 'Уведомления' })).toBeVisible();
            await expect(personalUtilities.getByRole('button', { name: 'Сканер бирок' })).toBeVisible();
            const darkThemeButton = personalUtilities.getByRole('button', { name: 'Включить темную тему' });
            await darkThemeButton.click();
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
            await personalUtilities.getByRole('button', { name: 'Включить светлую тему' }).click();
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
            await personalUtilities.getByRole('button', { name: 'Меню пользователя admin' }).click();
            await expect(page.getByRole('menuitem', { name: 'Личный кабинет' })).toBeVisible();
            await page.keyboard.press('Escape');
            const viewSwitch = page.locator('.orders-tablet-view-switch');
            await expect(viewSwitch).toBeVisible();
            await viewSwitch.locator('.ant-segmented-item').nth(1).click();
            await expect(page).toHaveURL(/(?:\?|&)view=cards(?:&|$)/);
            await expect(page.locator('.order-card-list--tablet .ant-card').first()).toBeVisible();
            await viewSwitch.locator('.ant-segmented-item').nth(0).click();
            await expect(page).toHaveURL(/(?:\?|&)view=list(?:&|$)/);
            await expect(page.locator('.orders-table')).toBeVisible();

            await page.goto('/clients/show/1', { waitUntil: 'domcontentloaded' });
            await expectTabletShell(page, 'client-detail');
            await expect(page.getByText('Базовый клиент', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
            const content = page.locator('.evolution-shell__content');
            const shell = page.locator('.evolution-shell');
            const workspaceTabs = page.locator('.evolution-workspace-tabs');
            const pageHeading = page.locator('.ant-page-header-heading, .operational-page-head, .evolution-page-header').first();
            await expect(pageHeading).toBeVisible();
            await expect.poll(async () => Math.round((await pageHeading.boundingBox())?.height ?? 0)).toBeLessThanOrEqual(48);
            await expect(pageHeading).toHaveCSS('position', 'relative');
            await expect(workspaceTabs).toBeVisible();
            await content.evaluate((element) => {
                const spacer = document.createElement('div');
                spacer.dataset.tabletE2eVerticalContent = 'true';
                spacer.style.height = '900px';
                spacer.style.pointerEvents = 'none';
                element.querySelector('.evolution-screen-frame')?.append(spacer);
            });
            await expect(content).toBeVisible();
            const didScroll = await content.evaluate((element) => {
                const candidates = [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))];
                const target = candidates.find((candidate) => {
                    const style = getComputedStyle(candidate);
                    return candidate.scrollHeight > candidate.clientHeight + 40 && /auto|scroll/.test(style.overflowY);
                });
                if (!target) return false;
                target.dataset.tabletE2eScrollTarget = 'true';
                target.scrollTop = Math.min(120, target.scrollHeight - target.clientHeight);
                target.dispatchEvent(new Event('scroll', { bubbles: true }));
                return target.scrollTop >= 32;
            });
            expect(didScroll, 'client detail exposes a real vertical scroll surface').toBe(true);
            await expect(content).toHaveAttribute('data-tablet-header-compact', 'true');
            await expect(shell).toHaveAttribute('data-tablet-header-compact', 'true');
            await expect.poll(async () => Math.round((await pageHeading.boundingBox())?.height ?? 0)).toBe(44);
            await expect(pageHeading).toHaveCSS('position', 'sticky');
            await expect(pageHeading.locator('.ant-page-header-heading-left, .operational-page-head__title, .evolution-page-header__copy').first()).toHaveCSS('opacity', '0');
            await expect.poll(async () => Math.round((await workspaceTabs.boundingBox())?.height ?? 0)).toBe(0);
            const compactIconAction = pageHeading.locator('.ant-page-header-heading-extra .ant-btn:has(.anticon), .operational-page-head__actions .ant-btn:has(.anticon), .evolution-page-header__actions .ant-btn:has(.anticon)').first();
            await expect(compactIconAction).toBeVisible();
            await expect(compactIconAction).toHaveCSS('font-size', '0px');
            expect(Math.round((await compactIconAction.boundingBox())?.width ?? 0)).toBe(44);
            await captureTabletState(page, testInfo, '15-client-detail-compact-header');
            await content.evaluate((element) => {
                const target = element.dataset.tabletE2eScrollTarget === 'true'
                    ? element
                    : element.querySelector<HTMLElement>('[data-tablet-e2e-scroll-target="true"]');
                if (!target) return;
                target.scrollTop = 0;
                target.dispatchEvent(new Event('scroll', { bubbles: true }));
                delete target.dataset.tabletE2eScrollTarget;
                element.querySelector('[data-tablet-e2e-vertical-content="true"]')?.remove();
            });
            await expect(content).toHaveAttribute('data-tablet-header-compact', 'false');
            await expect(shell).toHaveAttribute('data-tablet-header-compact', 'false');
            await expect(workspaceTabs).toBeVisible();
        }

        expect(health.pageErrors, 'page errors').toEqual([]);
        expect(health.consoleErrors, 'console errors').toEqual([]);
        expect(health.serverErrors, 'HTTP 5xx responses').toEqual([]);
    });

    test('renders every reference screen in the real 8.7-inch CSS viewport', async ({ page }, testInfo) => {
        test.setTimeout(300_000);
        await page.setViewportSize(REAL_87_TABLET_CSS_VIEWPORT);
        const db = createWorkflowMockDb();
        seedTabletData(db);
        const health = collectPageHealth(page);
        await setupGeneralTabletMocks(page, db);

        const states = [
            { name: 'orders-list', path: '/orders?view=list&pageSize=100', family: 'orders', ready: '.orders-table' },
            { name: 'orders-cards', path: '/orders?view=cards', family: 'orders', ready: '.order-card-list--tablet .ant-card' },
            { name: 'order-detail', path: `/orders/show/${ORDER_ID}`, family: 'order-detail', readyText: 'Tablet QA 015' },
            { name: 'order-create', path: '/orders/create', family: 'order-edit', readyText: 'Создание заказа' },
            { name: 'calendar', path: '/calendar', family: 'calendar', ready: '.calendar-board' },
            { name: 'clients', path: '/clients', family: 'clients-list', ready: '.ant-table' },
            { name: 'client-detail', path: '/clients/show/1', family: 'client-detail', readyText: 'Основная информация' },
            { name: 'payments', path: '/payments', family: 'payments-list', ready: '.ant-table' },
            { name: 'materials', path: '/materials', family: 'materials-list', ready: '.ant-table' },
            { name: 'cut', path: '/cut', family: 'cut', ready: '.cut-page-modern' },
            { name: 'configuration', path: '/configuration', family: 'configuration', ready: '.configuration-tabs-wrap' },
        ] as const;

        const requestedStates = new Set((process.env.TABLET_SCREEN ?? '').split(',').filter(Boolean));
        const selectedStates = requestedStates.size > 0
            ? states.filter((state) => requestedStates.has(state.name))
            : states;

        for (const [index, state] of selectedStates.entries()) {
            await test.step(state.name, async () => {
                await page.goto(state.path, { waitUntil: 'domcontentloaded' });
                await expectTabletShell(page, state.family);
                if ('ready' in state) await expect(page.locator(state.ready).first()).toBeVisible({ timeout: 30_000 });
                if ('readyText' in state) await expect(page.getByText(state.readyText, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
                if (state.name === 'orders-cards') await expectConfiguredOrderCardStatusColors(page);
                await expect(page.locator('.evolution-shell__content')).toHaveAttribute('data-tablet-header-compact', 'true');
                await expect(page.locator('.evolution-shell')).toHaveAttribute('data-tablet-header-compact', 'true');
                const workspaceTabs = page.locator('.evolution-workspace-tabs');
                await expect(workspaceTabs).toHaveCSS('height', '0px', { timeout: 30_000 });
                expect(Math.round((await workspaceTabs.boundingBox())?.height ?? 0)).toBe(0);
                await expectNoDocumentOverflow(page);
                await expectRepresentativeTouchTargets(page);
                await captureTabletState(
                    page,
                    testInfo,
                    `19-real-87-${String(index + 1).padStart(2, '0')}-${state.name}`,
                );
            });
        }

        expect(health.pageErrors, 'page errors').toEqual([]);
        expect(health.consoleErrors, 'console errors').toEqual([]);
        expect(health.serverErrors, 'HTTP 5xx responses').toEqual([]);
    });

    test('adapts shell and content across tablet and landscape-phone viewports', async ({ page }, testInfo) => {
        const db = createWorkflowMockDb();
        seedTabletData(db);
        db.app_settings.push({
            setting_id: 1,
            setting_key: 'navigation.resource_visibility_by_role',
            value_json: { 'order-status-board': { admin: false } },
            is_active: true,
        });
        await setupGeneralTabletMocks(page, db);

        await page.addInitScript(() => {
            localStorage.setItem('erp.ui.tablet.orders.view.1', 'board');
        });
        await page.goto('/orders?view=board');
        await expectTabletShell(page, 'orders');
        await expect(page).toHaveURL(/\/orders\?view=list$/, { timeout: 30_000 });
        await expect(page.locator('.orders-table')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.orders-tablet-view-switch .ant-segmented-item')).toHaveCount(2);

        const tabletViewports = [
            { width: 1340, height: 800, tier: 'tablet-landscape' },
            { width: 1280, height: 800, tier: 'tablet-landscape' },
            { width: 1024, height: 768, tier: 'tablet-landscape' },
            { width: 800, height: 1280, tier: 'tablet' },
            { width: 1024, height: 1366, tier: 'tablet' },
        ] as const;
        for (const viewport of tabletViewports) {
            await page.setViewportSize(viewport);
            await page.goto('/orders?view=cards');
            await expect(page.locator('.evolution-shell')).toHaveAttribute('data-device-tier', viewport.tier, { timeout: 30_000 });
            await expect(page.locator('.ui-variant-root')).toHaveAttribute('data-ui-variant', 'evolution', { timeout: 30_000 });
            await expectNoDocumentOverflow(page);
            if (viewport.tier === 'tablet') {
                await expect(page.locator('.evolution-tablet-rail')).toHaveCount(0);
                await expect(page.locator('.evolution-header')).toBeVisible();
                await expect(page.getByRole('button', { name: 'Открыть быстрый переход' })).toHaveCount(0);
                await expect(page.getByRole('button', { name: /Открыть меню/i })).toBeVisible();
                expect(await page.locator('.evolution-shell__main').evaluate((element) => getComputedStyle(element).marginLeft)).toBe('0px');
            } else {
                await expect(page.locator('.evolution-header')).toHaveCount(0);
                const rail = page.locator('.evolution-tablet-rail');
                await expect(rail).toBeVisible();
                expect(Math.round((await rail.boundingBox())?.width ?? 0)).toBe(68);
            }
        }

        await page.setViewportSize(REAL_87_TABLET_CSS_VIEWPORT);
        await page.goto('/orders?view=list&pageSize=100');
        await expectTabletShell(page, 'orders');
        await expect(page.locator('.evolution-shell__content')).toHaveAttribute('data-tablet-header-compact', 'true');
        await expect.poll(async () => Math.round((await page.locator('.evolution-workspace-tabs').boundingBox())?.height ?? 0)).toBe(0);
        await expect(page.locator('.orders-table .ant-table-pagination')).toHaveCount(1);
        const ordersBodyMaxHeight = await page.locator('.orders-table .ant-table-body').evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).maxHeight),
        );
        expect(ordersBodyMaxHeight).toBeGreaterThanOrEqual(250);
        const railNavigationMetrics = await page.locator('.evolution-tablet-rail__nav').evaluate((element) => ({
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            buttonCount: element.querySelectorAll('.evolution-tablet-rail__button').length,
        }));
        expect(railNavigationMetrics.buttonCount).toBeGreaterThan(3);
        expect(railNavigationMetrics.scrollHeight).toBeGreaterThan(railNavigationMetrics.clientHeight);
        const personalUtilities = page.getByRole('group', { name: 'Персональные действия' });
        await expect(personalUtilities).toBeVisible();
        await expect(personalUtilities.getByRole('button', { name: 'Уведомления' })).toBeVisible();
        await expect(personalUtilities.getByRole('button', { name: 'Сканер бирок' })).toBeVisible();
        await expect(personalUtilities.getByRole('button', { name: 'Включить темную тему' })).toBeVisible();
        await expect(personalUtilities.getByRole('button', { name: 'Меню пользователя admin' })).toBeVisible();
        const utilityBottom = await personalUtilities.evaluate((element) => element.getBoundingClientRect().bottom);
        expect(utilityBottom).toBeLessThanOrEqual(REAL_87_TABLET_CSS_VIEWPORT.height);
        await expectNoDocumentOverflow(page);
        await captureTabletState(page, testInfo, '17-real-87-tablet-orders');

        for (const viewport of [{ width: 844, height: 390 }, { width: 932, height: 430 }]) {
            await page.setViewportSize(viewport);
            await page.goto('/orders');
            await expect(page.locator('.evolution-shell')).toHaveCount(0);
            await expect(page.locator('.ui-variant-root')).toHaveAttribute('data-ui-variant', 'legacy', { timeout: 30_000 });
            await expect(page.getByRole('heading', { name: 'Заказы' })).toHaveCount(0);
            await expect(page.getByRole('tab', { name: 'Заказы' })).toBeVisible({ timeout: 30_000 });
            await expect(page.getByRole('button', { name: /Действия и фильтры/ })).toBeVisible();
            await expect(page.locator('.ant-table')).toHaveCount(0);
            await expect(page.locator('.ant-list')).toBeVisible({ timeout: 30_000 });
        }
    });

    test('opens the tablet calendar in one unconstrained sticky row before any scroll', async ({ page, context }, testInfo) => {
        const db = createWorkflowMockDb();
        seedTabletData(db);
        const health = collectPageHealth(page);
        await setupGeneralTabletMocks(page, db);

        await page.goto('/calendar', { waitUntil: 'domcontentloaded' });
        await expectTabletShell(page, 'calendar');
        await expect(page.locator('.calendar-board')).toBeVisible({ timeout: 30_000 });

        const content = page.locator('.evolution-shell__content');
        const wrapper = page.locator('.calendar-page-wrapper');
        const pageHeader = wrapper.locator(':scope > .operational-page-head, :scope > .calendar-page-header').first();
        const navigation = page.locator('.calendar-navigation');
        const grid = page.locator('.calendar-grid');

        await expect(content).toHaveAttribute('data-tablet-header-compact', 'true');
        await expect(page.locator('.evolution-shell')).toHaveAttribute('data-tablet-header-compact', 'true');
        await expect(pageHeader).toBeHidden();
        await expect.poll(async () => Math.round((await pageHeader.boundingBox())?.height ?? 0)).toBe(0);
        await expect(navigation).toHaveCSS('position', 'sticky');
        await expect.poll(async () => Math.round((await navigation.boundingBox())?.height ?? 0)).toBe(44);
        await expect(grid).toHaveCSS('max-height', 'none');
        await expect(content).toHaveCSS('overflow-y', 'auto');

        await page.setViewportSize(REAL_87_TABLET_CSS_VIEWPORT);
        await expect(page.locator('.order-card').first()).toBeVisible();
        await touchPanCalendarFromCard(context, page);
        await touchHoldCalendarDragHandle(context, page);
        await navigation.locator('.ant-segmented-item').filter({ hasText: 'Компактный' }).click();
        await expect(page.locator('.order-card--compact').first()).toBeVisible();
        await touchPanCalendarFromCard(context, page);
        await touchHoldCalendarDragHandle(context, page);
        await navigation.locator('.ant-segmented-item').filter({ hasText: 'Стандартный' }).click();

        await page.locator('.day-column').first().evaluate((element) => {
            element.style.minHeight = '1000px';
        });
        await expect.poll(async () => Math.round((await grid.boundingBox())?.height ?? 0)).toBeGreaterThanOrEqual(1000);
        const contentBox = await content.boundingBox();
        const wrapperBox = await wrapper.boundingBox();
        expect(wrapperBox?.height ?? 0, 'calendar wrapper grows beyond the tablet viewport').toBeGreaterThan((contentBox?.height ?? 0) + 200);

        const compactNavigationBox = await navigation.boundingBox();
        const compactContentBox = await content.boundingBox();
        expect(Math.abs((compactNavigationBox?.y ?? 0) - (compactContentBox?.y ?? 0))).toBeLessThanOrEqual(12);

        const compactFilter = navigation.getByRole('button', { name: /фильтры/i });
        await expect(compactFilter).toBeVisible();
        expect(Math.round((await compactFilter.boundingBox())?.width ?? 0)).toBe(44);
        await expect(navigation.getByRole('button', { name: 'Сегодня' })).toHaveCSS('font-size', '0px');
        await expect(navigation.locator('.calendar-navigation__mode-text').first()).toHaveCSS('display', 'none');
        await expect(navigation.locator('.calendar-navigation__scale').first()).toHaveCSS('display', 'none');
        await captureTabletState(page, testInfo, '16-calendar-compact-header');

        await content.evaluate((element) => {
            element.scrollTop = 160;
            element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await expect(content).toHaveAttribute('data-tablet-header-compact', 'true');
        await content.evaluate((element) => {
            element.scrollTop = 0;
            element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await expect(content).toHaveAttribute('data-tablet-header-compact', 'true');
        await expect.poll(async () => Math.round((await pageHeader.boundingBox())?.height ?? 0)).toBe(0);

        expect(health.pageErrors, 'page errors').toEqual([]);
        expect(health.consoleErrors, 'console errors').toEqual([]);
        expect(health.serverErrors, 'HTTP 5xx responses').toEqual([]);
    });

    test('moves order and production cards with real CDP touch input and keeps CNC drag-free', async ({ page, context }, testInfo) => {
        const db = createWorkflowMockDb();
        seedTabletData(db);
        const health = collectPageHealth(page);
        const boardMock = await setupBoardTabletMocks(page, db);

        await page.goto('/order-status-board');
        await expectTabletShell(page, 'status-board');
        await expect(page.locator('[data-status-board-order-id="15"]')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('button', { name: /Загрузить ещё/ })).toHaveCount(0);
        await expect(page.getByTestId('status-board-column-load-sentinel-order-1')).toBeAttached();
        expect(boardMock.columnPageRequests).toEqual([]);
        await touchScrollStatusColumnNearBottom(context, page, 'order-1');
        await expect.poll(() => boardMock.columnPageRequests).toEqual(['order-1:tablet-page-2']);
        const paginatedCards = page.locator(
            '[data-status-board-column-key="order-1"] .status-board-column__cards',
        );
        await expect(paginatedCards).toHaveAttribute('aria-busy', 'true');
        await expect(paginatedCards.getByText('Загружаем следующие заказы…')).toBeVisible();
        await expect(page.locator('[data-status-board-order-id="199"]')).toBeAttached();
        await expect(page.getByTestId('status-board-column-load-sentinel-order-1')).toHaveCount(0);
        await page.locator('[data-status-board-column-key="order-1"] .status-board-column__cards').evaluate((element) => {
            element.scrollTop = 0;
        });
        const boardContent = page.locator('.evolution-shell__content');
        await expect(boardContent).toHaveAttribute('data-tablet-header-compact', 'true');
        await expect(page.locator('.evolution-shell')).toHaveAttribute('data-tablet-header-compact', 'true');
        await expect(page.locator('.status-board-page__header')).toBeHidden();
        await expect(page.locator('.status-board-tabs')).toBeHidden();
        await expect(page.getByLabel('Переключатель досок')).toBeVisible();
        await expect(page.locator('.status-board-toolbar__tablet-refresh')).toBeVisible();
        await expectSingleLineBoardToolbar(page);
        await expectFullHeightBoardViewport(page);
        await touchPanBoardFromMiddle(context, page);
        await page.locator('.status-board-viewport').evaluate((element) => {
            element.scrollLeft = 0;
            element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await expect(page.locator('.status-board-toolbar__label').first()).toBeHidden();
        await captureTabletState(page, testInfo, '03a-order-board-compact-header');
        await touchDragCard(context, page, 'Tablet QA 015', 'order-2');
        await expect.poll(() => boardMock.orderStatusBodies.length).toBe(1);
        expect(boardMock.orderStatusBodies[0]).toMatchObject({ orderStatusId: 2, version: 3 });
        await expect(page.locator('[data-status-board-column-key="order-2"] [data-status-board-order-id="15"]')).toBeVisible();
        await captureTabletState(page, testInfo, '03-order-board');

        await page.locator('.status-board-toolbar__tablet-board-switch .ant-segmented-item').nth(1).click();
        await expect(page).toHaveURL(/\/order-status-board\?board=production(?:&[^#]*)?$/);
        await expectTabletShell(page, 'status-board');
        await expect(page.locator('.evolution-shell__content')).toHaveAttribute('data-tablet-header-compact', 'true');
        await expect(page.locator('.status-board-tabs')).toBeHidden();
        await expectSingleLineBoardToolbar(page);
        await touchDragCard(context, page, 'Tablet QA 015', 'production-2');
        await expect.poll(() => boardMock.productionStatusBodies.length).toBe(1);
        expect(boardMock.productionStatusBodies[0]).toMatchObject({ productionStatusId: 2, version: 4 });
        await expect(page.locator('[data-status-board-column-key="production-2"] [data-status-board-order-id="15"]')).toBeVisible();
        await captureTabletState(page, testInfo, '04-production-board');

        await page.goto('/mdf-work-board');
        await expectTabletShell(page, 'status-board');
        await expect(page.locator('.evolution-shell__content')).toHaveAttribute('data-tablet-header-compact', 'true');
        await expect(page.locator('.status-board-page__header')).toBeHidden();
        await expect(page.locator('.status-board-toolbar__tablet-refresh')).toBeVisible();
        await expectSingleLineBoardToolbar(page);
        await expect(page.locator('.status-board-toolbar__cnc-card-mode-text').first()).toBeHidden();
        await expect(page.locator('.status-board-columns--cnc .status-board-column')).toHaveCount(5);
        await expect(page.locator('.status-board-card__drag--touch')).toHaveCount(0);
        await captureTabletState(page, testInfo, '05-cnc-board');

        await page.setViewportSize(REAL_87_TABLET_CSS_VIEWPORT);
        await page.goto('/mdf-work-board');
        await expectTabletShell(page, 'status-board');
        await expectSingleLineBoardToolbar(page);
        await expectFullHeightBoardViewport(page);
        await expectNoDocumentOverflow(page);
        const cncColumnBoxes = await page.locator('.status-board-columns--cnc .status-board-column').evaluateAll((columns) =>
            columns.map((column) => {
                const box = column.getBoundingClientRect();
                return { left: box.left, right: box.right, width: box.width };
            }),
        );
        expect(cncColumnBoxes).toHaveLength(5);
        for (let index = 1; index < cncColumnBoxes.length; index += 1) {
            expect(cncColumnBoxes[index].left).toBeGreaterThanOrEqual(cncColumnBoxes[index - 1].right - 1);
            expect(cncColumnBoxes[index].width).toBeGreaterThanOrEqual(239);
        }
        await touchPanBoardFromMiddle(context, page);
        await captureTabletState(page, testInfo, '18-real-87-tablet-cnc-board');

        expect(boardMock.columnPageRequests, 'one request per pagination cursor').toEqual([
            'order-1:tablet-page-2',
        ]);
        expect(boardMock.unexpectedWrites, 'unmocked writes must fail closed').toEqual([]);
        expect(health.pageErrors, 'page errors').toEqual([]);
        expect(health.consoleErrors, 'console errors').toEqual([]);
        expect(health.serverErrors, 'HTTP 5xx responses').toEqual([]);

        // Regression-only phone check. The legacy Refine layout emits its known
        // upstream AntD Menu deprecation warning; tablet health is asserted above.
        await page.setViewportSize({ width: 932, height: 430 });
        await page.goto('/order-status-board');
        await expect(page.locator('.evolution-shell')).toHaveCount(0);
        await expect(page.locator('[data-status-board-order-id="15"]')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.status-board-card__drag--touch')).toBeVisible();
    });

    test('opens MDF machine-file preview without runtime errors', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedTabletData(db);
        const health = collectPageHealth(page);
        await setupBoardTabletMocks(page, db);

        await page.route(/\/api\/v1\/cnc-telegram\/today(?:\?.*)?$/, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    workday: '2026-08-05',
                    generatedAt: '2026-08-05T10:00:00.000Z',
                    columns: [{
                        key: 'parsed',
                        title: 'Файлы на станке',
                        total: 1,
                        packets: [buildMdfPreviewPacket()],
                        baths: [],
                    }],
                }),
            });
        });
        await page.route(/\/api\/v1\/cnc-telegram\/media\/sheet\.png$/, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'image/png',
                body: Buffer.from(
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                    'base64',
                ),
            });
        });

        await page.goto('/mdf-work-board');
        const card = page.locator('.cnc-packet-card').filter({ hasText: 'CNC#1_2701.TXT' });
        await expect(card).toBeVisible({ timeout: 30_000 });
        await card.getByRole('button', { name: 'Скрин' }).click();
        await expect(card.getByAltText('Скрин листа CNC#1_2701.TXT')).toBeVisible({ timeout: 30_000 });
        await card.getByRole('button', { name: 'Печать скрина листа CNC#1_2701.TXT' }).first().click();
        const previewDialog = page.getByRole('dialog');
        await expect(previewDialog).toBeVisible();
        await expect(previewDialog.getByText('Скрин раскроя · CNC#1_2701.TXT')).toBeVisible();

        expect(health.pageErrors, 'page errors').toEqual([]);
        expect(health.consoleErrors, 'console errors').toEqual([]);
        expect(health.serverErrors, 'HTTP 5xx responses').toEqual([]);
    });
});

function buildMdfPreviewPacket() {
    return {
        packetId: 'packet-preview-1',
        externalPacketKey: 'chat:1:message:1',
        cuttingSequenceNo: 6,
        sourceChatId: '1',
        sourceMessageId: 1,
        sourceThreadId: null,
        sourceVersion: 1,
        sourceCreatedAt: '2026-08-05T08:00:00.000Z',
        sourceUpdatedAt: null,
        workday: '2026-08-05',
        machine: 'CNC#1',
        programName: 'CNC#1_2701.TXT',
        materialName: 'МДФ',
        sheetImageUrl: '/api/v1/cnc-telegram/media/sheet.png',
        sheetImageContentType: 'image/png',
        sheetImageSizeBytes: 68,
        parseStatus: 'parsed',
        completionStatus: 'pending',
        thumbsUp: false,
        completedAt: null,
        rework: false,
        comments: [],
        tools: [],
        dowelingLinks: [],
        analysisWarnings: [],
        ocrEngine: null,
        parserVersion: 'e2e',
        cutLayout: null,
        svgCutJobId: null,
        svgCutResultId: null,
        svgCutResultNo: null,
        svgCutImportStatus: 'none',
        svgCutImportNote: null,
        allLinkedOrderDetailsPackedOrLater: false,
        itemCount: 1,
        itemQuantityTotal: 1,
        updatedAt: '2026-08-05T08:00:00.000Z',
        items: [{
            packetItemId: 'packet-preview-item-1',
            sourceItemKey: '2701:31:497x477',
            orderName: '2701',
            orderId: 15,
            detailNumber: 31,
            widthMm: 497,
            heightMm: 477,
            quantity: 1,
            source: 'vector',
            confidence: 1,
            matchOrderId: 15,
            matchDetailId: 1,
            matchDetailQuantity: 1,
            matchStatus: 'matched',
            reviewNote: null,
            laminatedOrLater: false,
        }],
    };
}

async function setupGeneralTabletMocks(page: Page, db: WorkflowMockDb) {
    assertLocalMockBaseUrl();
    await setupWorkflowMockApi(page, db, {
        uiVariant: 'legacy',
        runtimeConfig: {
            backendCut: true,
            backendOrdersRead: true,
            backendProductionActions: false,
            labels: true,
            orderStatusBoard: false,
        },
    });
    await page.addInitScript((marker) => {
        sessionStorage.setItem('tablet-e2e-mock', marker);
        const raw = localStorage.getItem('user');
        if (!raw) return;
        const user = JSON.parse(raw);
        user.permissions = Array.from(new Set([...(user.permissions ?? []), 'cut.view', 'labels.view']));
        localStorage.setItem('user', JSON.stringify(user));
    }, LOCAL_MOCK_MARKER);
    await setupSharedReadMocks(page);
    await setupOrderReadMocks(page, db);
}

async function setupBoardTabletMocks(page: Page, db: WorkflowMockDb) {
    assertLocalMockBaseUrl();
    await setupWorkflowMockApi(page, db, {
        uiVariant: 'legacy',
        runtimeConfig: {
            backendOrdersRead: true,
            backendProductionActions: true,
            labels: true,
            orderStatusBoard: true,
            cncTelegram: true,
        },
    });
    await page.addInitScript((marker) => sessionStorage.setItem('tablet-e2e-mock', marker), LOCAL_MOCK_MARKER);
    await setupSharedReadMocks(page);

    const orderStatusBodies: Array<Record<string, unknown>> = [];
    const productionStatusBodies: Array<Record<string, unknown>> = [];
    const columnPageRequests: string[] = [];
    const unexpectedWrites: string[] = [];
    let orderStatusId = 1;
    let productionStatusId = 1;
    let version = 3;

    await page.route(/\/api\//, async (route) => {
        const method = route.request().method();
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            unexpectedWrites.push(`${method} ${new URL(route.request().url()).pathname}`);
            await route.abort('blockedbyclient');
            return;
        }
        await route.fallback();
    });

    await page.route(/\/api\/v1\/orders\/status-board(?:\?.*)?$/, async (route) => {
        const url = new URL(route.request().url());
        const board = url.searchParams.get('board') === 'production' ? 'production' : 'order';
        const column = url.searchParams.get('column');
        const cursor = url.searchParams.get('cursor');
        if (column && cursor) {
            columnPageRequests.push(`${column}:${cursor}`);
            await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(
                column && cursor
                    ? buildBoardColumnPage(board, column, orderStatusId, productionStatusId, version)
                    : buildBoardResponse(board, orderStatusId, productionStatusId, version),
            ),
        });
    });
    await page.route(/\/api\/v1\/cnc-telegram\/today(?:\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                workday: '2026-08-05',
                generatedAt: '2026-08-05T10:00:00.000Z',
                columns: ['parsed', 'completed', 'baths', 'baths_ready'].map((key) => ({
                    key,
                    title: key,
                    total: 0,
                    packets: [],
                    baths: [],
                })),
            }),
        });
    });
    await page.route(/\/api\/v1\/orders\/15\/status$/, async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        orderStatusBodies.push(body);
        orderStatusId = Number(body.orderStatusId);
        version += 1;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ order: { orderId: ORDER_ID, orderStatusId, version }, requestId: 'tablet-order-status' }),
        });
    });
    await page.route(/\/api\/v1\/orders\/15\/production-status$/, async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        productionStatusBodies.push(body);
        productionStatusId = Number(body.productionStatusId);
        version += 1;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ order: { orderId: ORDER_ID, productionStatusId, version }, requestId: 'tablet-production-status' }),
        });
    });

    return { orderStatusBodies, productionStatusBodies, columnPageRequests, unexpectedWrites };
}

async function setupSharedReadMocks(page: Page) {
    await page.route(/\/api\/v1\/orders\/status-board\/mdf-manual-moves$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ generatedAt: '2026-08-05T10:00:00.000Z', moves: [] }),
        });
    });
    await page.route(/\/api\/v1\/notifications(?:\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 }, unreadCount: 0 }),
        });
    });
    await page.route(/\/api\/v1\/cut-config$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ settings: [], paramProfiles: [], renderPresets: [], pdfTemplates: [] }),
        });
    });
    await page.route(/\/api\/v1\/cut-jobs\/detail-last-ready(?:\?.*)?$/, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ details: [] }) });
    });
    await page.route(/\/api\/v1\/cut-jobs\/placements(?:\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ jobs: [], hasArchived: false }),
        });
    });
    await page.route(/\/api\/v1\/cnc-telegram\/orders\/\d+\/cutting-sequences$/, async (route) => {
        const orderId = Number(new URL(route.request().url()).pathname.split('/').at(-2));
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ orderId, sequences: [] }),
        });
    });
    await page.route(/\/api\/v1\/cut-jobs(?:\/sheet-types|\/film-options)?(?:\?.*)?$/, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });
}

async function setupOrderReadMocks(page: Page, db: WorkflowMockDb) {
    await page.route(/\/api\/v1\/orders\/\d+(?:\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') {
            await route.fallback();
            return;
        }
        const orderId = Number(new URL(route.request().url()).pathname.split('/').pop());
        const order = db.orders.find((row) => Number(row.order_id) === orderId);
        if (!order) {
            await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Order not found' }) });
            return;
        }
        const details = db.order_details.filter((row) => Number(row.order_id) === orderId);
        const payments = db.payments.filter((row) => Number(row.order_id) === orderId);
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                order: {
                    header: {
                        orderId,
                        orderName: order.order_name,
                        clientId: order.client_id,
                        clientName: 'Базовый клиент',
                        projectId: order.project_id ?? 1,
                        projectCode: order.project_code ?? 'ФК26',
                        orderDate: order.order_date,
                        managerId: order.manager_id,
                        priority: order.priority,
                        orderStatusId: order.order_status_id,
                        orderStatusName: 'Новый',
                        paymentStatusId: order.payment_status_id,
                        paymentStatusName: 'Частично оплачено',
                        productionStatusId: order.production_status_id,
                        productionStatusName: 'Новый',
                        productionStatusFromDetailsEnabled: false,
                        plannedCompletionDate: order.planned_completion_date,
                        discount: order.discount,
                        surcharge: order.surcharge,
                        sheetMaterialTypeId: 1,
                        materialName: 'МДФ 16 мм',
                        version: order.version,
                    },
                    details: details.map((detail) => ({
                        id: detail.detail_id,
                        orderId,
                        detailNumber: detail.detail_number,
                        detailName: detail.detail_name,
                        height: detail.height,
                        width: detail.width,
                        quantity: detail.quantity,
                        area: detail.area,
                        materialId: detail.material_id,
                        sheetMaterialTypeId: detail.sheet_material_type_id,
                        materialName: 'МДФ 16 мм',
                        millingTypeId: detail.milling_type_id,
                        edgeTypeId: detail.edge_type_id,
                        filmId: detail.film_id,
                        detailCost: detail.detail_cost,
                    })),
                    payments: payments.map((payment) => ({
                        id: payment.payment_id,
                        orderId,
                        typePaidId: payment.type_paid_id,
                        typePaidName: 'Наличные',
                        amount: payment.amount,
                        paymentDate: payment.payment_date,
                        notes: payment.notes,
                    })),
                    workshops: [],
                    requirements: [],
                    dowelingLinks: [],
                    primaryGroup: null,
                    groups: [],
                    totals: {
                        totalAmount: order.total_amount,
                        discount: order.discount,
                        surcharge: order.surcharge,
                        finalAmount: order.final_amount,
                        paidAmount: order.paid_amount,
                        debtAmount: Math.max(0, Number(order.final_amount) - Number(order.paid_amount)),
                        partsCount: order.parts_count,
                        totalArea: order.total_area,
                    },
                    version: order.version,
                },
            }),
        });
    });
    await page.route(/\/api\/v1\/orders(?:\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') {
            await route.fallback();
            return;
        }
        const url = new URL(route.request().url());
        const pageNumber = Math.max(1, Number(url.searchParams.get('page') ?? 1));
        const pageSize = Math.max(1, Number(url.searchParams.get('pageSize') ?? 20));
        const search = (url.searchParams.get('search') ?? '').toLowerCase();
        const filtered = db.orders.filter((row) => !search || String(row.order_name).toLowerCase().includes(search));
        const data = filtered.slice((pageNumber - 1) * pageSize, pageNumber * pageSize).map((order) => ({
            orderId: order.order_id,
            orderName: order.order_name,
            clientId: order.client_id,
            clientName: 'Базовый клиент',
            projectId: order.project_id ?? 1,
            projectCode: order.project_code ?? 'ФК26',
            fullNumber: order.order_name,
            orderDate: order.order_date,
            plannedCompletionDate: order.planned_completion_date,
            orderStatusId: order.order_status_id,
            orderStatusName: 'Новый',
            paymentStatusId: order.payment_status_id,
            paymentStatusName: 'Частично оплачено',
            productionStatusId: order.production_status_id,
            productionStatusName: 'Новый',
            totalAmount: order.total_amount,
            finalAmount: order.final_amount,
            paidAmount: order.paid_amount,
            debtAmount: Math.max(0, Number(order.final_amount) - Number(order.paid_amount)),
            partsCount: order.parts_count,
            totalArea: order.total_area,
            managerId: order.manager_id,
            priority: order.priority,
            materialNames: ['МДФ 16 мм'],
            sheetMaterialTypeIds: [1],
            version: order.version,
        }));
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                data,
                pagination: {
                    page: pageNumber,
                    pageSize,
                    total: filtered.length,
                    totalPages: Math.ceil(filtered.length / pageSize),
                },
            }),
        });
    });
}

function buildBoardResponse(board: 'order' | 'production', orderStatusId: number, productionStatusId: number, version: number) {
    const orderStatuses = [
        { id: 1, code: 'new', name: 'Новый', color: '#1677ff' },
        { id: 2, code: 'approved', name: 'Согласован', color: '#13a8a8' },
        { id: 3, code: 'issued', name: 'Выдан', color: '#52c41a' },
        { id: 4, code: 'assembled', name: 'Собран', color: '#722ed1' },
        { id: 5, code: 'delivery', name: 'Доставка', color: '#eb2f96' },
        { id: 6, code: 'closed', name: 'Закрыт', color: '#595959' },
    ];
    const productionStatuses = [
        { id: 1, code: 'new', name: 'Новый', color: '#1677ff' },
        { id: 2, code: 'in_progress', name: 'В работе', color: '#fa8c16' },
        { id: 3, code: 'done', name: 'Готово', color: '#52c41a' },
        { id: 4, code: 'packing', name: 'Упаковка', color: '#722ed1' },
        { id: 5, code: 'warehouse', name: 'Склад', color: '#13c2c2' },
        { id: 6, code: 'closed', name: 'Закрыто', color: '#595959' },
    ];
    const statuses = board === 'order' ? orderStatuses : productionStatuses;
    const currentId = board === 'order' ? orderStatusId : productionStatusId;
    const card = {
        orderId: ORDER_ID,
        orderName: 'Tablet QA 015',
        fullNumber: 'Tablet QA 015',
        clientId: 1,
        clientName: 'Базовый клиент',
        priority: 50,
        plannedCompletionDate: '2026-08-10',
        pastPlannedDate: false,
        orderStatusId,
        orderStatusName: orderStatuses.find((status) => status.id === orderStatusId)?.name ?? 'Новый',
        orderStatusIssuedOrLater: false,
        productionStatusId,
        productionStatusName: productionStatuses.find((status) => status.id === productionStatusId)?.name ?? 'Новый',
        productionStatusFromDetailsEnabled: false,
        paymentStatusId: 2,
        paymentStatusName: 'Частично оплачено',
        finalAmount: 12000,
        paidAmount: 4500,
        debtAmount: 7500,
        partsCount: 3,
        totalArea: 1.5,
        managerId: 1,
        managerName: 'Администратор Тестов',
        updatedAt: '2026-08-05T10:00:00.000Z',
        version,
        canChangeOrderStatus: true,
        canChangeProductionStatus: true,
    };
    const paginatedColumn = board === 'order' && currentId === 1;
    const initialCards = paginatedColumn
        ? [
            card,
            ...Array.from({ length: 18 }, (_, index) => ({
                ...card,
                orderId: 100 + index,
                orderName: `Lazy QA ${100 + index}`,
                fullNumber: `Lazy QA ${100 + index}`,
            })),
        ]
        : [card];
    return {
        board,
        generatedAt: '2026-08-05T10:00:00.000Z',
        filterKey: `tablet-${board}-${orderStatusId}-${productionStatusId}-${version}`,
        financialsVisible: true,
        columns: statuses.map((status) => {
            const cards = status.id === currentId ? initialCards : [];
            return {
                key: `${board}-${status.id}`,
                status: { ...status, sortOrder: status.id * 10, isActive: true },
                total: cards.length + (status.id === currentId && paginatedColumn ? 1 : 0),
                cards,
                nextCursor: status.id === currentId && paginatedColumn ? 'tablet-page-2' : null,
            };
        }),
    };
}

function buildBoardColumnPage(
    board: 'order' | 'production',
    columnKey: string,
    orderStatusId: number,
    productionStatusId: number,
    version: number,
) {
    const response = buildBoardResponse(board, orderStatusId, productionStatusId, version);
    const source = response.columns.find((column) => column.key === columnKey);
    if (!source || source.cards.length === 0) return { ...response, columns: [] };
    return {
        ...response,
        columns: [{
            ...source,
            cards: [{
                ...source.cards[0],
                orderId: 199,
                orderName: 'Lazy QA 199',
                fullNumber: 'Lazy QA 199',
            }],
            nextCursor: null,
        }],
    };
}

async function touchDragCard(context: BrowserContext, page: Page, orderNumber: string, targetColumnKey: string) {
    const handle = page.getByRole('button', { name: `Удерживайте и перетащите заказ ${orderNumber}` });
    const target = page.locator(`[data-status-board-column-key="${targetColumnKey}"]`);
    await expect(handle).toBeVisible();
    await expect(target).toBeVisible();
    const sourceBox = await handle.boundingBox();
    const targetBox = await target.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    const start = { x: sourceBox!.x + sourceBox!.width / 2, y: sourceBox!.y + sourceBox!.height / 2 };
    const end = { x: targetBox!.x + targetBox!.width / 2, y: targetBox!.y + 96 };
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...start, id: 1, radiusX: 8, radiusY: 8, force: 1 }],
    });
    await page.waitForTimeout(330);
    await expect(page.getByTestId('status-board-touch-ghost')).toBeVisible();
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ ...end, id: 1, radiusX: 8, radiusY: 8, force: 1 }],
    });
    await expect(target).toHaveAttribute('data-touch-drop-over', 'true');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
}

async function touchPanCalendarFromCard(context: BrowserContext, page: Page) {
    const grid = page.locator('.calendar-grid');
    const card = page.locator('.order-card').first();
    await card.scrollIntoViewIfNeeded();
    const metrics = await grid.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        touchAction: getComputedStyle(element.querySelector<HTMLElement>('.order-card')!).touchAction,
    }));
    expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeGreaterThan(metrics.clientWidth);
    expect(metrics.touchAction).toBe('pan-x pan-y');

    await grid.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
    });
    const before = await grid.evaluate((element) => element.scrollLeft);
    expect(before).toBeGreaterThan(60);
    const cardBox = await card.boundingBox();
    expect(cardBox).not.toBeNull();
    const start = await card.evaluate((element) => {
        const cardRect = element.getBoundingClientRect();
        const gridRect = element.closest('.calendar-grid')!.getBoundingClientRect();
        const left = Math.max(cardRect.left + 8, gridRect.left + 8);
        const right = Math.min(cardRect.right - 8, gridRect.right - 8, window.innerWidth - 8);
        const top = Math.max(cardRect.top + 8, gridRect.top + 8);
        const bottom = Math.min(cardRect.bottom - 8, gridRect.bottom - 8, window.innerHeight - 8);
        for (let y = bottom; y >= top; y -= 8) {
            for (let x = left; x <= right; x += 8) {
                const target = document.elementFromPoint(x, y) as HTMLElement | null;
                if (
                    target?.closest('.order-card') === element &&
                    !target.closest('.calendar-order-card__drag-handle')
                ) {
                    return { x, y };
                }
            }
        }
        return null;
    });
    expect(start, JSON.stringify({ cardBox })).not.toBeNull();

    const endX = Math.min(REAL_87_TABLET_CSS_VIEWPORT.width - 40, start!.x + 560);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...start!, id: 3, radiusX: 8, radiusY: 8, force: 1 }],
    });
    for (let step = 1; step <= 8; step += 1) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{
                x: start!.x + ((endX - start!.x) * step) / 8,
                y: start!.y,
                id: 3,
                radiusX: 8,
                radiusY: 8,
                force: 1,
            }],
        });
        await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    await expect.poll(() => grid.evaluate((element) => element.scrollLeft)).toBeLessThan(before - 60);
}

async function touchHoldCalendarDragHandle(context: BrowserContext, page: Page) {
    const handle = page.getByRole('button', { name: /Удерживайте и перетащите заказ/ }).first();
    await expect(handle).toBeVisible();
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    expect(Math.round(handleBox!.width)).toBe(44);
    expect(Math.round(handleBox!.height)).toBe(44);
    await expect(handle).toHaveCSS('touch-action', 'none');
    const card = handle.locator('..');
    const point = {
        x: handleBox!.x + handleBox!.width / 2,
        y: handleBox!.y + handleBox!.height / 2,
    };
    const hitTarget = await page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y) as HTMLElement | null;
        return {
            tagName: target?.tagName ?? null,
            className: target?.className?.toString() ?? null,
            handleLabel: target?.closest<HTMLButtonElement>('.calendar-order-card__drag-handle')?.ariaLabel ?? null,
        };
    }, point);
    expect(hitTarget.handleLabel, JSON.stringify({ point, handleBox, hitTarget })).not.toBeNull();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...point, id: 4, radiusX: 8, radiusY: 8, force: 1 }],
    });
    await page.waitForTimeout(540);
    await expect(card).toHaveClass(/order-card--dragging/);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: point.x + 2, y: point.y, id: 4, radiusX: 8, radiusY: 8, force: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    await expect(card).not.toHaveClass(/order-card--dragging/);
}

async function touchScrollStatusColumnNearBottom(
    context: BrowserContext,
    page: Page,
    columnKey: string,
) {
    const scroller = page.locator(
        `[data-status-board-column-key="${columnKey}"] .status-board-column__cards`,
    );
    const box = await scroller.boundingBox();
    expect(box).not.toBeNull();
    const initial = await scroller.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
    }));
    expect(initial.scrollHeight, JSON.stringify(initial)).toBeGreaterThan(initial.clientHeight + 640);

    const start = { x: box!.x + 24, y: box!.y + box!.height - 36 };
    const endY = box!.y + 72;
    const cdp = await context.newCDPSession(page);
    for (let gesture = 0; gesture < 8; gesture += 1) {
        const remaining = await scroller.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        );
        if (remaining <= 300) break;
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ ...start, id: 5, radiusX: 8, radiusY: 8, force: 1 }],
        });
        for (let step = 1; step <= 6; step += 1) {
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [{
                    x: start.x,
                    y: start.y + ((endY - start.y) * step) / 6,
                    id: 5,
                    radiusX: 8,
                    radiusY: 8,
                    force: 1,
                }],
            });
            await page.waitForTimeout(20);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(80);
    }
    await cdp.detach();
    await expect.poll(() => scroller.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
    )).toBeLessThanOrEqual(320);
}

async function touchPanBoardFromMiddle(context: BrowserContext, page: Page) {
    const viewport = page.locator('.status-board-viewport');
    const viewportBox = await viewport.boundingBox();
    expect(viewportBox).not.toBeNull();
    const metrics = await viewport.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        columnsWidth: element.querySelector<HTMLElement>('.status-board-columns')?.scrollWidth ?? 0,
        columnWidths: Array.from(element.querySelectorAll<HTMLElement>('.status-board-column'))
            .map((column) => Math.round(column.getBoundingClientRect().width)),
    }));
    expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeGreaterThan(metrics.clientWidth);
    const start = {
        x: Math.min(viewportBox!.x + viewportBox!.width - 120, viewportBox!.x + 700),
        y: viewportBox!.y + viewportBox!.height * 0.62,
    };
    const endX = viewportBox!.x + 120;
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...start, id: 2, radiusX: 8, radiusY: 8, force: 1 }],
    });
    for (let step = 1; step <= 6; step += 1) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{
                x: start.x + ((endX - start.x) * step) / 6,
                y: start.y,
                id: 2,
                radiusX: 8,
                radiusY: 8,
                force: 1,
            }],
        });
        await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(120);
}

async function expectFullHeightBoardViewport(page: Page) {
    const dimensions = await page.locator('.status-board-viewport').evaluate((element) => {
        const viewport = element.getBoundingClientRect();
        const toolbar = document.querySelector<HTMLElement>('.status-board-toolbar');
        const toolbarBox = toolbar?.getBoundingClientRect();
        return {
            viewportHeight: viewport.height,
            viewportBottom: viewport.bottom,
            toolbarHeight: toolbarBox?.height ?? 0,
            windowHeight: window.innerHeight,
        };
    });
    expect(Math.abs(dimensions.viewportBottom - dimensions.windowHeight)).toBeLessThanOrEqual(1);
    expect(Math.abs(
        dimensions.viewportHeight - (dimensions.windowHeight - dimensions.toolbarHeight),
    )).toBeLessThanOrEqual(1);
}

async function expectTabletShell(page: Page, family: string) {
    const shell = page.locator('.evolution-shell');
    await expect(shell).toHaveAttribute('data-device-tier', 'tablet-landscape', { timeout: 30_000 });
    await expect(page.locator('.ui-variant-root')).toHaveAttribute('data-ui-variant', 'evolution');
    await expect(page.locator('.evolution-tablet-rail')).toBeVisible();
    await expect(page.locator(`.evolution-shell__content[data-modern-route="${family}"]`)).toBeVisible();
}

async function expectNoDocumentOverflow(page: Page) {
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

async function expectConfiguredOrderCardStatusColors(page: Page) {
    const firstCard = page.locator('.order-card-list--tablet .ant-card').first();
    const expectedBadges = [
        { kind: 'order', background: 'rgb(22, 119, 255)', foreground: 'rgb(0, 0, 0)' },
        { kind: 'payment', background: 'rgb(250, 140, 22)', foreground: 'rgb(0, 0, 0)' },
        { kind: 'production', background: 'rgb(114, 46, 209)', foreground: 'rgb(255, 255, 255)' },
    ] as const;

    for (const badge of expectedBadges) {
        const tag = firstCard.locator(`[data-order-card-status="${badge.kind}"]`);
        await expect(tag).toBeVisible();
        await expect(tag).toHaveCSS('background-color', badge.background);
        await expect(tag).toHaveCSS('color', badge.foreground);
    }

    const backgrounds = await firstCard.locator('[data-order-card-status]').evaluateAll((tags) => (
        tags.map((tag) => getComputedStyle(tag).backgroundColor)
    ));
    expect(new Set(backgrounds).size, backgrounds.join(', ')).toBe(3);
}

async function expectRepresentativeTouchTargets(page: Page) {
    const sizes = await page.locator('.evolution-shell__content .ant-btn:visible').evaluateAll((buttons) =>
        buttons.slice(0, 8).map((button) => {
            const box = button.getBoundingClientRect();
            const styles = getComputedStyle(button);
            return {
                width: box.width,
                height: box.height,
                minWidth: styles.minWidth,
                minHeight: styles.minHeight,
                className: button.className,
                label: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
            };
        }),
    );
    for (const size of sizes) {
        expect(size.width, JSON.stringify(size)).toBeGreaterThanOrEqual(43.5);
        expect(size.height, JSON.stringify(size)).toBeGreaterThanOrEqual(43.5);
    }
}

async function expectSingleLineBoardToolbar(page: Page) {
    const toolbar = page.locator('.status-board-toolbar:visible').first();
    await expect(toolbar).toHaveCSS('position', 'sticky');
    await expect.poll(async () => Math.round((await toolbar.boundingBox())?.height ?? 0)).toBe(44);
    const geometry = await toolbar.evaluate((element) => {
        const toolbarBox = element.getBoundingClientRect();
        const controls = Array.from(element.querySelectorAll<HTMLElement>([
            ':scope > .ant-btn',
            ':scope > .ant-input-affix-wrapper',
            ':scope > .ant-picker',
            ':scope > .ant-select',
            ':scope > .status-board-toolbar__checkbox',
            ':scope > .status-board-toolbar__switch',
            ':scope > .status-board-toolbar__display-mode',
            ':scope > .status-board-toolbar__cnc-period',
            ':scope > .status-board-toolbar__tablet-board-switch',
            ':scope > .status-board-toolbar__tablet-refresh',
        ].join(','))).filter((control) => getComputedStyle(control).display !== 'none');
        return controls.map((control) => {
            const box = control.getBoundingClientRect();
            const segmented = control.querySelector<HTMLElement>('.ant-segmented');
            const segmentedBox = segmented?.getBoundingClientRect();
            const segmentedStyles = segmented ? getComputedStyle(segmented) : null;
            return {
                className: control.className,
                topDelta: Math.abs(box.top - toolbarBox.top),
                bottomDelta: Math.abs(toolbarBox.bottom - box.bottom),
                height: box.height,
                segmentedHeight: segmentedBox?.height,
                segmentedPadding: segmentedStyles?.padding,
                segmentedMinHeight: segmentedStyles?.minHeight,
            };
        });
    });
    expect(geometry.length).toBeGreaterThan(0);
    for (const control of geometry) {
        expect(control.topDelta, JSON.stringify(control)).toBeLessThanOrEqual(1);
        expect(control.bottomDelta, JSON.stringify(control)).toBeLessThanOrEqual(1);
        expect(control.height, JSON.stringify(control)).toBeGreaterThanOrEqual(43.5);
    }
}

async function captureTabletState(page: Page, testInfo: TestInfo, name: string) {
    const viewport = page.viewportSize() ?? PRIMARY_VIEWPORT;
    const path = testInfo.outputPath('tablet-screens', `${name}-${viewport.width}x${viewport.height}.png`);
    await mkdir(dirname(path), { recursive: true });
    await page.screenshot({ path, fullPage: false });
    await testInfo.attach(name, { path, contentType: 'image/png' });
}

function collectPageHealth(page: Page) {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const serverErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
        const text = message.text();
        const knownAntdDevelopmentWarning = text.includes('Instance created by `useForm` is not connected to any Form element');
        if (message.type() === 'error' && !knownAntdDevelopmentWarning) consoleErrors.push(text);
    });
    page.on('response', (response) => {
        if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
    });
    return { pageErrors, consoleErrors, serverErrors };
}

function assertLocalMockBaseUrl() {
    const raw = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';
    const hostname = new URL(raw).hostname;
    if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
        throw new Error(`Refusing tablet mutation mocks against non-local host: ${hostname}`);
    }
}

function seedTabletData(db: WorkflowMockDb) {
    const orderStatus = db.order_statuses.find((row) => row.order_status_id === 1);
    const paymentStatus = db.payment_statuses.find((row) => row.payment_status_id === 2);
    const productionStatus = db.production_statuses.find((row) => row.production_status_id === 1);
    if (orderStatus) orderStatus.color = '#1677FF';
    if (paymentStatus) paymentStatus.color = '#FA8C16';
    if (productionStatus) productionStatus.color = '#722ED1';

    for (let phoneId = 2; phoneId <= 14; phoneId += 1) {
        db.client_phones.push({
            phone_id: phoneId,
            client_id: 1,
            phone_number: `+7 701 000 ${String(phoneId).padStart(4, '0')}`,
            phone_type: phoneId % 2 === 0 ? 'mobile' : 'work',
            is_primary: false,
        });
    }
    db.order_statuses.push(
        { order_status_id: 2, order_status_name: 'Согласован', sort_order: 20, color: 'cyan', is_active: true },
        { order_status_id: 3, order_status_name: 'Выдан', sort_order: 30, color: 'green', is_active: true },
    );
    for (let index = 0; index < 26; index += 1) {
        const orderId = ORDER_ID + index;
        db.orders.push({
            order_id: orderId,
            order_name: index === 0 ? 'Tablet QA 015' : `Tablet QA ${String(orderId).padStart(3, '0')}`,
            client_id: 1,
            manager_id: 1,
            created_by: 1,
            order_date: '2026-08-05',
            planned_completion_date: index === 1 ? '2026-07-01' : '2026-08-10',
            order_status_id: 1,
            payment_status_id: 2,
            production_status_id: 1,
            production_status_from_details_enabled: false,
            final_amount: 12000 + index * 100,
            total_amount: 12000 + index * 100,
            paid_amount: 4500,
            discount: 0,
            surcharge: 0,
            priority: index === 2 ? 50 : 100,
            parts_count: 3,
            total_area: 1.5,
            delete_flag: false,
            version: index === 0 ? 3 : 1,
            created_at: '2026-08-05T10:00:00.000Z',
            updated_at: '2026-08-05T10:00:00.000Z',
        });
    }
    db.order_details.push({
        detail_id: 1501,
        order_id: ORDER_ID,
        detail_number: 1,
        detail_name: 'Tablet фасад',
        height: 1000,
        width: 500,
        quantity: 3,
        area: 1.5,
        milling_type_id: 1,
        edge_type_id: 1,
        film_id: 1,
        material_id: null,
        sheet_material_type_id: 1,
        detail_cost: 12000,
        delete_flag: false,
        version: 1,
    });
    db.payments.push({
        payment_id: 1,
        order_id: ORDER_ID,
        amount: 4500,
        payment_date: '2026-08-05',
        type_paid_id: 1,
        notes: 'Tablet payment',
        created_at: '2026-08-05T10:00:00.000Z',
        updated_at: '2026-08-05T10:00:00.000Z',
    });
    db.payments_view.push({
        payment_id: 1,
        order_id: ORDER_ID,
        order_name: 'Tablet QA 015',
        client_id: 1,
        client_name: 'Базовый клиент',
        amount: 4500,
        payment_date: '2026-08-05',
        type_paid_id: 1,
        type_paid_name: 'Наличные',
        notes: 'Tablet payment',
    });
}
