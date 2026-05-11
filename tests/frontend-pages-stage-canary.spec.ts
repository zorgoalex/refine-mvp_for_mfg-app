import { expect, test, type Page, type Response } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

type StageRoute = {
    path: string;
    label: string;
    waitForText?: string | RegExp;
};

type StageIds = Record<string, number | null>;

const canaryEnabled = process.env.FRONTEND_PAGES_STAGE_CANARY === 'true';
const createUserEnabled = process.env.FRONTEND_PAGES_STAGE_CREATE_USER === 'true';
const stageFrontendUrl = trimTrailingSlash(
    process.env.FRONTEND_PAGES_STAGE_FRONTEND_URL ?? 'https://stage.mebelkz.app',
);
const stageBackendApiUrl = trimTrailingSlash(
    process.env.FRONTEND_PAGES_STAGE_BACKEND_API_URL ?? 'https://backend.dev.mebelkz.app',
);
const ORDERS_VIEW_VERSION_SCHEMA_ERROR = "field 'version' not found in type: 'orders_view'";
const allowedMissingRecordResources = new Set([
    'order_workshops',
    'order_resource_requirements',
]);

test.describe('Frontend pages stage canary', () => {
    test.skip(!canaryEnabled, 'Run with FRONTEND_PAGES_STAGE_CANARY=true');
    test.setTimeout(600000);

    let userId: number | null = null;

    test.afterEach(() => {
        cleanupUser(userId);
    });

    test('opens deployed frontend routes without GraphQL or React runtime errors', async ({
        page,
    }) => {
        const ids = loadStageIds();
        const missingRecordResources = Object.entries(ids)
            .filter(([, id]) => id === null || id === undefined)
            .map(([resource]) => resource);
        const unexpectedMissingRecords = missingRecordResources.filter(
            (resource) => !allowedMissingRecordResources.has(resource),
        );
        test.info().annotations.push({
            type: 'stage-empty-record-resources',
            description: missingRecordResources.length ? missingRecordResources.join(', ') : 'none',
        });
        expect(unexpectedMissingRecords, 'stage resources without edit/show fixture rows').toEqual([]);

        const routes = buildStageRoutes(ids);
        const credentials = getStageCredentials();
        const recorder = recordGraphqlResponses(page);
        const httpErrors = recordHttpErrors(page);
        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];

        userId = credentials.userId;
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('console', (message) => {
            if (message.type() === 'error') {
                consoleErrors.push(message.text());
            }
        });

        await loginThroughUi(page, credentials.username, credentials.password);

        for (const route of routes) {
            await test.step(route.label, async () => {
                await flushGraphqlResponses(recorder);
                recorder.errors.length = 0;
                httpErrors.length = 0;
                pageErrors.length = 0;
                consoleErrors.length = 0;

                await page.goto(`${stageFrontendUrl}${route.path}`, {
                    waitUntil: 'domcontentloaded',
                });
                await assertStagePageReady(page, route);
                await flushGraphqlResponses(recorder);

                expect(recorder.errors, `${route.label} GraphQL errors`).toEqual([]);
                expect(httpErrors, `${route.label} REST/runtime HTTP errors`).toEqual([]);
                expect(pageErrors, `${route.label} page errors`).toEqual([]);
                expect(
                    consoleErrors.filter((message) => !isAllowedConsoleError(message)),
                    `${route.label} console errors`,
                ).toEqual([]);
            });
        }
    });
});

function buildStageRoutes(ids: StageIds): StageRoute[] {
    const routes: StageRoute[] = [
        { path: '/', label: 'home route', waitForText: /Заказы|Orders/i },
        { path: '/orders', label: 'orders list', waitForText: /Заказы|Orders/i },
        ...recordRoutes('/orders', 'orders', ids.orders, false),
        { path: '/calendar', label: 'calendar list', waitForText: 'Производственный календарь' },
        { path: '/doweling-orders', label: 'doweling orders list' },
        ...recordRoutes('/doweling-orders', 'doweling orders', ids.doweling_orders_view, false),
        ...crudRoutes('/materials', 'materials', ids.materials),
        ...crudRoutes('/milling-types', 'milling types', ids.milling_types),
        ...crudRoutes('/films', 'films', ids.films),
        ...crudRoutes('/clients', 'clients', ids.clients),
        { path: '/clients-analytics', label: 'clients analytics list' },
        ...showRoute('/clients-analytics', 'clients analytics', ids.clients_analytics_view),
        ...crudRoutes('/edge-types', 'edge types', ids.edge_types),
        ...crudRoutes('/vendors', 'vendors', ids.vendors),
        ...crudRoutes('/suppliers', 'suppliers', ids.suppliers),
        ...crudRoutes('/film-types', 'film types', ids.film_types),
        ...crudRoutes('/material-types', 'material types', ids.material_types),
        ...crudRoutes('/order-statuses', 'order statuses', ids.order_statuses),
        ...crudRoutes('/payment-statuses', 'payment statuses', ids.payment_statuses),
        ...crudRoutes('/payment-types', 'payment types', ids.payment_types),
        ...crudRoutes('/units', 'units', ids.units),
        ...crudRoutes('/payments', 'payments', ids.payments),
        { path: '/payments-analytics', label: 'payments analytics list' },
        ...showRoute('/payments-analytics', 'payments analytics', ids.payments_view),
        ...crudRoutes('/requisition-statuses', 'requisition statuses', ids.requisition_statuses),
        ...crudRoutes('/movements-statuses', 'movement statuses', ids.movements_statuses),
        ...crudRoutes(
            '/material-transaction-types',
            'material transaction types',
            ids.material_transaction_types,
        ),
        ...crudRoutes('/transaction-direction', 'transaction direction', ids.transaction_direction),
        ...crudRoutes('/production-statuses', 'production statuses', ids.production_statuses),
        ...crudRoutes(
            '/resource-requirements-statuses',
            'resource requirement statuses',
            ids.resource_requirements_statuses,
        ),
        ...crudRoutes('/employees', 'employees', ids.employees),
        ...crudRoutes('/users', 'users', ids.users),
        {
            path: '/configuration',
            label: 'configuration',
            waitForText: /Конфигурация|Этапы производства|Финансы/i,
        },
        ...crudRoutes('/workshops', 'workshops', ids.workshops),
        ...crudRoutes('/work-centers', 'work centers', ids.work_centers),
        ...crudRoutes('/order-workshops', 'order workshops', ids.order_workshops),
        ...crudRoutes(
            '/order-resource-requirements',
            'order resource requirements',
            ids.order_resource_requirements,
        ),
    ];

    return routes;
}

function crudRoutes(basePath: string, label: string, id: number | null): StageRoute[] {
    return [
        { path: basePath, label: `${label} list` },
        { path: `${basePath}/create`, label: `${label} create` },
        ...recordRoutes(basePath, label, id, false),
    ];
}

function showRoute(basePath: string, label: string, id: number | null): StageRoute[] {
    if (id === null || id === undefined) {
        return [];
    }

    return [{ path: `${basePath}/show/${id}`, label: `${label} show` }];
}

function recordRoutes(
    basePath: string,
    label: string,
    id: number | null,
    includeCreate: boolean,
): StageRoute[] {
    const routes: StageRoute[] = [];
    if (includeCreate) {
        routes.push({ path: `${basePath}/create`, label: `${label} create` });
    }
    if (id === null || id === undefined) {
        return routes;
    }

    routes.push(
        { path: `${basePath}/edit/${id}`, label: `${label} edit` },
        { path: `${basePath}/show/${id}`, label: `${label} show` },
    );
    return routes;
}

async function assertStagePageReady(page: Page, route: StageRoute) {
    await expect(page).toHaveURL(new RegExp(`${escapeRegex(route.path)}(?:[?#].*)?$`));

    let content = page.locator('body');
    const visibleLayoutContent = page.locator('.ant-layout-content:visible');
    if (await visibleLayoutContent.count()) {
        content = visibleLayoutContent.last();
    }
    await expect(content).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('Произошла ошибка')).toHaveCount(0);
    await expect(page.getByText('Ошибка загрузки данных')).toHaveCount(0);
    await expect(page.getByText(/GraphQL запрос:/)).toHaveCount(0);
    await expect(page.getByText(ORDERS_VIEW_VERSION_SCHEMA_ERROR)).toHaveCount(0);
    await expect(page.locator('.ant-spin-spinning')).toHaveCount(0, { timeout: 30000 });
    if (route.waitForText) {
        await expect(page.getByText(route.waitForText).first()).toBeVisible({ timeout: 30000 });
    } else {
        await expect(page.locator('main').getByText(stagePageContentPattern).first()).toBeVisible({
            timeout: 10000,
        });
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

function recordHttpErrors(page: Page): string[] {
    const errors: string[] = [];

    page.on('response', (response) => {
        if (response.ok() || !isTrackedHttpUrl(response.url())) return;

        errors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    });

    return errors;
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

function loadStageIds(): StageIds {
    return JSON.parse(
        psql(`
            SELECT jsonb_build_object(
                'orders', (SELECT min(order_id) FROM orders),
                'doweling_orders_view', (SELECT min(doweling_order_id) FROM doweling_orders_view),
                'materials', (SELECT min(material_id) FROM materials),
                'milling_types', (SELECT min(milling_type_id) FROM milling_types),
                'films', (SELECT min(film_id) FROM films),
                'clients', (SELECT min(client_id) FROM clients),
                'clients_analytics_view', (SELECT min(client_id) FROM clients_analytics_view),
                'edge_types', (SELECT min(edge_type_id) FROM edge_types),
                'vendors', (SELECT min(vendor_id) FROM vendors),
                'suppliers', (SELECT min(supplier_id) FROM suppliers),
                'film_types', (SELECT min(film_type_id) FROM film_types),
                'material_types', (SELECT min(material_type_id) FROM material_types),
                'order_statuses', (SELECT min(order_status_id) FROM order_statuses),
                'payment_statuses', (SELECT min(payment_status_id) FROM payment_statuses),
                'payment_types', (SELECT min(type_paid_id) FROM payment_types),
                'units', (SELECT min(unit_id) FROM units),
                'payments', (SELECT min(payment_id) FROM payments),
                'payments_view', (SELECT min(payment_id) FROM payments_view),
                'requisition_statuses', (SELECT min(requisition_status_id) FROM requisition_statuses),
                'movements_statuses', (SELECT min(movement_status_id) FROM movements_statuses),
                'material_transaction_types', (SELECT min(transaction_type_id) FROM material_transaction_types),
                'transaction_direction', (SELECT min(direction_type_id) FROM transaction_direction),
                'production_statuses', (SELECT min(production_status_id) FROM production_statuses),
                'resource_requirements_statuses', (SELECT min(requirement_status_id) FROM resource_requirements_statuses),
                'employees', (SELECT min(employee_id) FROM employees),
                'users', (SELECT min(user_id) FROM users),
                'workshops', (SELECT min(workshop_id) FROM workshops),
                'work_centers', (SELECT min(workcenter_id) FROM work_centers),
                'order_workshops', (SELECT min(order_workshop_id) FROM order_workshops),
                'order_resource_requirements', (SELECT min(requirement_id) FROM order_resource_requirements)
            )::text;
        `),
    );
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
                    'E2E Test Frontend Pages Stage Canary',
                    true
                )
                RETURNING user_id
            )
            SELECT user_id FROM inserted;
        `),
    );
}

function getStageCredentials(): { username: string; password: string; userId: number | null } {
    const username = process.env.FRONTEND_PAGES_STAGE_USERNAME;
    const password = process.env.FRONTEND_PAGES_STAGE_PASSWORD;
    if (username && password) {
        return { username, password, userId: null };
    }

    if (!createUserEnabled) {
        throw new Error(
            'Set FRONTEND_PAGES_STAGE_USERNAME and FRONTEND_PAGES_STAGE_PASSWORD for a read-only stage canary, ' +
                'or set FRONTEND_PAGES_STAGE_CREATE_USER=true to create and deactivate a temporary smoke user.',
        );
    }

    const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto
        .randomBytes(4)
        .toString('hex')}`;
    const smokeUsername = `e2e_test_frontend_pages_${runId}`;
    const smokePassword = crypto.randomBytes(24).toString('base64url');

    return {
        username: smokeUsername,
        password: smokePassword,
        userId: createSmokeUser(smokeUsername, smokePassword),
    };
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
            'erp_dev-postgresdb-1',
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

function sqlQuote(value: string) {
    return value.replaceAll("'", "''");
}

function isGraphqlUrl(url: string) {
    return url.includes('/v1/graphql');
}

function isTrackedHttpUrl(url: string) {
    return (
        (url.startsWith(stageFrontendUrl) &&
            (url.includes('/api/') || url.endsWith('/runtime-config.json'))) ||
        (url.startsWith(stageBackendApiUrl) && url.includes('/api/'))
    );
}

function isAllowedConsoleError(message: string) {
    return /Download the React DevTools/.test(message);
}

function trimTrailingSlash(value: string) {
    return value.replace(/\/+$/, '');
}

function escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const stagePageContentPattern =
    /ID|Список|Создать|Редактировать|Обновить|Сохранить|Показать|Заказы|Календарь|Конфигурация|Присадка|Клиент|Статус|Действия|Активен|titles\./i;
