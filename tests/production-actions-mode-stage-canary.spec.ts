import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

// Stage canary for the production-status-MODE backend commands:
//   PATCH /orders/:id/production-status-mode/manual  (enabled=false, keep status, cascade to details)
//   PATCH /orders/:id/production-status-mode/auto     (enabled=true, recalc status from details)
// Exercises the real endpoints + DB function recalc_order_production_status + triggers on the
// erp_test stage, asserts audit/outbox/version/idempotency, then restores the fixture to zero.

const canaryEnabled = process.env.PRODUCTION_ACTIONS_MODE_STAGE_CANARY === 'true';
const frontendUrl = trimTrailingSlash(
    process.env.PRODUCTION_ACTIONS_MODE_STAGE_FRONTEND_URL ?? 'https://app-test.mebelkz.app',
);
const backendApiUrl = trimTrailingSlash(
    process.env.PRODUCTION_ACTIONS_MODE_STAGE_BACKEND_API_URL ??
        'https://backend-test.mebelkz.app/api/v1',
);
const testOrderId = readNumberEnv('PRODUCTION_ACTIONS_MODE_STAGE_ORDER_ID', 11150);
const postgresContainer =
    process.env.PRODUCTION_ACTIONS_MODE_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';
const vercelAutomationBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();

// Fail closed: never run against anything that looks like production/live.
const looksLikeProd = /prod|production|live/i.test(`${backendApiUrl} ${postgresContainer} ${frontendUrl}`);

test.describe('Production actions MODE stage canary (restore-auto / enter-manual)', () => {
    test.skip(!canaryEnabled, 'Run with PRODUCTION_ACTIONS_MODE_STAGE_CANARY=true');
    test.skip(
        canaryEnabled && looksLikeProd,
        'Refusing to run: backend/container/frontend target looks like production.',
    );
    test.skip(
        canaryEnabled && !dockerContainerExists(postgresContainer),
        `Stage postgres container ${postgresContainer} is required for this canary.`,
    );
    test.skip(
        canaryEnabled && !vercelAutomationBypassSecret,
        'VERCEL_AUTOMATION_BYPASS_SECRET is required for protected deployed frontend access.',
    );
    test.setTimeout(180000);

    let baseline: OrderSnapshot | null = null;
    let userId: number | null = null;

    test.afterEach(async () => {
        cleanupOrder(baseline);
        cleanupUser(userId);
    });

    test('restore-auto + enter-manual via backend with audit/outbox/version/idempotency', async ({
        request,
    }) => {
        const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const username = `e2e_test_prod_status_mode_${runId}`;
        const password = crypto.randomBytes(24).toString('base64url');
        const startedAt = psql('SELECT now()::text;');

        baseline = loadOrderSnapshot(testOrderId);
        expect(isTestOrderName(baseline.orderName), `fixture must be a Тест/E2E order: ${baseline.orderName}`).toBe(true);
        expect(baseline.productionStatusFromDetailsEnabled, 'fixture must start in auto mode').toBe(true);
        expect(baseline.detailStatuses.length, 'fixture must have at least one active detail').toBeGreaterThan(0);

        userId = createSmokeUser(username, password);
        const accessToken = await loginForApiToken(request, username, password);
        await expectRuntimeConfig(request);

        const keys = {
            manual: `prod-status-mode-manual:${runId}`,
            restore: `prod-status-mode-restore:${runId}`,
        };

        // 1) enter-manual from the auto baseline: flag flips false, order status kept, details UNCHANGED.
        //    (The cascade trigger fires only on a production_status_id change, not on a flag-only flip,
        //    and recalc no-ops while disabled — so a pure mode flip must not touch detail statuses.)
        const manualResponse = await patchJson<ProductionActionResponse>(
            request,
            `/orders/${testOrderId}/production-status-mode/manual`,
            accessToken,
            { version: Number(baseline.version), idempotencyKey: keys.manual },
        );
        expect(manualResponse.order.version).toBe(Number(baseline.version) + 1);
        expect(manualResponse.order.productionStatusFromDetailsEnabled).toBe(false);
        expect(Number(manualResponse.order.productionStatusId)).toBe(Number(baseline.productionStatusId));

        const afterManual = loadOrderSnapshot(testOrderId);
        expect(afterManual.productionStatusFromDetailsEnabled).toBe(false);
        expect(detailStatusMap(afterManual)).toEqual(detailStatusMap(baseline)); // details unchanged by enter-manual

        // 2) Set up a divergence so restore-auto's recompute visibly changes the order status:
        //    while in manual mode (recalc no-ops), set ALL active details to a status that differs from
        //    the current order status. recalc (MIN sort_order over details) must then yield that status.
        const target = loadDivergentProductionStatus(Number(baseline.productionStatusId));
        expect(target, 'need an active production status distinct from the order status').not.toBeNull();
        psql(`
            UPDATE order_details
            SET production_status_id = ${target!.productionStatusId}
            WHERE order_id = ${testOrderId}
              AND COALESCE(delete_flag, false) = false;
        `);
        // recalc no-ops while disabled → order status must still be the kept (baseline) value.
        expect(Number(loadOrderSnapshot(testOrderId).productionStatusId)).toBe(Number(baseline.productionStatusId));

        const expectedRecalc = computeAutoStatusFromDetails(testOrderId);
        expect(expectedRecalc).toBe(target!.productionStatusId); // all details share the target status
        expect(expectedRecalc).not.toBe(Number(baseline.productionStatusId)); // genuinely diverges

        // 3) restore-auto: flag flips true, recalc runs, order status becomes the recomputed (changed) value.
        const restoreResponse = await patchJson<ProductionActionResponse>(
            request,
            `/orders/${testOrderId}/production-status-mode/auto`,
            accessToken,
            { version: manualResponse.order.version, idempotencyKey: keys.restore },
        );
        expect(restoreResponse.order.version).toBe(Number(baseline.version) + 2);
        expect(restoreResponse.order.productionStatusFromDetailsEnabled).toBe(true);
        expect(Number(restoreResponse.order.productionStatusId)).toBe(expectedRecalc);
        expect(Number(restoreResponse.order.productionStatusId)).not.toBe(Number(baseline.productionStatusId));

        // 4) Idempotency replay: same key + same (pre-restore) version returns the stored response, no extra bump.
        const restoreReplay = await patchJson<ProductionActionResponse>(
            request,
            `/orders/${testOrderId}/production-status-mode/auto`,
            accessToken,
            { version: manualResponse.order.version, idempotencyKey: keys.restore },
        );
        expect(restoreReplay.order.version).toBe(restoreResponse.order.version);

        // Final DB state: auto restored, recomputed status, details unchanged by restore-auto.
        const after = loadOrderSnapshot(testOrderId);
        expect(after.productionStatusFromDetailsEnabled).toBe(true);
        expect(Number(after.productionStatusId)).toBe(expectedRecalc);
        expect(Number(after.version)).toBe(Number(baseline.version) + 2);

        // DB audit/outbox assertions.
        const db = loadCommandSnapshot({ orderId: testOrderId, startedAt, keys });
        expect(Number(db.manualAuditCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.restoreAuditCount)).toBeGreaterThanOrEqual(1);
        expect(Number(db.manualOutboxCount)).toBe(1);
        expect(Number(db.restoreOutboxCount)).toBe(1);
        expect(Number(db.completedCommandCount)).toBe(2); // manual + restore
    });
});

function detailStatusMap(order: OrderSnapshot): Record<string, number | null> {
    const map: Record<string, number | null> = {};
    for (const detail of order.detailStatuses) {
        map[String(detail.detailId)] =
            detail.productionStatusId === null ? null : Number(detail.productionStatusId);
    }
    return map;
}

async function expectRuntimeConfig(request: APIRequestContext) {
    const response = await request.get(`${frontendUrl}/runtime-config.json`, {
        headers: frontendRequestHeaders(),
    });
    await expectOk(response);
    const runtimeConfig = await response.json();
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

async function expectOk(response: APIResponse) {
    const body = response.ok() ? '' : await response.text();
    expect(response.ok(), body).toBe(true);
}

function authHeaders(token: string | null) {
    expect(token).toBeTruthy();
    return { Authorization: `Bearer ${token}` };
}

function loadOrderSnapshot(orderId: number): OrderSnapshot {
    return psql<OrderSnapshot>(
        `
        SELECT json_build_object(
            'orderId', o.order_id,
            'orderName', o.order_name,
            'orderStatusId', o.order_status_id,
            'productionStatusId', o.production_status_id,
            'productionStatusFromDetailsEnabled', o.production_status_from_details_enabled,
            'version', o.version,
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
        WHERE o.order_id = ${orderId}
          AND o.delete_flag = false;
        `,
        { json: true },
    );
}

// An active production status distinct from the order's current status, usable as a detail status.
// Setting all details to it makes the recalc MIN-derivation equal this status (and differ from the order).
function loadDivergentProductionStatus(currentStatusId: number): ProductionStatusTarget | null {
    return psqlJsonOrNull<ProductionStatusTarget>(`
        SELECT json_build_object(
            'productionStatusId', ps.production_status_id,
            'productionStatusName', ps.production_status_name,
            'productionStatusCode', ps.production_status_code
        )::text
        FROM production_statuses ps
        WHERE ps.is_active = true
          AND ps.sort_order IS NOT NULL
          AND ps.production_status_id <> ${currentStatusId}
        ORDER BY ps.sort_order ASC, ps.production_status_id
        LIMIT 1;
    `);
}

// Independently reproduces recalc_order_production_status: MIN(sort_order) over active details with a status.
function computeAutoStatusFromDetails(orderId: number): number {
    return Number(
        psql(`
            SELECT ps.production_status_id
            FROM order_details od
            JOIN production_statuses ps ON ps.production_status_id = od.production_status_id
            WHERE od.order_id = ${orderId}
              AND COALESCE(od.delete_flag, false) = false
              AND od.production_status_id IS NOT NULL
            ORDER BY ps.sort_order NULLS LAST, ps.production_status_id
            LIMIT 1;
        `),
    );
}

function loadCommandSnapshot(input: {
    orderId: number;
    startedAt: string;
    keys: Record<'manual' | 'restore', string>;
}): CommandSnapshot {
    const keyValues = Object.values(input.keys).map((key) => `'${sqlQuote(key)}'`).join(', ');

    return psql<CommandSnapshot>(
        `
        SELECT json_build_object(
            'manualAuditCount', (
                SELECT count(*)
                FROM audit_log
                WHERE event = 'orders.production_status_mode_manual'
                  AND source = 'backend-production-command'
                  AND related_order_id = ${input.orderId}
                  AND created_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
            ),
            'restoreAuditCount', (
                SELECT count(*)
                FROM audit_log
                WHERE event = 'orders.production_status_mode_restore'
                  AND source = 'backend-production-command'
                  AND related_order_id = ${input.orderId}
                  AND created_at >= TIMESTAMPTZ '${sqlQuote(input.startedAt)}'
            ),
            'manualOutboxCount', (
                SELECT count(*)
                FROM outbox_events
                WHERE event_type = 'order.production_status_mode_set_manual'
                  AND idempotency_key = '${sqlQuote(input.keys.manual)}'
            ),
            'restoreOutboxCount', (
                SELECT count(*)
                FROM outbox_events
                WHERE event_type = 'order.production_status_mode_restored'
                  AND idempotency_key = '${sqlQuote(input.keys.restore)}'
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
                    'E2E Test Production Status Mode Stage Canary',
                    true
                )
                RETURNING user_id
            )
            SELECT user_id FROM inserted;
        `),
    );
}

function cleanupOrder(order: OrderSnapshot | null) {
    if (!order) return;

    psql(`
        UPDATE orders
        SET order_status_id = ${Number(order.orderStatusId)},
            production_status_id = ${
                order.productionStatusId === null ? 'NULL' : Number(order.productionStatusId)
            },
            production_status_from_details_enabled = ${
                order.productionStatusFromDetailsEnabled ? 'true' : 'false'
            },
            version = version + 1
        WHERE order_id = ${Number(order.orderId)};
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
        productionStatusId?: number;
        productionStatusFromDetailsEnabled?: boolean;
        version: number;
    };
    requestId: string;
}

interface OrderSnapshot {
    orderId: number;
    orderName: string;
    orderStatusId: number;
    productionStatusId: number | null;
    productionStatusFromDetailsEnabled: boolean;
    version: number;
    detailStatuses: Array<{
        detailId: number;
        productionStatusId: number | null;
    }>;
}

interface ProductionStatusTarget {
    productionStatusId: number;
    productionStatusName: string;
    productionStatusCode: string;
}

interface CommandSnapshot {
    manualAuditCount: string;
    restoreAuditCount: string;
    manualOutboxCount: string;
    restoreOutboxCount: string;
    completedCommandCount: string;
}
