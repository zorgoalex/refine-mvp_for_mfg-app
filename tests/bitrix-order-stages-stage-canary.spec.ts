import { expect, test } from '@playwright/test';

const api = 'https://backend-test.mebelkz.app/api/v1';
const frontend = 'https://app-test.mebelkz.app';
const username = process.env.CODEX_PLAYWRIGHT_USERNAME ?? 'codex_playwright';
const password = process.env.CODEX_PLAYWRIGHT_PASSWORD ?? '';
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test.describe('Deployed order stages: read-only, no Bitrix portal calls', () => {
  test.skip(process.env.BITRIX_ORDER_STAGES_STAGE_CANARY !== 'true' || !password, 'Explicit stage opt-in and test credentials required');
  test('settings and stage queue are available without enabling integration', async ({ request }) => {
    const login = await request.post(`${api}/auth/login`, { data: { username, password } });
    expect(login.status()).toBe(200);
    const { accessToken } = await login.json();
    const headers = { Authorization: `Bearer ${accessToken}` };
    const response = await request.get(`${api}/bitrix24/order-stages`, { headers });
    expect(response.status()).toBe(200);
    const state = await response.json();
    expect(state.config.enabled).toBe(false);
    expect(state.statuses.length).toBeGreaterThan(0);
    for (const query of ['queueType=order_stage', 'queueType=entity', 'queueType=order_stage&status=waiting_mapping']) {
      const queue = await request.get(`${api}/audit/bitrix24/queue?direction=forward&${query}`, { headers });
      expect(queue.status(), query).toBe(200);
      expect(Array.isArray((await queue.json()).data)).toBe(true);
    }
    expect((await request.get(`${api}/bitrix24/order-stages`)).status()).toBe(401);
  });
  test('settings section renders and read-only refresh succeeds', async ({ page }) => {
    test.skip(process.env.BITRIX_ORDER_STAGES_STAGE_UI !== 'true', 'Enable only after frontend deployment');
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) await page.setExtraHTTPHeaders({ 'x-vercel-protection-bypass': bypass });
    await page.goto(`${frontend}/login`);
    await page.locator('input[autocomplete="username"], input#username').fill(username);
    await page.locator('input[autocomplete="current-password"], input#password').fill(password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await page.waitForURL((url) => !url.pathname.includes('/login'));
    await page.evaluate(() => {
      window.history.pushState({}, '', '/bitrix24/incoming-requests');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    const stateResponse = page.waitForResponse((r) => r.url().endsWith('/api/v1/bitrix24/order-stages'));
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    expect((await stateResponse).status()).toBe(200);
    await page.getByText('Статусы заказов ERP → стадии сделок Bitrix', { exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Существующая воронка Bitrix', exact: true })).toBeVisible();
    await expect(page.getByText('Только производственные заказы', { exact: true })).toBeVisible();
    const refresh = page.waitForResponse((r) => r.url().endsWith('/api/v1/bitrix24/order-stages'));
    await page.getByRole('button', { name: 'Обновить состояние стадий', exact: true }).click();
    expect((await refresh).status()).toBe(200);
    // Never click catalog refresh, previews, provisioning or enabling on shared portal.
  });
});
