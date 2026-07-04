import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Mocked E2E for the hybrid WorkOS SSO flow (no real backend, no real WorkOS):
 * - the SSO button on /login is gated by runtime-config workosAuth AND backendAuth;
 * - the callback page exchanges code+state and lands in the app;
 * - a 401 from the callback endpoint must NOT trigger a second POST — the
 *   authorization code is single-use, so refresh-replay would burn it.
 */

const MOCK_USER = {
    id: '1',
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: ['orders.view', 'settings.view'],
};

const LOGIN_RESPONSE = {
    accessToken: 'mock-workos-access-token',
    accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    user: MOCK_USER,
};

test.describe('WorkOS hybrid auth (mocked)', () => {
    test.beforeEach(async ({ page, context }) => {
        await context.clearCookies();
        await page.addInitScript(() => {
            localStorage.clear();
            sessionStorage.clear();
        });
    });

    test('login page shows SSO button when workosAuth + backendAuth are on', async ({ page }) => {
        await mockRuntimeConfig(page, { backendAuth: true, workosAuth: true });
        await mockLoggedOut(page);

        await gotoLoginWarm(page);

        await expect(page.getByRole('button', { name: 'Войти через SSO' })).toBeVisible();
    });

    test('login page hides SSO button when workosAuth is off', async ({ page }) => {
        await mockRuntimeConfig(page, { backendAuth: true, workosAuth: false });
        await mockLoggedOut(page);

        await gotoLoginWarm(page);

        await expect(page.getByRole('button', { name: 'Войти через SSO' })).toHaveCount(0);
    });

    test('login page hides SSO button when backendAuth is off even if workosAuth is on', async ({ page }) => {
        await mockRuntimeConfig(page, { backendAuth: false, workosAuth: true });
        await mockLoggedOut(page);

        await gotoLoginWarm(page);

        await expect(page.getByRole('button', { name: 'Войти через SSO' })).toHaveCount(0);
    });

    test('callback page exchanges code+state once and enters the app without an extra refresh', async ({ page }) => {
        await mockRuntimeConfig(page, { backendAuth: true, workosAuth: true });

        const callbackBodies: unknown[] = [];
        let meCalls = 0;
        await page.route(/\/api\/v1\/auth\/workos\/callback$/, async (route) => {
            callbackBodies.push(JSON.parse(route.request().postData() || '{}'));
            await fulfillJson(route, LOGIN_RESPONSE);
        });

        // App boot may probe /auth/refresh on its own; the regression this
        // test guards is a FULL RELOAD after the exchange (which would drop
        // the in-memory token). Keep the session logged out so a reload
        // would bounce to /login instead of landing on '/'.
        await page.route(/\/api\/v1\/auth\/refresh$/, async (route) => {
            await fulfillJson(route, { error: { code: 'AUTH_REQUIRED', message: 'Unauthenticated' } }, 401);
        });
        await page.route(/\/api\/v1\/me$/, async (route) => {
            meCalls += 1;
            await fulfillJson(route, { user: MOCK_USER });
        });
        await page.route(/\/api\/v1\/me\/preferences$/, async (route) => {
            await fulfillJson(route, { preferences: { themeMode: 'light' } });
        });
        await page.route(/\/v1\/graphql$/, async (route) => {
            await fulfillJson(route, { data: {} });
        });

        await page.goto('/auth/workos/callback?code=e2e-mock-code&state=e2e-mock-state');

        await expect(page).not.toHaveURL(/auth\/workos\/callback/, { timeout: 15000 });
        await expect(page).not.toHaveURL(/\/login/);

        // Single exchange with both params (StrictMode double-mount is guarded).
        expect(callbackBodies).toHaveLength(1);
        expect(callbackBodies[0]).toEqual({ code: 'e2e-mock-code', state: 'e2e-mock-state' });

        // The user was rehydrated via me() and the document was NEVER
        // reloaded: the only navigation entry is still the callback URL, so
        // the in-memory token survived (SPA navigate, POC race #5).
        expect(meCalls).toBeGreaterThan(0);
        const navigationUrls = await page.evaluate(() =>
            performance.getEntriesByType('navigation').map((entry) => entry.name),
        );
        expect(navigationUrls).toHaveLength(1);
        expect(navigationUrls[0]).toContain('/auth/workos/callback');
    });

    test('401 from callback shows the error and never replays the single-use code', async ({ page }) => {
        await mockRuntimeConfig(page, { backendAuth: true, workosAuth: true });

        let callbackCalls = 0;
        let refreshCalls = 0;

        await page.route(/\/api\/v1\/auth\/workos\/callback$/, async (route) => {
            callbackCalls += 1;
            await fulfillJson(
                route,
                {
                    error: {
                        code: 'IDENTITY_NOT_LINKED',
                        message: 'SSO identity is not linked to any user',
                    },
                },
                401,
            );
        });

        // If skipAuthRefresh regressed, the httpClient would call refresh and
        // replay the callback POST. A succeeding refresh makes that replay
        // possible — the test proves it still does not happen.
        await page.route(/\/api\/v1\/auth\/refresh$/, async (route) => {
            refreshCalls += 1;
            await fulfillJson(route, LOGIN_RESPONSE);
        });

        await page.goto('/auth/workos/callback?code=e2e-mock-burned-code&state=e2e-mock-state');

        await expect(page.getByText('Ошибка входа через SSO')).toBeVisible({ timeout: 15000 });
        await expect(page.getByText(/Вход через SSO не привязан/)).toBeVisible();

        expect(callbackCalls).toBe(1);
        expect(refreshCalls).toBe(0);
    });
});

test.describe('WorkOS link retry (mocked, own storage lifecycle)', () => {
    test('link retry after a failed pre-exchange refresh still routes as a link', async ({ page, context }) => {
        await context.clearCookies();
        await mockRuntimeConfig(page, { backendAuth: true, workosAuth: true });

        // Simulate a started link flow: seed the state-bound intent exactly
        // ONCE (window.name survives reloads) — the reload below must see
        // whatever the APP left in sessionStorage, not a re-seeded value.
        await page.addInitScript(() => {
            if (!window.name.includes('e2e-intent-seeded')) {
                window.name += 'e2e-intent-seeded';
                localStorage.clear();
                sessionStorage.clear();
                sessionStorage.setItem('erp_workos_link_intent', 'e2e-link-state');
            }
        });

        let linkCallbackCalls = 0;
        let refreshShouldFail = true;
        await page.route(/\/api\/v1\/auth\/refresh$/, async (route) => {
            if (refreshShouldFail) {
                await fulfillJson(route, { error: { code: 'AUTH_REQUIRED', message: 'x' } }, 401);
                return;
            }
            await fulfillJson(route, LOGIN_RESPONSE);
        });
        await page.route(/\/api\/v1\/auth\/workos\/link\/callback$/, async (route) => {
            linkCallbackCalls += 1;
            await fulfillJson(route, { linked: true });
        });
        await page.route(/\/api\/v1\/me$/, async (route) => {
            await fulfillJson(route, { user: MOCK_USER });
        });
        await page.route(/\/api\/v1\/me\/preferences$/, async (route) => {
            await fulfillJson(route, { preferences: { themeMode: 'light' } });
        });
        await page.route(/\/api\/v1\/auth\/workos\/link$/, async (route) => {
            await fulfillJson(route, { linked: true });
        });
        await page.route(/\/v1\/graphql$/, async (route) => {
            await fulfillJson(route, { data: {} });
        });

        // First attempt: the pre-exchange refresh fails — the single-use code
        // was NOT burned, the link intent must survive for the retry.
        await page.goto('/auth/workos/callback?code=e2e-link-code&state=e2e-link-state');
        await expect(page.getByText('Ошибка входа через SSO')).toBeVisible({ timeout: 15000 });
        expect(linkCallbackCalls).toBe(0);
        expect(
            await page.evaluate(() => sessionStorage.getItem('erp_workos_link_intent')),
        ).toBe('e2e-link-state');

        // Retry the SAME callback URL with a working session: it must still
        // route into the LINK callback, not the login exchange.
        refreshShouldFail = false;
        await page.reload();
        await expect(page).toHaveURL(/\/profile\?sso=linked/, { timeout: 15000 });
        expect(linkCallbackCalls).toBe(1);
    });
});

/**
 * Loads /login and reloads once after the app is up. On a cold Vite dev server
 * the first page load spends longer transforming modules than the 1.5s
 * runtime-config fetch budget, so the mocked feature flags silently fall back
 * to build-time defaults; the reload re-fetches the config on a warm server.
 */
async function gotoLoginWarm(page: Page): Promise<void> {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible({ timeout: 30000 });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible({ timeout: 15000 });
}

async function mockRuntimeConfig(
    page: Page,
    features: Record<string, boolean>,
): Promise<void> {
    await page.route(/\/runtime-config\.json$/, async (route) => {
        await fulfillJson(route, { apiUrl: '', features });
    });
}

async function mockLoggedOut(page: Page): Promise<void> {
    await page.route(/\/api\/v1\/auth\/refresh$/, async (route) => {
        await fulfillJson(route, { error: { code: 'AUTH_REQUIRED', message: 'Unauthenticated' } }, 401);
    });
    await page.route(/\/api\/refresh$/, async (route) => {
        await fulfillJson(route, { error: 'Unauthenticated' }, 401);
    });
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
    await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
    });
}
