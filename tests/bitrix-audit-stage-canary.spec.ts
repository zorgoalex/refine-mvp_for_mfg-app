import { expect, test } from '@playwright/test';
import { isBitrixAuditEvent } from '../backend/src/modules/audit/application/bitrix-audit-events';

const enabled = process.env.BITRIX_AUDIT_STAGE_CANARY === 'true';
const api = 'https://backend-test.mebelkz.app/api/v1';
const frontend = 'https://app-test.mebelkz.app';
const username = process.env.CODEX_PLAYWRIGHT_USERNAME ?? 'codex_playwright';
const password = process.env.CODEX_PLAYWRIGHT_PASSWORD ?? '';
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test.describe('Bitrix audit stage: read-only, no portal calls', () => {
  test.skip(!enabled || !password, 'Explicit stage opt-in and test credentials required');
  test('deployed API partitions history and exposes safe runtime/queue state', async ({ request }) => {
    const login = await request.post(`${api}/auth/login`, { data: { username, password } });
    expect(login.status()).toBe(200);
    const { accessToken } = await login.json();
    const headers = { Authorization: `Bearer ${accessToken}` };
    for (const path of ['/audit/bitrix24/status', '/audit/bitrix24/queue?direction=forward', '/audit/bitrix24/queue?direction=reverse', '/audit/bitrix24/event-options']) {
      const response = await request.get(api + path, { headers });
      expect(response.status(), path).toBe(200);
    }
    const general = await request.get(`${api}/audit?excludeBitrix24=true&pageSize=50`, { headers });
    expect(general.status()).toBe(200);
    expect((await general.json()).data.every((row: any) => !isBitrixAuditEvent(row.event, row.source))).toBe(true);
    const bitrix = await request.get(`${api}/audit?scope=bitrix24&pageSize=50`, { headers });
    expect(bitrix.status()).toBe(200);
    expect((await bitrix.json()).data.every((row: any) => isBitrixAuditEvent(row.event, row.source))).toBe(true);
    expect((await request.get(`${api}/audit?scope=bitrix24&excludeBitrix24=true`, { headers })).status()).toBe(422);
    expect((await request.get(`${api}/audit/bitrix24/status`)).status()).toBe(401);
  });
  test('deployed UI separates Bitrix events and supports live queues and reset', async ({ page }) => {
    test.skip(process.env.BITRIX_AUDIT_STAGE_UI !== 'true', 'Enable after frontend deployment is ready');
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) await page.setExtraHTTPHeaders({ 'x-vercel-protection-bypass': bypass });
    await page.goto(`${frontend}/login`);
    await page.locator('input[autocomplete="username"], input#username').fill(username);
    await page.locator('input[autocomplete="current-password"], input#password').fill(password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await page.waitForURL((url) => !url.pathname.includes('/login'));
    // Preserve the in-memory session, as in the other authenticated stage canaries.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/audit');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    const list = page.waitForResponse((r) => r.url().includes('/api/v1/audit?') && r.url().includes('scope=bitrix24'));
    await page.getByRole('tab', { name: 'Bitrix24', exact: true }).click();
    expect((await list).status()).toBe(200);
    await expect(page.getByText('Часовой пояс:', { exact: false })).toBeVisible();
    const queue = page.waitForResponse((r) => r.url().includes('/audit/bitrix24/queue?'));
    await page.getByRole('tab', { name: 'Очереди', exact: true }).click();
    expect((await queue).status()).toBe(200);
    await expect(page.getByRole('combobox', { name: 'Заказ: номер или ID' })).toBeVisible();
    await page.getByRole('button', { name: 'Сбросить', exact: true }).last().click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
