import { expect, test, type Page, type Response } from '@playwright/test';
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
const ORDERS_VIEW_VERSION_SCHEMA_ERROR = "field 'version' not found in type: 'orders_view'";

test.describe('Calendar frontend', () => {
    test.skip(stageCanaryEnabled, 'Stage canary runs only against the deployed frontend');

    test('loads calendar orders and requests orders_view.version', async ({ page }) => {
        const db = createWorkflowMockDb();
        seedCalendarFrontendOrder(db, formatLocalDate(new Date()));

        const ordersViewQueries: string[] = [];
        const graphQLErrors: string[] = [];

        await setupWorkflowMockApi(page, db, {
            onGraphqlQuery: (query) => {
                if (/\borders_view\s*(?:\(|\{)/.test(query)) {
                    ordersViewQueries.push(query);
                }
            },
            onGraphqlError: (message) => graphQLErrors.push(message),
        });

        await page.goto('/calendar');

        await waitForCalendarHeading(page);
        await expect(page.locator('.calendar-grid')).toBeVisible({ timeout: 30000 });
        await expect(
            page.locator('.order-card').filter({ hasText: 'E2E calendar frontend order' }),
        ).toBeVisible({ timeout: 30000 });

        expect(ordersViewQueries.some((query) => /\bversion\b/.test(query))).toBe(true);
        expect(graphQLErrors).toEqual([]);
        await expect(page.getByText(ORDERS_VIEW_VERSION_SCHEMA_ERROR)).toHaveCount(0);
    });

    test('surfaces the Hasura schema error when orders_view.version is rejected', async ({
        page,
    }) => {
        const db = createWorkflowMockDb();
        seedCalendarFrontendOrder(db, formatLocalDate(new Date()));

        const graphQLErrors: string[] = [];
        await setupWorkflowMockApi(page, db, {
            graphqlErrorForQuery: (query) =>
                /\borders_view\s*(?:\(|\{)/.test(query) && /\bversion\b/.test(query)
                    ? ORDERS_VIEW_VERSION_SCHEMA_ERROR
                    : null,
            onGraphqlError: (message) => graphQLErrors.push(message),
        });

        await page.goto('/calendar');

        await expect(page.getByText('Ошибка загрузки данных')).toBeVisible({ timeout: 30000 });
        await expect(page.getByText(ORDERS_VIEW_VERSION_SCHEMA_ERROR).first()).toBeVisible();
        expect(graphQLErrors).toContain(ORDERS_VIEW_VERSION_SCHEMA_ERROR);
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

    test('opens deployed calendar without orders_view.version GraphQL schema errors', async ({
        page,
    }) => {
        const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const username = `e2e_test_calendar_${runId}`;
        const password = crypto.randomBytes(24).toString('base64url');
        const ordersViewQueries: string[] = [];
        const graphqlRecorder = recordGraphqlResponses(page);

        userId = createSmokeUser(username, password);
        recordGraphqlRequests(page, ordersViewQueries);
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
            .poll(() => ordersViewQueries.some((query) => /\borders_view\b/.test(query)))
            .toBe(true);
        await flushGraphqlResponses(graphqlRecorder);

        expect(ordersViewQueries.some((query) => /\bversion\b/.test(query))).toBe(true);
        expect(
            graphqlRecorder.errors.filter((message) =>
                message.includes(ORDERS_VIEW_VERSION_SCHEMA_ERROR),
            ),
        ).toEqual([]);
        await expect(page.getByText(ORDERS_VIEW_VERSION_SCHEMA_ERROR)).toHaveCount(0);
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
}

async function waitForCalendarHeading(page: Page) {
    await page.waitForFunction(() =>
        document.body.innerText.includes('Производственный календарь'),
    );
}

function recordGraphqlRequests(page: Page, queries: string[]) {
    page.on('request', (request) => {
        if (!isGraphqlUrl(request.url()) || request.method() !== 'POST') return;

        const body = request.postData() ?? '';
        try {
            const parsed = JSON.parse(body);
            if (typeof parsed.query === 'string') {
                queries.push(parsed.query);
            }
        } catch {
            // Ignore non-JSON requests; GraphQL clients should send JSON here.
        }
    });
}

type GraphqlResponseRecorder = {
    errors: string[];
    pending: Promise<void>[];
};

function recordGraphqlResponses(page: Page): GraphqlResponseRecorder {
    const recorder: GraphqlResponseRecorder = { errors: [], pending: [] };

    page.on('response', (response) => {
        if (!isGraphqlUrl(response.url()) || response.request().method() !== 'POST') return;

        recorder.pending.push(
            readGraphqlErrors(response).then((messages) => {
                recorder.errors.push(...messages);
            }),
        );
    });

    return recorder;
}

async function flushGraphqlResponses(recorder: GraphqlResponseRecorder) {
    await Promise.all(recorder.pending.splice(0));
}

async function readGraphqlErrors(response: Response): Promise<string[]> {
    try {
        const body = await response.json();
        if (!Array.isArray(body?.errors)) return [];

        return body.errors
            .map((error: { message?: unknown }) => error?.message)
            .filter((message: unknown): message is string => typeof message === 'string');
    } catch {
        return [];
    }
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
    await page.getByRole('button', { name: 'Войти' }).click();
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

function isGraphqlUrl(url: string) {
    return url.includes('/v1/graphql');
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
