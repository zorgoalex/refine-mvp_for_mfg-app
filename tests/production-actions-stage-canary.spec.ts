import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const canaryEnabled = process.env.PRODUCTION_ACTIONS_STAGE_CANARY === 'true';
const frontendUrl = trimTrailingSlash(
    process.env.PRODUCTION_ACTIONS_STAGE_FRONTEND_URL ?? 'https://stage.mebelkz.app',
);
const backendApiUrl = trimTrailingSlash(
    process.env.PRODUCTION_ACTIONS_STAGE_BACKEND_API_URL ??
        'https://backend.dev.mebelkz.app/api/v1',
);
const testOrderId = readNumberEnv('PRODUCTION_ACTIONS_STAGE_ORDER_ID', 11151);
const testOrderName =
    process.env.PRODUCTION_ACTIONS_STAGE_ORDER_NAME ?? 'Тест_StageSmoke';
const postgresContainer =
    process.env.PRODUCTION_ACTIONS_STAGE_POSTGRES_CONTAINER ?? 'erp_dev-postgresdb-1';
const vercelAutomationBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();

test.describe('Production actions stage canary', () => {
    test.skip(!canaryEnabled, 'Run with PRODUCTION_ACTIONS_STAGE_CANARY=true');
    test.setTimeout(180000);

    let accessToken: string | null = null;
    let baseline: OrderSnapshot | null = null;
    let userId: number | null = null;
    let productionStatusId: number | null = null;

    test.afterEach(async () => {
        cleanupOrder(baseline, productionStatusId);
        cleanupUser(userId);
    });

    test('writes production actions through backend and verifies audit/outbox/idempotency', async ({
        request,
    }) => {
        const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const username = `e2e_test_production_actions_${runId}`;
        const password = crypto.randomBytes(24).toString('base64url');
        const startedAt = psql('SELECT now()::text;');

        baseline = loadOrderSnapshot(testOrderId);
        expect(baseline.orderName).toBe(testOrderName);
        expect(isTestOrderName(baseline.orderName)).toBe(true);
        expect(Number(baseline.ordersViewVersion)).toBe(Number(baseline.version));

        const orderStatus = loadNextOrderStatus(Number(baseline.orderStatusId));
        const productionStatus = loadUnusedProductionStatus(testOrderId);
        expect(orderStatus).not.toBeNull();
        expect(productionStatus).not.toBeNull();
        productionStatusId = productionStatus!.productionStatusId;

        userId = createSmokeUser(username, password);
        accessToken = await loginForApiToken(request, username, password);
        await expectRuntimeConfig(request);

        const calendarDate = choosePlannedCompletionDate(baseline);
        const keys = {
            calendar: `production-actions-calendar:${runId}`,
            status: `production-actions-status:${runId}`,
            stageActivate: `production-actions-stage-activate:${runId}`,
            stageDeactivate: `production-actions-stage-deactivate:${runId}`,
        };

        const calendarResponse = await patchJson<ProductionActionResponse>(
            request,
            `/orders/${testOrderId}/calendar-date`,
            accessToken,
            {
                plannedCompletionDate: calendarDate,
                version: Number(baseline.version),
                idempotencyKey: keys.calendar,
            },
        );
        expect(calendarResponse.order.version).toBe(Number(baseline.version) + 1);

        const statusResponse = await patchJson<ProductionActionResponse>(
            request,
            `/orders/${testOrderId}/status`,
            accessToken,
            {
                orderStatusId: orderStatus!.orderStatusId,
                version: calendarResponse.order.version,
                idempotencyKey: keys.status,
            },
        );
        expect(statusResponse.order.version).toBe(Number(baseline.version) + 2);

        const activateResponse = await putJson<ProductionActionResponse>(
            request,
            `/orders/${testOrderId}/production-stage-events/${productionStatus!.productionStatusId}`,
            accessToken,
            {
                version: statusResponse.order.version,
                idempotencyKey: keys.stageActivate,
            },
        );
        expect(activateResponse.order.version).toBe(Number(baseline.version) + 3);
        expect(activateResponse.event?.active).toBe(true);
        expect(activateResponse.event?.productionEventId).toBeGreaterThan(0);

        const deactivateResponse = await deleteJson<ProductionActionResponse>(
            request,
            `/orders/${testOrderId}/production-stage-events/${productionStatus!.productionStatusId}`,
            accessToken,
            {
                version: activateResponse.order.version,
                idempotencyKey: keys.stageDeactivate,
            },
        );
        expect(deactivateResponse.order.version).toBe(Number(baseline.version) + 4);
        expect(deactivateResponse.event?.active).toBe(false);

        const replayResponse = await patchJson<ProductionActionResponse>(
            request,
            `/orders/${testOrderId}/calendar-date`,
            accessToken,
            {
                plannedCompletionDate: calendarDate,
                version: Number(baseline.version),
                idempotencyKey: keys.calendar,
            },
        );
        expect(replayResponse.order.version).toBe(calendarResponse.order.version);

        const after = loadOrderSnapshot(testOrderId);
        expect(after.plannedCompletionDate).toBe(calendarDate);
        expect(Number(after.orderStatusId)).toBe(orderStatus!.orderStatusId);
        expect(Number(after.version)).toBe(Number(baseline.version) + 4);
        expect(productionEventExists(testOrderId, productionStatus!.productionStatusId)).toBe(false);

        const db = loadCommandSnapshot({
            orderId: testOrderId,
            orderStatusId: orderStatus!.orderStatusId,
            productionStatus: productionStatus!,
            productionEventId: activateResponse.event!.productionEventId!,
            startedAt,
            keys,
        });
        expect(Number(db.calendarAuditCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.statusAuditCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.stageActivateAuditCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.stageDeactivateAuditCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.calendarOutboxCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.deadlineOutboxCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.statusOutboxCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.stageActivateOutboxCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.stageDeactivateOutboxCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.completedCommandCount)).toBe(4);
    });
});

async function expectRuntimeConfig(request: APIRequestContext) {
    const response = await request.get(`${frontendUrl}/runtime-config.json`, {
        headers: frontendRequestHeaders(),
    });
    await expectOk(response);
    const runtimeConfig = await response.json();
    expect(runtimeConfig.features?.backendAuth).toBe(true);
    expect(runtimeConfig.features?.backendPayments).toBe(true);
    expect(runtimeConfig.features?.backendProductionActions).toBe(true);
}

function frontendRequestHeaders(): Record<string, string> {
    if (!vercelAutomationBypassSecret) return {};
    return { 'x-vercel-protection-bypass': vercelAutomationBypassSecret };
}

async function loginForApiToken(
    request: APIRequestContext,
    username: string,
    password: string,
): Promise<string> {
    const response = await request.post(`${backendApiUrl}/auth/login`, {
        data: { username, password },
    });
    await expectOk(response);
    const body = await response.json();
    expect(typeof body.accessToken).toBe('string');
    return body.accessToken;
}

async function patchJson<T>(
    request: APIRequestContext,
    path: string,
    token: string | null,
    data: unknown,
): Promise<T> {
    const response = await request.patch(`${backendApiUrl}${path}`, {
        headers: authHeaders(token),
        data,
    });
    await expectOk(response);
    return response.json() as Promise<T>;
}

async function putJson<T>(
    request: APIRequestContext,
    path: string,
    token: string | null,
    data: unknown,
): Promise<T> {
    const response = await request.put(`${backendApiUrl}${path}`, {
        headers: authHeaders(token),
        data,
    });
    await expectOk(response);
    return response.json() as Promise<T>;
}

async function deleteJson<T>(
    request: APIRequestContext,
    path: string,
    token: string | null,
    data: unknown,
): Promise<T> {
    const response = await request.delete(`${backendApiUrl}${path}`, {
        headers: authHeaders(token),
        data,
    });
    await expectOk(response);
    return response.json() as Promise<T>;
}

async function expectOk(response: APIResponse) {
    const body = response.ok() ? '' : await response.text();
    expect(response.ok(), body).toBe(true);
}

function authHeaders(token: string | null) {
    expect(token).toBeTruthy();
    return {
        Authorization: `Bearer ${token}`,
    };
}

function loadOrderSnapshot(orderId: number): OrderSnapshot {
    return psql<OrderSnapshot>(
        `
        SELECT json_build_object(
            'orderId', o.order_id,
            'orderName', o.order_name,
            'orderDate', o.order_date::text,
            'plannedCompletionDate', o.planned_completion_date::text,
            'orderStatusId', o.order_status_id,
            'version', o.version,
            'ordersViewVersion', ov.version
        )::text
        FROM orders o
        JOIN orders_view ov ON ov.order_id = o.order_id
        WHERE o.order_id = ${orderId}
          AND o.delete_flag = false;
        `,
        { json: true },
    );
}

function loadNextOrderStatus(currentStatusId: number): OrderStatusTarget | null {
    return psqlJsonOrNull<OrderStatusTarget>(`
        SELECT json_build_object(
            'orderStatusId', order_status_id,
            'orderStatusName', order_status_name
        )::text
        FROM order_statuses
        WHERE is_active = true
          AND order_status_id <> ${currentStatusId}
        ORDER BY sort_order NULLS LAST, order_status_id
        LIMIT 1;
    `);
}

function loadUnusedProductionStatus(orderId: number): ProductionStatusTarget | null {
    return psqlJsonOrNull<ProductionStatusTarget>(`
        SELECT json_build_object(
            'productionStatusId', ps.production_status_id,
            'productionStatusName', ps.production_status_name,
            'productionStatusCode', ps.production_status_code
        )::text
        FROM production_statuses ps
        WHERE ps.is_active = true
          AND NOT EXISTS (
            SELECT 1
            FROM production_status_events pse
            WHERE pse.order_id = ${orderId}
              AND pse.production_status_id = ps.production_status_id
          )
        ORDER BY ps.sort_order NULLS LAST, ps.production_status_id
        LIMIT 1;
    `);
}

function loadCommandSnapshot(input: {
    orderId: number;
    orderStatusId: number;
    productionStatus: ProductionStatusTarget;
    productionEventId: number;
    startedAt: string;
    keys: Record<'calendar' | 'status' | 'stageActivate' | 'stageDeactivate', string>;
}): CommandSnapshot {
    const keyValues = Object.values(input.keys).map((key) => `'${sqlQuote(key)}'`).join(', ');

    return psql<CommandSnapshot>(
        `
        SELECT json_build_object(
            'calendarAuditCount', (
                SELECT count(*)
                FROM audit_log
                WHERE event = 'orders.calendar_move'
                  AND source = 'backend-production-command'
                  AND related_order_id = ${input.orderId}
                  AND created_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
            ),
            'statusAuditCount', (
                SELECT count(*)
                FROM audit_log
                WHERE event = 'orders.status_change'
                  AND source = 'backend-production-command'
                  AND related_order_id = ${input.orderId}
                  AND status_field = 'orderStatus'
                  AND status_id = ${input.orderStatusId}
                  AND created_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
            ),
            'stageActivateAuditCount', (
                SELECT count(*)
                FROM audit_log
                WHERE event = 'production.stage_activate'
                  AND source = 'backend-production-command'
                  AND related_order_id = ${input.orderId}
                  AND related_production_event_id = ${input.productionEventId}
                  AND status_field = 'productionStage'
                  AND status_id = ${input.productionStatus.productionStatusId}
                  AND status_code = '${sqlQuote(input.productionStatus.productionStatusCode)}'
                  AND stage_code = '${sqlQuote(input.productionStatus.productionStatusCode)}'
                  AND created_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
            ),
            'stageDeactivateAuditCount', (
                SELECT count(*)
                FROM audit_log
                WHERE event = 'production.stage_deactivate'
                  AND source = 'backend-production-command'
                  AND related_order_id = ${input.orderId}
                  AND related_production_event_id = ${input.productionEventId}
                  AND status_field = 'productionStage'
                  AND status_id = ${input.productionStatus.productionStatusId}
                  AND status_code = '${sqlQuote(input.productionStatus.productionStatusCode)}'
                  AND stage_code = '${sqlQuote(input.productionStatus.productionStatusCode)}'
                  AND created_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
            ),
            'calendarOutboxCount', (
                SELECT count(*)
                FROM outbox_events
                WHERE event_type = 'order.calendar_moved'
                  AND idempotency_key = '${sqlQuote(input.keys.calendar)}'
            ),
            'deadlineOutboxCount', (
                SELECT count(*)
                FROM outbox_events
                WHERE event_type = 'deadline.order_sync_requested'
                  AND idempotency_key = '${sqlQuote(input.keys.calendar)}:deadline-sync'
            ),
            'statusOutboxCount', (
                SELECT count(*)
                FROM outbox_events
                WHERE event_type = 'order.status_changed'
                  AND idempotency_key = '${sqlQuote(input.keys.status)}'
            ),
            'stageActivateOutboxCount', (
                SELECT count(*)
                FROM outbox_events
                WHERE event_type = 'production.stage_activated'
                  AND idempotency_key = '${sqlQuote(input.keys.stageActivate)}'
            ),
            'stageDeactivateOutboxCount', (
                SELECT count(*)
                FROM outbox_events
                WHERE event_type = 'production.stage_deactivated'
                  AND idempotency_key = '${sqlQuote(input.keys.stageDeactivate)}'
            ),
            'completedCommandCount', (
                SELECT count(*)
                FROM command_idempotency_keys
                WHERE idempotency_key IN (${keyValues})
                  AND status = 'completed'
            )
        )::text;
        `,
        { json: true },
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
                    'E2E Test Production Actions Stage Canary',
                    true
                )
                RETURNING user_id
            )
            SELECT user_id FROM inserted;
        `),
    );
}

function cleanupOrder(order: OrderSnapshot | null, targetProductionStatusId: number | null) {
    if (!order) return;

    if (targetProductionStatusId) {
        psql(`
            DELETE FROM production_status_events
            WHERE order_id = ${Number(order.orderId)}
              AND production_status_id = ${Number(targetProductionStatusId)};
        `);
    }

    psql(`
        UPDATE orders
        SET planned_completion_date = ${
            order.plannedCompletionDate === null
                ? 'NULL'
                : `DATE '${sqlQuote(order.plannedCompletionDate)}'`
        },
            order_status_id = ${Number(order.orderStatusId)},
            version = version + 1
        WHERE order_id = ${Number(order.orderId)}
          AND (
            planned_completion_date IS DISTINCT FROM ${
                order.plannedCompletionDate === null
                    ? 'NULL'
                    : `DATE '${sqlQuote(order.plannedCompletionDate)}'`
            }
            OR order_status_id IS DISTINCT FROM ${Number(order.orderStatusId)}
          );
    `);
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

function productionEventExists(orderId: number, targetProductionStatusId: number): boolean {
    return (
        psql(`
            SELECT EXISTS (
                SELECT 1
                FROM production_status_events
                WHERE order_id = ${orderId}
                  AND production_status_id = ${targetProductionStatusId}
            );
        `) === 't'
    );
}

function choosePlannedCompletionDate(order: OrderSnapshot): string {
    const firstCandidate = addDays(order.orderDate, 1);
    if (order.plannedCompletionDate !== firstCandidate) {
        return firstCandidate;
    }

    return addDays(order.orderDate, 2);
}

function addDays(dateOnly: string, days: number): string {
    const date = new Date(`${dateOnly}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function psqlJsonOrNull<T>(sql: string): T | null {
    const output = psql(sql);
    return output ? (JSON.parse(output) as T) : null;
}

function psql<T>(sql: string, options: { json: true }): T;
function psql(sql: string, options?: { json?: false }): string;
function psql(sql: string, options: { json?: boolean } = {}): unknown {
    const output = execFileSync(
        'docker',
        [
            'exec',
            '-i',
            postgresContainer,
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

function isTestOrderName(value: string): boolean {
    return value.startsWith('Тест') || value.startsWith('E2E-Тест') || value.startsWith('E2E');
}

interface ProductionActionResponse {
    order: {
        orderId: number;
        plannedCompletionDate?: string | null;
        orderStatusId?: number;
        version: number;
    };
    event?: {
        productionEventId?: number;
        productionStatusId: number;
        active: boolean;
    };
    requestId: string;
}

interface OrderSnapshot {
    orderId: number;
    orderName: string;
    orderDate: string;
    plannedCompletionDate: string | null;
    orderStatusId: number;
    version: number;
    ordersViewVersion: number;
}

interface OrderStatusTarget {
    orderStatusId: number;
    orderStatusName: string;
}

interface ProductionStatusTarget {
    productionStatusId: number;
    productionStatusName: string;
    productionStatusCode: string;
}

interface CommandSnapshot {
    calendarAuditCount: string;
    statusAuditCount: string;
    stageActivateAuditCount: string;
    stageDeactivateAuditCount: string;
    calendarOutboxCount: string;
    deadlineOutboxCount: string;
    statusOutboxCount: string;
    stageActivateOutboxCount: string;
    stageDeactivateOutboxCount: string;
    completedCommandCount: string;
}
