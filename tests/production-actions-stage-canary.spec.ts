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
    test.skip(
        canaryEnabled && !dockerContainerExists(postgresContainer),
        `Stage postgres container ${postgresContainer} is required for production actions stage canary.`,
    );
    test.skip(
        canaryEnabled && !vercelAutomationBypassSecret,
        'VERCEL_AUTOMATION_BYPASS_SECRET is required for protected deployed frontend access.',
    );
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
            productionCurrentStatus: `production-actions-current-status:${runId}`,
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

        const productionCurrentStatusResponse = await patchJson<ProductionActionResponse>(
            request,
            `/orders/${testOrderId}/production-status`,
            accessToken,
            {
                productionStatusId: productionStatus!.productionStatusId,
                version: statusResponse.order.version,
                idempotencyKey: keys.productionCurrentStatus,
            },
        );
        expect(productionCurrentStatusResponse.order.version).toBe(Number(baseline.version) + 3);
        expect(productionCurrentStatusResponse.order.productionStatusId).toBe(
            productionStatus!.productionStatusId,
        );

        const activateResponse = await putJson<ProductionActionResponse>(
            request,
            `/orders/${testOrderId}/production-stage-events/${productionStatus!.productionStatusId}`,
            accessToken,
            {
                version: productionCurrentStatusResponse.order.version,
                idempotencyKey: keys.stageActivate,
            },
        );
        expect(activateResponse.order.version).toBe(Number(baseline.version) + 4);
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
        expect(deactivateResponse.order.version).toBe(Number(baseline.version) + 5);
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

        const productionCurrentReplayResponse = await patchJson<ProductionActionResponse>(
            request,
            `/orders/${testOrderId}/production-status`,
            accessToken,
            {
                productionStatusId: productionStatus!.productionStatusId,
                version: statusResponse.order.version,
                idempotencyKey: keys.productionCurrentStatus,
            },
        );
        expect(productionCurrentReplayResponse.order.version).toBe(
            productionCurrentStatusResponse.order.version,
        );

        const after = loadOrderSnapshot(testOrderId);
        expect(after.plannedCompletionDate).toBe(calendarDate);
        expect(Number(after.orderStatusId)).toBe(orderStatus!.orderStatusId);
        expect(Number(after.productionStatusId)).toBe(productionStatus!.productionStatusId);
        expect(after.productionStatusFromDetailsEnabled).toBe(false);
        for (const detail of after.detailStatuses) {
            expect(Number(detail.productionStatusId)).toBe(productionStatus!.productionStatusId);
        }
        expect(Number(after.version)).toBe(Number(baseline.version) + 5);
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
        expect(Number(db.productionCurrentStatusAuditCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.stageActivateAuditCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.stageDeactivateAuditCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.calendarOutboxCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.deadlineOutboxCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.statusOutboxCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.productionCurrentStatusOutboxCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.stageActivateOutboxCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.stageDeactivateOutboxCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.productionCurrentStatusEventCount)).toBe(0);
        expect(Number(db.completedCommandCount)).toBe(5);
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
            'productionStatusId', o.production_status_id,
            'productionStatusFromDetailsEnabled', o.production_status_from_details_enabled,
            'version', o.version,
            'ordersViewVersion', ov.version,
            'detailStatuses', COALESCE(
                (
                    SELECT json_agg(
                        json_build_object(
                            'detailId', od.detail_id,
                            'productionStatusId', od.production_status_id
                        )
                        ORDER BY od.detail_id
                    )
                    FROM order_details od
                    WHERE od.order_id = o.order_id
                      AND COALESCE(od.delete_flag, false) = false
                ),
                '[]'::json
            )
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
          AND ps.production_status_id IS DISTINCT FROM (
            SELECT production_status_id
            FROM orders
            WHERE order_id = ${orderId}
          )
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
    keys: Record<
        'calendar' | 'status' | 'productionCurrentStatus' | 'stageActivate' | 'stageDeactivate',
        string
    >;
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
            'productionCurrentStatusAuditCount', (
                SELECT count(*)
                FROM audit_log
                WHERE event = 'orders.production_status_change'
                  AND source = 'backend-production-command'
                  AND related_order_id = ${input.orderId}
                  AND status_field = 'productionCurrentStatus'
                  AND status_id = ${input.productionStatus.productionStatusId}
                  AND status_code = '${sqlQuote(input.productionStatus.productionStatusCode)}'
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
            'productionCurrentStatusOutboxCount', (
                SELECT count(*)
                FROM outbox_events
                WHERE event_type = 'order.production_status_changed'
                  AND idempotency_key = '${sqlQuote(input.keys.productionCurrentStatus)}'
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
            'productionCurrentStatusEventCount', (
                SELECT count(*)
                FROM production_status_events
                WHERE order_id = ${input.orderId}
                  AND production_status_id = ${input.productionStatus.productionStatusId}
                  AND event_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
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
            production_status_id = ${
                order.productionStatusId === null ? 'NULL' : Number(order.productionStatusId)
            },
            production_status_from_details_enabled = ${
                order.productionStatusFromDetailsEnabled ? 'true' : 'false'
            },
            version = version + 1
        WHERE order_id = ${Number(order.orderId)}
          AND (
            planned_completion_date IS DISTINCT FROM ${
                order.plannedCompletionDate === null
                    ? 'NULL'
                    : `DATE '${sqlQuote(order.plannedCompletionDate)}'`
            }
            OR order_status_id IS DISTINCT FROM ${Number(order.orderStatusId)}
            OR production_status_id IS DISTINCT FROM ${
                order.productionStatusId === null ? 'NULL' : Number(order.productionStatusId)
            }
            OR production_status_from_details_enabled IS DISTINCT FROM ${
                order.productionStatusFromDetailsEnabled ? 'true' : 'false'
            }
          );
    `);

    if (order.detailStatuses.length > 0) {
        const values = order.detailStatuses
            .map(
                (detail) =>
                    `(${Number(detail.detailId)}, ${
                        detail.productionStatusId === null ? 'NULL' : Number(detail.productionStatusId)
                    })`,
            )
            .join(', ');
        psql(`
            UPDATE order_details AS od
            SET production_status_id = restore.production_status_id
            FROM (VALUES ${values}) AS restore(detail_id, production_status_id)
            WHERE od.detail_id = restore.detail_id;
        `);
    }
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

function dockerContainerExists(containerName: string): boolean {
    try {
        execFileSync('docker', ['container', 'inspect', containerName], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
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
        productionStatusId?: number;
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
    productionStatusId: number | null;
    productionStatusFromDetailsEnabled: boolean;
    version: number;
    ordersViewVersion: number;
    detailStatuses: Array<{
        detailId: number;
        productionStatusId: number | null;
    }>;
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
    productionCurrentStatusAuditCount: string;
    stageActivateAuditCount: string;
    stageDeactivateAuditCount: string;
    calendarOutboxCount: string;
    deadlineOutboxCount: string;
    statusOutboxCount: string;
    productionCurrentStatusOutboxCount: string;
    stageActivateOutboxCount: string;
    stageDeactivateOutboxCount: string;
    productionCurrentStatusEventCount: string;
    completedCommandCount: string;
}
