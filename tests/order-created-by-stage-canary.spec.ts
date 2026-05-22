import { expect, test } from '@playwright/test';

const enabled = process.env.ORDER_CREATED_BY_STAGE_CANARY === 'true';
const backendApiUrl = trimTrailingSlash(
    process.env.ORDER_CREATED_BY_STAGE_BACKEND_API_URL ?? 'https://backend-test.mebelkz.app/api/v1',
);
const username = process.env.CODEX_PLAYWRIGHT_USERNAME ?? '';
const password = process.env.CODEX_PLAYWRIGHT_PASSWORD ?? '';
const orderId = Number(process.env.ORDER_CREATED_BY_STAGE_ORDER_ID ?? 11192);
const orderName = process.env.ORDER_CREATED_BY_STAGE_ORDER_NAME ?? 'E2E codex full coverage 20260522102826';

test.describe('Order created-by stage canary', () => {
    test.skip(!enabled, 'Run with ORDER_CREATED_BY_STAGE_CANARY=true against deployed backend.');
    test.skip(!username || !password, 'CODEX_PLAYWRIGHT_USERNAME/CODEX_PLAYWRIGHT_PASSWORD are required.');

    test('deployed order read API exposes creator fields for order UI', async ({ request }) => {
        const loginResponse = await request.post(`${backendApiUrl}/auth/login`, {
            data: { username, password },
        });
        expect(loginResponse.ok()).toBe(true);

        const loginBody = await loginResponse.json();
        const token = loginBody.accessToken ?? loginBody.access_token ?? loginBody.access?.token;
        expect(token).toBeTruthy();

        const orderResponse = await request.get(`${backendApiUrl}/orders/${orderId}`, {
            headers: { authorization: `Bearer ${token}` },
        });
        expect(orderResponse.ok()).toBe(true);

        const body = await orderResponse.json();
        const order = body.order ?? body.data ?? body;

        expect(order.header?.orderName ?? order.orderName ?? order.order_name).toBe(orderName);
        expect(order.header?.createdBy ?? order.createdBy ?? order.created_by).toBeTruthy();
        expect(order.header?.editedBy ?? order.editedBy ?? order.edited_by).toBeTruthy();
    });
});

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, '');
}
