import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const canaryEnabled = process.env.PAYMENTS_STAGE_CANARY === 'true';
const frontendUrl = trimTrailingSlash(
    process.env.PAYMENTS_STAGE_FRONTEND_URL ?? 'https://stage.mebelkz.app',
);
const backendApiUrl = trimTrailingSlash(
    process.env.PAYMENTS_STAGE_BACKEND_API_URL ?? 'https://backend.dev.mebelkz.app/api/v1',
);
const testOrderId = readNumberEnv('PAYMENTS_STAGE_ORDER_ID', 11151);
const testOrderName =
    process.env.PAYMENTS_STAGE_ORDER_NAME ?? 'Тест_StageSmoke_20260507111100';
const paymentTypeName = process.env.PAYMENTS_STAGE_PAYMENT_TYPE_NAME ?? 'нал';
const paymentDateUi = process.env.PAYMENTS_STAGE_PAYMENT_DATE_UI ?? '10.05.2026';
const paymentDateSql = process.env.PAYMENTS_STAGE_PAYMENT_DATE_SQL ?? '2026-05-10';
const createAmount = readNumberEnv('PAYMENTS_STAGE_CREATE_AMOUNT', 345.67);
const updateAmount = readNumberEnv('PAYMENTS_STAGE_UPDATE_AMOUNT', 456.78);

test.describe('Payments stage canary', () => {
    test.skip(!canaryEnabled, 'Run with PAYMENTS_STAGE_CANARY=true');
    test.setTimeout(180000);

    let accessToken: string | null = null;
    let baseline: OrderSnapshot | null = null;
    let paymentId: number | null = null;
    let userId: number | null = null;

    test.afterEach(async ({ request }) => {
        await cleanupPayment(request, paymentId, accessToken, baseline);
        await cleanupUser(userId);
    });

    test('creates and updates payments through UI, deletes through backend, and verifies DB effects', async ({
        page,
        request,
    }) => {
        const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const username = `e2e_test_payments_ui_${runId}`;
        const password = crypto.randomBytes(24).toString('base64url');
        const noteCreate = `E2E-Тест payments UI canary ${runId} create`;
        const noteUpdate = `E2E-Тест payments UI canary ${runId} update`;
        const graphqlPaymentMutations: string[] = [];
        const paymentApiCalls: string[] = [];

        baseline = loadOrderSnapshot(testOrderId);
        expect(baseline.orderName).toBe(testOrderName);
        expect(isTestOrderName(baseline.orderName)).toBe(true);

        userId = createSmokeUser(username, password);
        accessToken = await loginForApiToken(request, username, password);

        await expectBackendPaymentsRuntimeConfig(request);
        recordPaymentNetwork(page, paymentApiCalls, graphqlPaymentMutations);
        await loginThroughUi(page, username, password);

        const basePaidAmount = toMoney(baseline.paidAmount);
        const createExpectedPaid = toMoney(basePaidAmount + createAmount);
        const updateExpectedPaid = toMoney(basePaidAmount + updateAmount);
        const expectedMutationPaymentDate = maxDate(baseline.paymentDate, paymentDateSql);
        const baselineVersion = Number(baseline.version);

        await page.goto(`${frontendUrl}/payments/create`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText('Создание платежа')).toBeVisible({ timeout: 30000 });
        await selectAntdOption(page, 'Заказ', testOrderName);
        await selectAntdOption(page, 'Тип оплаты', paymentTypeName);
        await page.locator('#amount').fill(String(createAmount));
        await fillDatePicker(page, '#payment_date', paymentDateUi);
        await page.locator('#notes').fill(noteCreate);

        const createResponsePromise = waitForPaymentApiResponse(page, 'POST');
        await page.getByRole('button', { name: 'Сохранить' }).click();
        const createResponse = await createResponsePromise;
        expect(createResponse.ok()).toBe(true);
        await expect(page).toHaveURL(/\/payments\?highlightId=\d+/, { timeout: 30000 });

        paymentId = readHighlightId(page.url());
        expect(paymentId).toBeGreaterThan(0);

        let row = loadPaymentSnapshot(paymentId);
        expect(row.createdBy).toBe(userId);
        expect(row.editedBy).toBeNull();
        expect(toMoney(row.amount)).toBe(toMoney(createAmount));
        expect(row.paymentDate).toBe(paymentDateSql);
        expect(row.notes).toBe(noteCreate);
        expect(Number(row.auditCreateCount)).toBeGreaterThanOrEqual(1);
        expectOrderState(row, baseline, {
            paidAmount: createExpectedPaid,
            paymentDate: expectedMutationPaymentDate,
            version: baselineVersion + 1,
        });

        await page.goto(`${frontendUrl}/payments/edit/${paymentId}`, {
            waitUntil: 'domcontentloaded',
        });
        await expect(page.getByText('Редактирование платежа')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('#amount')).toHaveValue(/^345\.67(?:0*)?$/);
        await page.locator('#amount').fill(String(updateAmount));
        await page.locator('#notes').fill(noteUpdate);

        const updateResponsePromise = waitForPaymentApiResponse(page, 'PATCH', paymentId);
        await page.getByRole('button', { name: 'Сохранить' }).click();
        const updateResponse = await updateResponsePromise;
        expect(updateResponse.ok()).toBe(true);
        await expect(page).toHaveURL(new RegExp(`/payments/show/${paymentId}`), {
            timeout: 30000,
        });

        row = loadPaymentSnapshot(paymentId);
        expect(row.createdBy).toBe(userId);
        expect(row.editedBy).toBe(userId);
        expect(toMoney(row.amount)).toBe(toMoney(updateAmount));
        expect(row.notes).toBe(noteUpdate);
        expect(Number(row.auditUpdateCount)).toBeGreaterThanOrEqual(1);
        expectOrderState(row, baseline, {
            paidAmount: updateExpectedPaid,
            paymentDate: expectedMutationPaymentDate,
            version: baselineVersion + 2,
        });

        await deletePaymentViaBackend(request, paymentId, accessToken);
        const afterDelete = loadDeletedPaymentSnapshot(paymentId, testOrderId);
        expect(afterDelete.paymentExists).toBe(false);
        expect(Number(afterDelete.auditDeleteCount)).toBeGreaterThanOrEqual(1);
        expectOrderState(afterDelete, baseline, {
            paidAmount: basePaidAmount,
            paymentDate: baseline.paymentDate,
            version: baselineVersion + 3,
        });
        paymentId = null;

        expect(paymentApiCalls).toContain('POST /api/v1/payments');
        expect(paymentApiCalls).toContain(`PATCH /api/v1/payments/${row.paymentId}`);
        expect(graphqlPaymentMutations).toEqual([]);
    });
});

async function expectBackendPaymentsRuntimeConfig(request: APIRequestContext) {
    const response = await request.get(`${frontendUrl}/runtime-config.json`);
    expect(response.ok()).toBe(true);
    const runtimeConfig = await response.json();
    expect(runtimeConfig.features?.backendPayments).toBe(true);
    expect(runtimeConfig.features?.backendAuth).toBe(true);
}

function recordPaymentNetwork(
    page: Page,
    paymentApiCalls: string[],
    graphqlPaymentMutations: string[],
) {
    page.on('request', (request) => {
        const url = request.url();
        const method = request.method();

        if (url.includes('/api/v1/payments')) {
            paymentApiCalls.push(`${method} ${new URL(url).pathname}`);
        }

        if (url.includes('/v1/graphql') && method === 'POST') {
            const body = request.postData() ?? '';
            if (/\b(?:insert|update|delete)_payments\b/.test(body)) {
                graphqlPaymentMutations.push(body.slice(0, 200));
            }
        }
    });
}

async function loginThroughUi(page: Page, username: string, password: string) {
    await page.goto(`${frontendUrl}/login`, { waitUntil: 'domcontentloaded' });
    const loginResponsePromise = page.waitForResponse(
        (response) =>
            response.url().includes('/api/v1/auth/login') &&
            response.request().method() === 'POST',
    );
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Войти' }).click();
    const loginResponse = await loginResponsePromise;
    expect(loginResponse.ok()).toBe(true);
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30000 });
}

async function loginForApiToken(
    request: APIRequestContext,
    username: string,
    password: string,
): Promise<string> {
    const response = await request.post(`${backendApiUrl}/auth/login`, {
        data: { username, password },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(typeof body.accessToken).toBe('string');
    return body.accessToken;
}

function waitForPaymentApiResponse(page: Page, method: string, id?: number) {
    return page.waitForResponse((response) => {
        const url = response.url();
        if (!url.includes('/api/v1/payments')) return false;
        if (response.request().method() !== method) return false;

        return id === undefined || new URL(url).pathname.endsWith(`/payments/${id}`);
    });
}

async function selectAntdOption(
    page: Page,
    label: string,
    searchText: string,
    optionText = searchText,
) {
    const item = formItem(page, label);
    await item.locator('.ant-select').first().click();
    const searchInput = item.locator('.ant-select-selection-search-input').first();
    if (await searchInput.count()) {
        await searchInput.fill(searchText);
    } else {
        await page.keyboard.type(searchText);
    }

    const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    const option = dropdown.getByText(optionText, { exact: false }).first();
    await expect(option).toBeVisible({ timeout: 15000 });
    await option.click();
}

async function fillDatePicker(page: Page, selector: string, value: string) {
    await page.locator(selector).click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
}

function formItem(page: Page, label: string) {
    return page.locator('.ant-form-item').filter({ hasText: label }).first();
}

async function deletePaymentViaBackend(
    request: APIRequestContext,
    id: number,
    token: string | null,
) {
    expect(token).toBeTruthy();
    const response = await request.delete(`${backendApiUrl}/payments/${id}`, {
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });
    expect(response.ok()).toBe(true);
}

async function cleanupPayment(
    request: APIRequestContext,
    id: number | null,
    token: string | null,
    baselineOrder: OrderSnapshot | null,
) {
    if (!id || !paymentExists(id)) return;

    if (token) {
        const response = await request.delete(`${backendApiUrl}/payments/${id}`, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });
        if (response.ok()) return;
    }

    psql(`DELETE FROM payments WHERE payment_id = ${id};`);
    if (baselineOrder) {
        psql(`
            UPDATE orders
            SET paid_amount = ${toMoney(baselineOrder.paidAmount)},
                payment_date = ${
                    baselineOrder.paymentDate === null
                        ? 'NULL'
                        : `DATE '${sqlQuote(baselineOrder.paymentDate)}'`
                },
                payment_status_id = ${Number(baselineOrder.paymentStatusId)},
                version = ${Number(baselineOrder.version)}
            WHERE order_id = ${Number(baselineOrder.orderId)};
        `);
    }
}

async function cleanupUser(id: number | null) {
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
                    'E2E Test Payments Stage Canary',
                    true
                )
                RETURNING user_id
            )
            SELECT user_id FROM inserted;
        `),
    );
}

function loadOrderSnapshot(orderId: number): OrderSnapshot {
    return psql<OrderSnapshot>(
        `
        SELECT json_build_object(
            'orderId', order_id,
            'orderName', order_name,
            'finalAmount', final_amount::text,
            'paidAmount', paid_amount::text,
            'paymentDate', payment_date::text,
            'paymentStatusId', payment_status_id,
            'version', version
        )::text
        FROM orders
        WHERE order_id = ${orderId}
          AND delete_flag = false;
        `,
        { json: true },
    );
}

function loadPaymentSnapshot(id: number): PaymentSnapshot {
    return psql<PaymentSnapshot>(
        `
        SELECT json_build_object(
            'paymentId', p.payment_id,
            'orderId', p.order_id,
            'amount', p.amount::text,
            'paymentDate', p.payment_date::text,
            'notes', p.notes,
            'createdBy', p.created_by,
            'editedBy', p.edited_by,
            'orderPaidAmount', o.paid_amount::text,
            'orderPaymentDate', o.payment_date::text,
            'orderPaymentStatusId', o.payment_status_id,
            'orderVersion', o.version,
            'auditCreateCount', (
                SELECT count(*) FROM audit_log
                WHERE event = 'payments.create' AND entity_id = p.payment_id::text
            ),
            'auditUpdateCount', (
                SELECT count(*) FROM audit_log
                WHERE event = 'payments.update' AND entity_id = p.payment_id::text
            ),
            'auditDeleteCount', (
                SELECT count(*) FROM audit_log
                WHERE event = 'payments.delete' AND entity_id = p.payment_id::text
            )
        )::text
        FROM payments p
        JOIN orders o ON o.order_id = p.order_id
        WHERE p.payment_id = ${id};
        `,
        { json: true },
    );
}

function loadDeletedPaymentSnapshot(id: number, orderId: number): DeletedPaymentSnapshot {
    return psql<DeletedPaymentSnapshot>(
        `
        SELECT json_build_object(
            'paymentExists', EXISTS (SELECT 1 FROM payments WHERE payment_id = ${id}),
            'orderPaidAmount', o.paid_amount::text,
            'orderPaymentDate', o.payment_date::text,
            'orderPaymentStatusId', o.payment_status_id,
            'orderVersion', o.version,
            'auditCreateCount', (
                SELECT count(*) FROM audit_log
                WHERE event = 'payments.create' AND entity_id = '${sqlQuote(String(id))}'
            ),
            'auditUpdateCount', (
                SELECT count(*) FROM audit_log
                WHERE event = 'payments.update' AND entity_id = '${sqlQuote(String(id))}'
            ),
            'auditDeleteCount', (
                SELECT count(*) FROM audit_log
                WHERE event = 'payments.delete' AND entity_id = '${sqlQuote(String(id))}'
            )
        )::text
        FROM orders o
        WHERE o.order_id = ${orderId};
        `,
        { json: true },
    );
}

function expectOrderState(
    actual: Pick<
        PaymentSnapshot | DeletedPaymentSnapshot,
        'orderPaidAmount' | 'orderPaymentDate' | 'orderPaymentStatusId' | 'orderVersion'
    >,
    baselineOrder: OrderSnapshot,
    expected: {
        paidAmount: number;
        paymentDate: string | null;
        version: number;
    },
) {
    const expectedStatus = expectedPaymentStatusId(
        toMoney(baselineOrder.finalAmount),
        expected.paidAmount,
    );

    expect(toMoney(actual.orderPaidAmount)).toBe(toMoney(expected.paidAmount));
    expect(actual.orderPaymentDate).toBe(expected.paymentDate);
    expect(Number(actual.orderPaymentStatusId)).toBe(expectedStatus);
    expect(Number(actual.orderVersion)).toBe(expected.version);
}

function expectedPaymentStatusId(finalAmount: number, paidAmount: number): number {
    if (paidAmount <= 0) return 1;
    if (paidAmount < finalAmount) return 2;
    return 3;
}

function readHighlightId(url: string): number {
    return Number(new URL(url).searchParams.get('highlightId'));
}

function paymentExists(id: number): boolean {
    return psql(`SELECT EXISTS (SELECT 1 FROM payments WHERE payment_id = ${id});`) === 't';
}

function isTestOrderName(value: string): boolean {
    return value.startsWith('Тест') || value.startsWith('E2E-Тест') || value.startsWith('E2E');
}

function maxDate(left: string | null, right: string): string {
    if (!left) return right;
    return left > right ? left : right;
}

function toMoney(value: string | number): number {
    return Number(Number(value).toFixed(2));
}

function readNumberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        throw new Error(`${name} must be a finite number`);
    }
    return value;
}

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '');
}

function sqlQuote(value: string): string {
    return value.replace(/'/g, "''");
}

function psql<T>(sql: string, options: { json: true }): T;
function psql(sql: string, options?: { json?: false }): string;
function psql(sql: string, options: { json?: boolean } = {}): unknown {
    const output = execFileSync(
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
            '-qAtX',
            '-v',
            'ON_ERROR_STOP=1',
        ],
        {
            input: sql,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
        },
    ).trim();

    if (!options.json) return output;
    if (!output) {
        throw new Error(`Expected JSON from SQL, got empty output for: ${sql.slice(0, 120)}`);
    }

    return JSON.parse(output);
}

interface OrderSnapshot {
    orderId: number;
    orderName: string;
    finalAmount: string;
    paidAmount: string;
    paymentDate: string | null;
    paymentStatusId: number;
    version: number;
}

interface PaymentSnapshot {
    paymentId: number;
    orderId: number;
    amount: string;
    paymentDate: string;
    notes: string;
    createdBy: number;
    editedBy: number | null;
    orderPaidAmount: string;
    orderPaymentDate: string | null;
    orderPaymentStatusId: number;
    orderVersion: number;
    auditCreateCount: string;
    auditUpdateCount: string;
    auditDeleteCount: string;
}

interface DeletedPaymentSnapshot {
    paymentExists: boolean;
    orderPaidAmount: string;
    orderPaymentDate: string | null;
    orderPaymentStatusId: number;
    orderVersion: number;
    auditCreateCount: string;
    auditUpdateCount: string;
    auditDeleteCount: string;
}
