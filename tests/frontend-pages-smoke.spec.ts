import { expect, test, type Page } from '@playwright/test';
import {
    createWorkflowMockDb,
    setupWorkflowMockApi,
    type WorkflowMockDb,
} from './helpers/mockWorkflowApi';

type SmokeRoute = {
    path: string;
    label: string;
    expectedPath?: string;
    waitForText?: string | RegExp;
};

const authenticatedRoutes: SmokeRoute[] = [
    { path: '/', label: 'home route', waitForText: /Заказы|Orders/i },
    { path: '/orders', label: 'orders list', waitForText: /Заказы|Orders/i },
    { path: '/orders/edit/15', label: 'orders edit', waitForText: /E2E all-pages order|Основная/i },
    { path: '/orders/show/15', label: 'orders show', waitForText: /E2E all-pages order|Основная/i },
    { path: '/calendar', label: 'calendar list', waitForText: 'Производственный календарь' },
    { path: '/doweling-orders', label: 'doweling orders list' },
    { path: '/doweling-orders/edit/1', label: 'doweling orders edit' },
    { path: '/doweling-orders/show/1', label: 'doweling orders show' },
    ...crudRoutes('/materials', 'materials', 1),
    ...crudRoutes('/milling-types', 'milling types', 1),
    ...crudRoutes('/films', 'films', 1),
    ...crudRoutes('/clients', 'clients', 1),
    { path: '/clients-analytics', label: 'clients analytics list' },
    { path: '/clients-analytics/show/1', label: 'clients analytics show' },
    ...crudRoutes('/edge-types', 'edge types', 1),
    ...crudRoutes('/vendors', 'vendors', 1),
    ...crudRoutes('/suppliers', 'suppliers', 1),
    ...crudRoutes('/film-types', 'film types', 1),
    ...crudRoutes('/material-types', 'material types', 1),
    ...crudRoutes('/order-statuses', 'order statuses', 1),
    ...crudRoutes('/payment-statuses', 'payment statuses', 1),
    ...crudRoutes('/payment-types', 'payment types', 1),
    ...crudRoutes('/units', 'units', 1),
    ...crudRoutes('/payments', 'payments', 1),
    { path: '/payments-analytics', label: 'payments analytics list' },
    { path: '/payments-analytics/show/1', label: 'payments analytics show' },
    ...crudRoutes('/requisition-statuses', 'requisition statuses', 1),
    ...crudRoutes('/movements-statuses', 'movement statuses', 1),
    ...crudRoutes('/material-transaction-types', 'material transaction types', 1),
    ...crudRoutes('/transaction-direction', 'transaction direction', 1),
    ...crudRoutes('/production-statuses', 'production statuses', 1),
    ...crudRoutes('/resource-requirements-statuses', 'resource requirement statuses', 1),
    ...crudRoutes('/employees', 'employees', 1),
    ...crudRoutes('/users', 'users', 1),
    { path: '/configuration', label: 'configuration', waitForText: /Конфигурация|Этапы производства|Финансы/i },
    ...crudRoutes('/workshops', 'workshops', 1),
    ...crudRoutes('/work-centers', 'work centers', 1),
    ...crudRoutes('/order-workshops', 'order workshops', 1),
    ...crudRoutes('/order-resource-requirements', 'order resource requirements', 1),
];

test.describe('Frontend pages smoke', () => {
    test.setTimeout(600000);

    test('renders every registered frontend page without GraphQL or React runtime errors', async ({
        page,
    }) => {
        const db = createWorkflowMockDb();
        seedFrontendPagesDb(db);
        const graphQLErrors: string[] = [];
        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];
        const serverErrors: string[] = [];

        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('console', (message) => {
            if (message.type() === 'error') {
                consoleErrors.push(message.text());
            }
        });
        page.on('response', (response) => {
            if (response.status() >= 500) {
                serverErrors.push(`${response.status()} ${response.url()}`);
            }
        });

        await setupWorkflowMockApi(page, db, {
            onGraphqlError: (message) => graphQLErrors.push(message),
        });
        await setupFrontendPageApiMocks(page);
        await page.clock.setFixedTime(new Date('2026-05-11T09:00:00+05:00'));

        for (const route of authenticatedRoutes) {
            await test.step(route.label, async () => {
                graphQLErrors.length = 0;
                pageErrors.length = 0;
                consoleErrors.length = 0;
                serverErrors.length = 0;

                await page.goto(route.path, { waitUntil: 'domcontentloaded' });
                await assertPageReady(page, route);
                expect(serverErrors, `${route.label} server errors`).toEqual([]);
                expect(graphQLErrors, `${route.label} GraphQL errors`).toEqual([]);
                expect(pageErrors, `${route.label} page errors`).toEqual([]);
                expect(
                    consoleErrors.filter((message) => !isAllowedConsoleError(message)),
                    `${route.label} console errors`,
                ).toEqual([]);
            });
        }
    });

    test('renders the login page for unauthenticated users', async ({ page }) => {
        await page.route(/\/runtime-config\.json$/, async (route) => {
            await route.fulfill({
                status: 404,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'not found' }),
            });
        });

        await page.goto('/login', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            const bodyText = document.body.innerText;
            const hasLoginButton = [...document.querySelectorAll('button')].some((button) =>
                button.textContent?.includes('Войти'),
            );

            return (
                bodyText.includes('ERP Zhihaz') &&
                bodyText.includes('Система управления производством') &&
                Boolean(document.querySelector('input[autocomplete="username"]')) &&
                Boolean(document.querySelector('input[autocomplete="current-password"]')) &&
                hasLoginButton
            );
        });
    });
});

function crudRoutes(basePath: string, label: string, id: number): SmokeRoute[] {
    return [
        { path: basePath, label: `${label} list` },
        { path: `${basePath}/create`, label: `${label} create` },
        { path: `${basePath}/edit/${id}`, label: `${label} edit` },
        { path: `${basePath}/show/${id}`, label: `${label} show` },
    ];
}

async function setupFrontendPageApiMocks(page: Page) {
    await page.route(/\/runtime-config\.json$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                apiUrl: '',
                features: {
                    backendAuth: false,
                    backendPermissions: false,
                    backendOrdersRead: false,
                    backendOrdersWrite: false,
                    backendPayments: false,
                    backendProductionActions: false,
                    backendOrderExport: false,
                    backendUsers: false,
                    backendVlm: false,
                    backendReferences: false,
                },
            }),
        });
    });

    await page.route(/\/api\/vlm\/health$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ok: true,
                providerConfigured: false,
                limits: { maxUploadMb: 20, allowedMimeTypes: ['image/jpeg', 'image/png'] },
            }),
        });
    });

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

async function assertPageReady(page: Page, route: SmokeRoute) {
    await expect(page).toHaveURL(new RegExp(`${escapeRegex(route.expectedPath ?? route.path)}(?:[?#].*)?$`));

    let content = page.locator('body');
    if (await page.locator('.ant-layout-content').count()) {
        content = page.locator('.ant-layout-content').first();
        await expect(content).toBeVisible({ timeout: 30000 });
    } else {
        await expect(content).toBeVisible({ timeout: 30000 });
    }
    await expect(page.getByText('Произошла ошибка')).toHaveCount(0);
    await expect(page.getByText(/GraphQL запрос:/)).toHaveCount(0);
    await expect(page.getByText(/field 'version' not found in type: 'orders_view'/)).toHaveCount(0);
    await expect(async () => {
        await expect(page.locator('.ant-spin-spinning')).toHaveCount(0);
        expect((await content.innerText()).trim().length, `${route.label} rendered content`).toBeGreaterThan(0);
    }).toPass({ timeout: 30000 });

    if (route.waitForText) {
        await expect(page.getByText(route.waitForText).first()).toBeVisible({ timeout: 30000 });
    }
}

function seedFrontendPagesDb(db: WorkflowMockDb) {
    db.orders.push({
        order_id: 15,
        order_name: 'E2E all-pages order',
        client_id: 1,
        manager_id: 1,
        order_date: '2026-05-10',
        planned_completion_date: '2026-05-11',
        order_status_id: 1,
        payment_status_id: 1,
        production_status_id: 1,
        final_amount: 1000,
        total_amount: 1000,
        paid_amount: 0,
        discount: 0,
        surcharge: 0,
        parts_count: 1,
        total_area: 2.5,
        delete_flag: false,
        version: 3,
        created_at: '2026-05-10T00:00:00+05:00',
        updated_at: '2026-05-10T00:00:00+05:00',
    });
    db.order_details.push({
        detail_id: 1,
        order_id: 15,
        detail_number: 1,
        detail_name: 'Фасад тестовый',
        height: 1000,
        width: 500,
        quantity: 1,
        area: 0.5,
        milling_type_id: 1,
        material_id: 1,
        delete_flag: false,
        version: 1,
    });
    db.doweling_orders.push({
        doweling_order_id: 1,
        doweling_order_name: 'E2E doweling order',
        design_engineer_id: 1,
        operator_id: 2,
        payment_status_id: 1,
        production_status_id: 1,
        doweling_order_date: '2026-05-10',
        parts_count: 1,
        total_amount: 100,
        final_amount: 100,
        discount: 0,
        paid_amount: 0,
        delete_flag: false,
        version: 1,
    });
    db.doweling_orders_view.push({
        doweling_order_id: 1,
        doweling_order_name: 'E2E doweling order',
        design_engineer_name: 'Администратор Тестов',
        operator_name: 'Мастер Тестов',
        payment_status_name: 'Не оплачено',
        production_status_name: 'Новый',
        doweling_order_date: '2026-05-10',
        parts_count: 1,
        total_amount: 100,
        final_amount: 100,
        paid_amount: 0,
        version: 1,
    });
    db.payments.push({
        payment_id: 1,
        order_id: 15,
        amount: 100,
        payment_date: '2026-05-10',
        type_paid_id: 1,
        notes: 'E2E payment',
        created_at: '2026-05-10T00:00:00+05:00',
        updated_at: '2026-05-10T00:00:00+05:00',
    });
    db.payments_view.push({
        payment_id: 1,
        order_id: 15,
        amount: 100,
        payment_date: '2026-05-10',
        type_paid_id: 1,
        type_paid_name: 'Наличные',
        order_name: 'E2E all-pages order',
        client_id: 1,
        client_name: 'Базовый клиент',
        notes: 'E2E payment',
    });
    db.clients_analytics_view.push({
        client_id: 1,
        client_name: 'Базовый клиент',
        primary_phone: '+7 701 000 0001',
        orders_total_count: 1,
        total_amount_sum: 1000,
        final_amount_sum: 1000,
        paid_amount_sum: 0,
        debt_sum: 1000,
        has_debt: true,
    });
    db.material_transaction_types.push({
        transaction_type_id: 1,
        transaction_type_code: 'IN',
        transaction_type_name: 'Приход',
        direction_type_id: 1,
        is_active: true,
    });
    db.resource_requirements_statuses.push({
        requirement_status_id: 1,
        requirement_status_name: 'Новая потребность',
        sort_order: 10,
        is_active: true,
    });
    db.work_centers.push({
        workcenter_id: 1,
        workcenter_code: 'WC-1',
        workcenter_name: 'Участок 1',
        workshop_id: 1,
        is_active: true,
    });
    db.order_workshops.push({
        order_workshop_id: 1,
        order_id: 15,
        workshop_id: 1,
        assigned_at: '2026-05-10T00:00:00+05:00',
    });
    db.order_resource_requirements.push({
        requirement_id: 1,
        order_id: 15,
        resource_type: 'material',
        material_id: 1,
        film_id: null,
        edge_type_id: null,
        required_quantity: 1,
        unit_id: 1,
        waste_percentage: 0,
        final_quantity: 1,
        requirement_status_id: 1,
        supplier_id: 1,
        purchase_price: 100,
        requisition_id: null,
        warehouse_id: null,
        reserved_at: null,
        consumed_at: null,
        notes: 'E2E resource requirement',
        calculation_details: null,
        is_active: true,
        ref_key_1c: 'resource-requirement-e2e',
    });
}

function isAllowedConsoleError(message: string) {
    return /Download the React DevTools/.test(message);
}

function escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
