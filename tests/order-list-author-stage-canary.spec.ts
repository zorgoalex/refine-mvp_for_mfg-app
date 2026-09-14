import { expect, test } from '@playwright/test';

const enabled = process.env.ORDER_LIST_AUTHOR_STAGE_CANARY === 'true';
const frontend = 'https://app-test.mebelkz.app';
const backend = 'https://backend-test.mebelkz.app/api/v1';

test.describe('Order list author stage canary (no business writes)', () => {
  test.skip(!enabled, 'Opt in with ORDER_LIST_AUTHOR_STAGE_CANARY=true.');

  test('list API exposes audit labels and UI never fetches service/missing author profiles', async ({ page, request }) => {
    test.setTimeout(90000);
    const username = process.env.CODEX_PLAYWRIGHT_USERNAME;
    const password = process.env.CODEX_PLAYWRIGHT_PASSWORD;
    expect(username).toBeTruthy(); expect(password).toBeTruthy();
    const login = await request.post(`${backend}/auth/login`, { data: { username, password } });
    expect(login.ok()).toBe(true);
    const auth = await login.json();
    const response = await request.get(`${backend}/orders?pageSize=2`, { headers: { authorization: `Bearer ${auth.accessToken}` } });
    expect(response.ok()).toBe(true);
    const list = await response.json();
    expect(list.data.length).toBeGreaterThan(0);
    for (const row of list.data) expect(row).toHaveProperty('createdByLabel');

    const profileCalls: string[] = [];
    page.on('request', req => { if (/\/api\/v1\/users\/(86|2147483646)(?:\?|$)/.test(req.url())) profileCalls.push(req.url()); });
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) await page.route(`${frontend}/**`, route => route.continue({ headers: { ...route.request().headers(), 'x-vercel-protection-bypass': bypass } }));
    let fixtureShown = false;
    await page.route(`${backend}/orders?**`, async route => {
      const actual = await route.fetch();
      const body = await actual.json();
      expect(actual.ok()).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(2);
      // Only browser response audit fields are replaced, never backend data.
      body.data[0].createdBy = 86; body.data[0].createdByLabel = 'Сервис интеграции ERP';
      body.data[1].createdBy = 2147483646; body.data[1].createdByLabel = null;
      fixtureShown = true;
      await route.fulfill({ response: actual, json: body });
    });
    await page.goto(`${frontend}/login`);
    await page.locator('input#username').fill(username!);
    await page.locator('input#password').fill(password!);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await page.waitForURL(url => !url.pathname.includes('/login'));
    await page.goto(`${frontend}/orders`);
    await expect(page.getByText('Сервис интеграции ERP', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('ERP #2147483646', { exact: true }).first()).toBeVisible();
    expect(fixtureShown).toBe(true);
    expect(profileCalls).toEqual([]);
    await expect(page.getByText('User not found', { exact: false })).toHaveCount(0);
  });
});
