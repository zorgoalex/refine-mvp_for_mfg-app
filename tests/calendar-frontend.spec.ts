import { expect, test, type Page, type Route } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
    createWorkflowMockDb,
    setupWorkflowMockApi,
    type WorkflowMockDb,
} from './helpers/mockWorkflowApi';

const stageCanaryEnabled = process.env.CALENDAR_STAGE_CANARY === 'true';
const stageFrontendUrl = trimTrailingSlash(
    process.env.CALENDAR_STAGE_FRONTEND_URL ?? 'https://app-test.mebelkz.app',
);
const stagePostgresContainer =
    process.env.CALENDAR_STAGE_POSTGRES_CONTAINER ?? 'erp_dev-postgresdb-1';
const vercelAutomationBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
test.describe('Calendar frontend', () => {
    test.skip(stageCanaryEnabled, 'Stage canary runs only against the deployed frontend');

    for (const backendOrdersRead of [true, false]) {
        test(`shows doweling or Basis number in every calendar view (backend=${backendOrdersRead})`, async ({ page }) => {
            test.setTimeout(120_000);
            const mobile = !backendOrdersRead;
            await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
            const db = createWorkflowMockDb();
            seedCalendarFrontendOrder(db, formatLocalDate(new Date()));
            const basisOrder = db.orders.find((order) => order.order_id === 201)!;
            basisOrder.order_name = 'E2E calendar Basis';
            if (backendOrdersRead) basisOrder.basis_projects = [' 1491 ', '1491', '1492'];
            db.order_details[0].basis_project = backendOrdersRead ? 'OLD-PROJECT' : ' 1491 ';
            db.order_details.push(
                { ...db.order_details[0], detail_id: 302, detail_number: 2, basis_project: '1491' },
                { ...db.order_details[0], detail_id: 303, detail_number: 3, basis_project: '1492' },
                { ...db.order_details[0], detail_id: 304, detail_number: 4, basis_project: 'DELETED-PROJECT', delete_flag: true },
            );
            db.orders.push(
                { ...basisOrder, order_id: 202, order_name: 'E2E calendar doweling',
                    basis_projects: ['HIDDEN-PROJECT'], doweling_order_name: backendOrdersRead ? 'П-104' : undefined },
                { ...basisOrder, order_id: 203, order_name: 'E2E calendar without reference', basis_projects: [] },
            );
            db.order_details.push({ ...db.order_details[0], detail_id: 305, order_id: 202, basis_project: 'HIDDEN-PROJECT' });
            if (!backendOrdersRead) db.order_doweling_links.push({
                order_doweling_link_id: 1, order_id: 202, delete_flag: false,
                doweling_order: { doweling_order_name: 'П-104' },
            });
            const errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await setupWorkflowMockApi(page, db, {
                runtimeConfig: { backendOrdersRead }, onGraphqlError: (error) => errors.push(error),
            });
            if (backendOrdersRead) await routeCalendarBackendOrders(page, db, []);
            await page.goto('/calendar', { waitUntil: 'domcontentloaded' });
            await expect(page.getByRole('region', { name: 'Производственный календарь' })).toBeVisible({ timeout: 60_000 });
            if (mobile) await page.getByRole('button', { name: /Настройки календаря/ }).click();
            for (const mode of [mobile ? 'Стандарт' : 'Стандартный', mobile ? 'Компакт' : 'Компактный', 'Краткий']) {
                await page.locator('.ant-segmented-item').filter({ hasText: mode }).click();
                const cards = page.locator(mode === 'Краткий' ? '.day-column-brief__order-item' : '.order-card');
                await expect(cards.filter({ hasText: 'E2E calendar Basis' })).toContainText('E2E calendar Basis - 1491, 1492');
                await expect(cards.filter({ hasText: 'E2E calendar doweling' })).toContainText('E2E calendar doweling - П-104');
                await expect(cards.filter({ hasText: 'E2E calendar without reference' })).toBeVisible();
                await expect(page.getByText(/HIDDEN-PROJECT|DELETED-PROJECT|OLD-PROJECT/)).toHaveCount(0);
            }
            expect(errors).toEqual([]);
        });
    }

    test('loads calendar orders through planned completion backend filters', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedCalendarFrontendOrder(db, formatLocalDate(new Date()));

        await setupWorkflowMockApi(page, db, {
            runtimeConfig: { backendOrdersRead: true },
        });
        const orderListUrls: string[] = [];
        await routeCalendarBackendOrders(page, db, orderListUrls);

        await page.goto('/calendar', { waitUntil: 'domcontentloaded' });

        await waitForCalendarHeading(page);
        await expect(page.locator('.calendar-grid')).toBeVisible({ timeout: 30000 });
        await expect(page.getByText('Ошибка загрузки данных')).toHaveCount(0);
        await expect(page.locator('.order-card')).toContainText('E2E calendar frontend order');

        expect(orderListUrls.length).toBeGreaterThan(0);
        const requestUrl = new URL(orderListUrls.at(-1) ?? '');
        expect(requestUrl.searchParams.get('plannedCompletionDateFrom')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(requestUrl.searchParams.get('plannedCompletionDateTo')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(requestUrl.searchParams.get('sortBy')).toBe('plannedCompletionDate');
    });

    test('keeps compact menu and move-date dialog usable across repeated closes', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        const db = createWorkflowMockDb();
        seedCalendarFrontendOrder(db, formatLocalDate(new Date()));
        await setupWorkflowMockApi(page, db, { runtimeConfig: { backendOrdersRead: true } });
        await routeCalendarBackendOrders(page, db, []);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('/calendar', { waitUntil: 'domcontentloaded' });
        await page.getByRole('region', { name: 'Производственный календарь' }).waitFor({ state: 'visible' });
        // Mobile starts in BRIEF with its controls collapsed. Choose the real
        // card mode through the UI before opening its compact context menu.
        const controls = page.getByRole('button', { name: /Настройки календаря/ });
        await controls.click();
        await page.locator('.ant-segmented-item').filter({ hasText: 'Компакт' }).click();
        await expect(page.getByRole('radio', { name: 'Компакт', exact: true })).toBeChecked();
        await controls.click();
        const card = page.locator('.order-card').filter({ hasText: 'E2E calendar frontend order' }).first();
        await expect(card).toBeVisible();
        for (let cycle = 0; cycle < 2; cycle += 1) {
            await card.click({ button: 'right' });
            const menu = page.locator('.calendar-context-menu');
            await expect(menu).toHaveClass(/calendar-context-menu--compact/);
            await menu.getByText('Перенести на дату', { exact: true }).click();
            const dialog = page.getByRole('dialog', { name: /Перенести заказ E2E calendar frontend order/ });
            await expect(dialog).toBeVisible();
            await expect(menu).toHaveCount(0);
            await expect(dialog.locator('input')).not.toHaveValue('');
            await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
            await expect(dialog).not.toBeVisible();
        }
        await expect(card).toBeVisible();
        expect(errors).toEqual([]);
    });

    test('surfaces backend order list errors', async ({ page }) => {
        const db = createWorkflowMockDb();
        await setupWorkflowMockApi(page, db, {
            runtimeConfig: { backendOrdersRead: true },
        });
        await page.route(/\/api\/v1\/orders(?:\?.*)?$/, async (route) => {
            if (route.request().method() !== 'GET') {
                await route.fallback();
                return;
            }
            await route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ message: 'Calendar backend unavailable' }),
            });
        });

        await page.goto('/calendar', { waitUntil: 'domcontentloaded' });

        await expect(page.getByText('Ошибка загрузки данных')).toBeVisible({ timeout: 30000 });
        await expect(page.getByText('Internal Server Error').first()).toBeVisible();
    });

    test('shows merged cut and issued stages in every calendar view', async ({ page }) => {
        test.setTimeout(90_000);
        const db = createWorkflowMockDb();
        seedCalendarFrontendOrder(db, formatLocalDate(new Date()));
        db.production_statuses.push(
            {
                production_status_id: 4,
                production_status_code: 'cut',
                production_status_name: 'Распилено',
                sort_order: 40,
                color: 'orange',
                is_active: true,
            },
            {
                production_status_id: 5,
                production_status_code: 'issued',
                production_status_name: 'Выдан',
                sort_order: 50,
                color: 'green',
                is_active: true,
            },
        );
        db.order_details[0].production_status_id = 4;

        await setupWorkflowMockApi(page, db, {
            runtimeConfig: { backendOrdersRead: true },
        });
        await routeCalendarBackendOrders(page, db, [], ['drawn', 'cut', 'issued']);
        await page.goto('/calendar', { waitUntil: 'domcontentloaded' });
        await waitForCalendarHeading(page);

        await expect(page.locator('.order-card__production-stages').first()).toContainText('Р');
        await expect(page.locator('.order-card__production-stages').first()).toContainText('В');

        await page.locator('.ant-segmented-item').filter({ hasText: 'Компактный' }).click();
        await expect(page.locator('.order-card-compact__production-stages').first()).toContainText('Р');
        await expect(page.locator('.order-card-compact__production-stages').first()).toContainText('В');

        await page.locator('.ant-segmented-item').filter({ hasText: 'Краткий' }).click();
        await expect(page.locator('.day-column-brief__order-item').first()).toContainText('Р');
        await expect(page.locator('.day-column-brief__order-item').first()).toContainText('В');
    });
});

test.describe('Calendar stage canary', () => {
    test.skip(!stageCanaryEnabled, 'Run with CALENDAR_STAGE_CANARY=true');
    test.skip(
        stageCanaryEnabled && !dockerContainerExists(stagePostgresContainer),
        `Stage postgres container ${stagePostgresContainer} is required for calendar stage canary.`,
    );
    test.skip(
        stageCanaryEnabled && !vercelAutomationBypassSecret,
        'VERCEL_AUTOMATION_BYPASS_SECRET is required for protected deployed frontend access.',
    );
    test.setTimeout(90000);

    let userId: number | null = null;

    test.afterEach(() => {
        cleanupUser(userId);
    });

    test('opens deployed calendar through planned completion backend filters', async ({
        page,
    }) => {
        const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const username = `e2e_test_calendar_${runId}`;
        const password = crypto.randomBytes(24).toString('base64url');
        const orderListUrls: string[] = [];
        const orderListStatuses: number[] = [];

        userId = createSmokeUser(username, password);
        recordBackendOrderListRequests(page, orderListUrls, orderListStatuses);
        if (vercelAutomationBypassSecret) {
            await page.context().setExtraHTTPHeaders({
                'x-vercel-protection-bypass': vercelAutomationBypassSecret,
            });
        }

        await loginThroughUi(page, username, password);
        await page.goto(`${stageFrontendUrl}/calendar`, { waitUntil: 'domcontentloaded' });

        await waitForCalendarHeading(page);
        await expect(page.locator('.calendar-grid')).toBeVisible({ timeout: 30000 });
        await expect
            .poll(() => orderListUrls.length > 0)
            .toBe(true);
        await expect
            .poll(() => orderListStatuses.length >= orderListUrls.length)
            .toBe(true);
        expect(orderListStatuses.every((status) => status >= 200 && status < 300)).toBe(true);
        await expect(page.getByText('Ошибка загрузки данных')).toHaveCount(0);
        const requestUrl = new URL(orderListUrls.at(-1) ?? '');
        expect(requestUrl.searchParams.get('plannedCompletionDateFrom')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(requestUrl.searchParams.get('plannedCompletionDateTo')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

function seedCalendarFrontendOrder(db: WorkflowMockDb, plannedDate: string) {
    db.orders.push({
        order_id: 201,
        order_name: 'E2E calendar frontend order',
        client_id: 1,
        order_date: plannedDate,
        planned_completion_date: plannedDate,
        order_status_id: 1,
        payment_status_id: 1,
        production_status_id: 1,
        final_amount: 1000,
        paid_amount: 0,
        parts_count: 2,
        total_area: 3.25,
        delete_flag: false,
        version: 7,
    });
    db.order_details.push({
        detail_id: 301,
        order_id: 201,
        detail_number: 1,
        delete_flag: false,
        production_status_id: 1,
    });
}

async function waitForCalendarHeading(page: Page) {
    await page.waitForFunction(() =>
        document.body.innerText.includes('Производственный календарь'),
    );
}

function recordBackendOrderListRequests(page: Page, urls: string[], statuses: number[]) {
    page.on('request', (request) => {
        if (request.method() !== 'GET') return;
        const url = new URL(request.url());
        if (url.pathname !== '/api/v1/orders') return;
        urls.push(request.url());
    });
    page.on('response', (response) => {
        if (response.request().method() !== 'GET') return;
        const url = new URL(response.url());
        if (url.pathname !== '/api/v1/orders') return;
        statuses.push(response.status());
    });
}

async function routeCalendarBackendOrders(
    page: Page,
    db: WorkflowMockDb,
    requestUrls: string[],
    passedProductionStatusCodes: string[] = ['new'],
) {
    await page.route(/\/api\/v1\/orders(?:\?.*)?$/, async (route: Route) => {
        if (route.request().method() !== 'GET') {
            await route.fallback();
            return;
        }

        requestUrls.push(route.request().url());
        const data = db.orders.map((order) => ({
            orderId: order.order_id,
            orderName: order.order_name,
            clientId: order.client_id,
            clientName: 'Базовый клиент',
            projectId: 1,
            projectCode: 'E2E',
            fullNumber: `E2E-${order.order_name}`,
            orderDate: order.order_date,
            plannedCompletionDate: order.planned_completion_date,
            orderStatusId: order.order_status_id,
            orderStatusName: 'Новый',
            paymentStatusId: order.payment_status_id,
            paymentStatusName: 'Не оплачено',
            productionStatusId: order.production_status_id,
            productionStatusName: 'Новый',
            finalAmount: order.final_amount,
            paidAmount: order.paid_amount,
            partsCount: order.parts_count,
            totalArea: order.total_area,
            priority: order.priority,
            passedProductionStatusCodes,
            basisProjects: order.basis_projects,
            dowelingOrderName: order.doweling_order_name,
            version: order.version,
        }));
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                data,
                pagination: { page: 1, pageSize: 200, total: data.length, totalPages: 1 },
            }),
        });
    });
}

async function loginThroughUi(page: Page, username: string, password: string) {
    await page.goto(`${stageFrontendUrl}/login`, { waitUntil: 'domcontentloaded' });
    const loginResponsePromise = page.waitForResponse(
        (response) =>
            response.url().includes('/api/v1/auth/login') &&
            response.request().method() === 'POST',
    );
    await page.locator('input[autocomplete="username"], input#username').fill(username);
    await page.locator('input[autocomplete="current-password"], input#password').fill(password);
    await page.locator('button[type="submit"]').click();
    const loginResponse = await loginResponsePromise;
    expect(loginResponse.ok()).toBe(true);
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30000 });
}

function createSmokeUser(username: string, password: string): number {
    const email = `${username}@example.invalid`;
    const passwordHash = bcrypt.hashSync(password, 10);

    return Number(
        psql(`
            WITH inserted AS (
                INSERT INTO users (username, email, password_hash, role_id, full_name, is_active)
                VALUES (
                    '${sqlQuote(username)}',
                    '${sqlQuote(email)}',
                    '${sqlQuote(passwordHash)}',
                    1,
                    'E2E Test Calendar Stage Canary',
                    true
                )
                RETURNING user_id
            )
            SELECT user_id FROM inserted;
        `),
    );
}

function cleanupUser(id: number | null) {
    if (!id) return;

    psql(`
        DELETE FROM refresh_tokens WHERE user_id = ${id};
        DELETE FROM auth_sessions WHERE user_id = ${id};
        UPDATE users
        SET is_active = false,
            edited_by = NULL
        WHERE user_id = ${id};
    `);
}

function psql(sql: string): string {
    return execFileSync(
        'docker',
        [
            'exec',
            '-i',
            stagePostgresContainer,
            'psql',
            '-U',
            'postgres',
            '-d',
            'erpdb',
            '-tA',
            '-v',
            'ON_ERROR_STOP=1',
        ],
        { input: sql },
    )
        .toString()
        .trim();
}

function dockerContainerExists(containerName: string): boolean {
    try {
        execFileSync('docker', ['container', 'inspect', containerName], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function sqlQuote(value: string) {
    return value.replaceAll("'", "''");
}

function trimTrailingSlash(value: string) {
    return value.replace(/\/+$/, '');
}

function formatLocalDate(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
