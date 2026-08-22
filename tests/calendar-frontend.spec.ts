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
            passedProductionStatusCodes: ['new'],
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
