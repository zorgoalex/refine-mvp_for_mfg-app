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

// The first test pays the Vite cold-start (module transform can exceed the
// default 30s budget together with the warm-up reload).
test.setTimeout(90_000);

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
            // Single-use semantics: the first exchange succeeds, any replay of
            // the same burned code gets invalid_grant.
            if (callbackBodies.length === 1) {
                await fulfillJson(route, LOGIN_RESPONSE);
                return;
            }
            await fulfillJson(
                route,
                { error: { code: 'WORKOS_CODE_INVALID', message: 'code already used' } },
                401,
            );
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

        // Revisiting the burned-code URL (reload/back/history) shows an
        // explicit error and a way back — never a dead spinner.
        await page.goto('/auth/workos/callback?code=e2e-mock-code&state=e2e-mock-state');
        await expect(page.getByText('Ошибка входа через SSO')).toBeVisible({ timeout: 15000 });
        await expect(page.getByText(/Сессия входа устарела/)).toBeVisible();
        await expect(page.getByRole('link', { name: 'Вернуться на страницу входа' })).toBeVisible();
    });

    test('transport failure during the login exchange keeps the code retryable', async ({ page }) => {
        await mockRuntimeConfig(page, { backendAuth: true, workosAuth: true });

        let abortNext = true;
        const callbackBodies: unknown[] = [];
        await page.route(/\/api\/v1\/auth\/workos\/callback$/, async (route) => {
            if (abortNext) {
                abortNext = false;
                await route.abort('connectionfailed');
                return;
            }
            callbackBodies.push(JSON.parse(route.request().postData() || '{}'));
            await fulfillJson(route, LOGIN_RESPONSE);
        });
        await page.route(/\/api\/v1\/auth\/refresh$/, async (route) => {
            await fulfillJson(route, { error: { code: 'AUTH_REQUIRED', message: 'x' } }, 401);
        });
        await page.route(/\/api\/v1\/me$/, async (route) => {
            await fulfillJson(route, { user: MOCK_USER });
        });
        await page.route(/\/api\/v1\/me\/preferences$/, async (route) => {
            await fulfillJson(route, { preferences: { themeMode: 'light' } });
        });
        await page.route(/\/v1\/graphql$/, async (route) => {
            await fulfillJson(route, { data: {} });
        });

        // The request never reached the backend: the code is NOT burned and
        // the same callback URL must recover on retry (reload).
        await page.goto('/auth/workos/callback?code=e2e-net-code&state=e2e-net-state');
        await expect(page.getByText('Ошибка входа через SSO')).toBeVisible({ timeout: 15000 });

        await page.reload();
        await expect(page).not.toHaveURL(/auth\/workos\/callback/, { timeout: 15000 });
        await expect(page).not.toHaveURL(/\/login/);
        expect(callbackBodies).toHaveLength(1);
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

    test('link intent survives a transport failure DURING the exchange', async ({ page, context }) => {
        await context.clearCookies();
        await mockRuntimeConfig(page, { backendAuth: true, workosAuth: true });

        await page.addInitScript(() => {
            if (!window.name.includes('e2e-intent2-seeded')) {
                window.name += 'e2e-intent2-seeded';
                localStorage.clear();
                sessionStorage.clear();
                sessionStorage.setItem('erp_workos_link_intent', 'e2e-net-link-state');
            }
        });

        let abortNext = true;
        let linkCallbackCalls = 0;
        await page.route(/\/api\/v1\/auth\/refresh$/, async (route) => {
            await fulfillJson(route, LOGIN_RESPONSE);
        });
        await page.route(/\/api\/v1\/auth\/workos\/link\/callback$/, async (route) => {
            if (abortNext) {
                abortNext = false;
                await route.abort('connectionfailed');
                return;
            }
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

        // The exchange died on the wire AFTER refresh succeeded: the code was
        // not consumed and the intent must survive so the retry stays a LINK.
        await page.goto('/auth/workos/callback?code=e2e-net-link-code&state=e2e-net-link-state');
        await expect(page.getByText('Ошибка входа через SSO')).toBeVisible({ timeout: 15000 });
        expect(
            await page.evaluate(() => sessionStorage.getItem('erp_workos_link_intent')),
        ).toBe('e2e-net-link-state');

        await page.reload();
        await expect(page).toHaveURL(/\/profile\?sso=linked/, { timeout: 15000 });
        expect(linkCallbackCalls).toBe(1);
    });
});

test.describe('WorkOS multi-link management (mocked)', () => {
    test.beforeEach(async ({ page, context }) => {
        await context.clearCookies();
        await page.addInitScript(() => {
            localStorage.clear();
            sessionStorage.clear();
        });
    });

    test('profile lists linked identities and unlinks only the chosen row once', async ({ page }) => {
        await mockRuntimeConfig(page, { backendAuth: true, workosAuth: true });

        const actionEvents: string[] = [];
        let trackAction = false;
        await mockLoggedInApp(page, {
            onRefresh: () => {
                if (trackAction) {
                    actionEvents.push('refresh');
                }
            },
        });

        const links = makeWorkosLinks();
        await page.route(/\/api\/v1\/auth\/workos\/links$/, async (route) => {
            await fulfillJson(route, { links });
        });

        await page.route(/\/api\/v1\/auth\/workos\/links\/[^/]+$/, async (route) => {
            const pathname = new URL(route.request().url()).pathname;
            actionEvents.push(`delete:${pathname}`);
            await fulfillJson(route, { unlinked: true });
        });

        await page.goto('/profile');
        await expect(page.getByRole('button', { name: 'Привязать ещё' })).toBeVisible({ timeout: 30000 });
        await expect(page.locator('tr', { hasText: links[0].emailAtLink })).toHaveCount(1);
        await expect(page.locator('tr', { hasText: links[1].emailAtLink })).toHaveCount(1);

        trackAction = true;
        await clickUnlinkForRow(page, links[0].emailAtLink);
        await confirmProfileUnlink(page, 'correct horse battery staple');

        await expect(page.locator('tr', { hasText: links[0].emailAtLink })).toHaveCount(0);
        await expect(page.locator('tr', { hasText: links[1].emailAtLink })).toHaveCount(1);
        assertSingleUnlink(actionEvents, `/api/v1/auth/workos/links/${links[0].identityId}`);
    });

    test('profile keeps the link and shows an inline error on 409 external policy', async ({ page }) => {
        await mockRuntimeConfig(page, { backendAuth: true, workosAuth: true });

        const actionEvents: string[] = [];
        let trackAction = false;
        await mockLoggedInApp(page, {
            onRefresh: () => {
                if (trackAction) {
                    actionEvents.push('refresh');
                }
            },
        });

        const links = makeWorkosLinks();
        await page.route(/\/api\/v1\/auth\/workos\/links$/, async (route) => {
            await fulfillJson(route, { links });
        });
        await page.route(/\/api\/v1\/auth\/workos\/links\/[^/]+$/, async (route) => {
            const pathname = new URL(route.request().url()).pathname;
            actionEvents.push(`delete:${pathname}`);
            await fulfillJson(
                route,
                {
                    error: {
                        code: 'UNLINK_FORBIDDEN_EXTERNAL_POLICY',
                        message: 'password login disabled',
                    },
                },
                409,
            );
        });

        await page.goto('/profile');
        await expect(page.getByRole('button', { name: 'Привязать ещё' })).toBeVisible({ timeout: 30000 });

        trackAction = true;
        await clickUnlinkForRow(page, links[0].emailAtLink);
        await confirmProfileUnlink(page, 'correct horse battery staple');

        const modal = page.locator('.ant-modal').filter({ hasText: 'Отвязать вход через SSO' });
        await expect(
            modal.getByText('Нельзя отвязать SSO: вход по паролю для вашей учётной записи отключён.'),
        ).toBeVisible();
        await expect(page.locator('tr', { hasText: links[0].emailAtLink })).toHaveCount(1);
        await expect(page.locator('tr', { hasText: links[1].emailAtLink })).toHaveCount(1);
        assertSingleUnlink(actionEvents, `/api/v1/auth/workos/links/${links[0].identityId}`);
    });

    test('admin user show unlinks only the chosen identity once', async ({ page }) => {
        const adminUser = {
            ...MOCK_USER,
            permissions: [...MOCK_USER.permissions, 'users.manage_sso'],
        };
        await mockRuntimeConfig(page, { backendAuth: true, workosAuth: true, backendUsers: true });

        const actionEvents: string[] = [];
        let trackAction = false;
        await mockLoggedInApp(page, {
            user: adminUser,
            onRefresh: () => {
                if (trackAction) {
                    actionEvents.push('refresh');
                }
            },
        });

        const links = makeWorkosLinks();
        const managedUserId = 77;
        await page.route(new RegExp(`/api/v1/users/${managedUserId}$`), async (route) => {
            await fulfillJson(route, {
                user: {
                    id: managedUserId,
                    username: 'managed-user',
                    email: 'managed-user@example.test',
                    fullName: 'Managed User',
                    role: 'manager',
                    permissions: ['orders.view'],
                    employeeId: null,
                    isActive: true,
                    createdAt: '2026-06-01T10:00:00.000Z',
                    updatedAt: '2026-06-02T10:00:00.000Z',
                },
            });
        });
        await page.route(new RegExp(`/api/v1/auth/workos/admin/users/${managedUserId}/links$`), async (route) => {
            await fulfillJson(route, { links });
        });
        await page.route(
            new RegExp(`/api/v1/auth/workos/admin/users/${managedUserId}/links/[^/]+$`),
            async (route) => {
                const pathname = new URL(route.request().url()).pathname;
                actionEvents.push(`delete:${pathname}`);
                await fulfillJson(route, { unlinked: true });
            },
        );

        await page.goto(`/users/show/${managedUserId}`);
        await expect(page.getByText('SSO-связки пользователя')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('tr', { hasText: links[0].emailAtLink })).toHaveCount(1);
        await expect(page.locator('tr', { hasText: links[1].emailAtLink })).toHaveCount(1);

        trackAction = true;
        await clickUnlinkForRow(page, links[0].emailAtLink);
        await confirmAdminUnlink(page);

        await expect(page.locator('tr', { hasText: links[0].emailAtLink })).toHaveCount(0);
        await expect(page.locator('tr', { hasText: links[1].emailAtLink })).toHaveCount(1);
        assertSingleUnlink(
            actionEvents,
            `/api/v1/auth/workos/admin/users/${managedUserId}/links/${links[0].identityId}`,
        );
    });

    test('admin user show keeps the link and shows an inline error on 409 external policy', async ({ page }) => {
        const adminUser = {
            ...MOCK_USER,
            permissions: [...MOCK_USER.permissions, 'users.manage_sso'],
        };
        await mockRuntimeConfig(page, { backendAuth: true, workosAuth: true, backendUsers: true });

        const actionEvents: string[] = [];
        let trackAction = false;
        await mockLoggedInApp(page, {
            user: adminUser,
            onRefresh: () => {
                if (trackAction) {
                    actionEvents.push('refresh');
                }
            },
        });

        const links = makeWorkosLinks();
        const managedUserId = 78;
        await page.route(new RegExp(`/api/v1/users/${managedUserId}$`), async (route) => {
            await fulfillJson(route, {
                user: {
                    id: managedUserId,
                    username: 'managed-user-409',
                    email: 'managed-user-409@example.test',
                    fullName: 'Managed User 409',
                    role: 'manager',
                    permissions: ['orders.view'],
                    employeeId: null,
                    isActive: true,
                    createdAt: '2026-06-01T10:00:00.000Z',
                    updatedAt: '2026-06-02T10:00:00.000Z',
                },
            });
        });
        await page.route(new RegExp(`/api/v1/auth/workos/admin/users/${managedUserId}/links$`), async (route) => {
            await fulfillJson(route, { links });
        });
        await page.route(
            new RegExp(`/api/v1/auth/workos/admin/users/${managedUserId}/links/[^/]+$`),
            async (route) => {
                const pathname = new URL(route.request().url()).pathname;
                actionEvents.push(`delete:${pathname}`);
                await fulfillJson(
                    route,
                    {
                        error: {
                            code: 'UNLINK_FORBIDDEN_EXTERNAL_POLICY',
                            message: 'password login disabled',
                        },
                    },
                    409,
                );
            },
        );

        await page.goto(`/users/show/${managedUserId}`);
        await expect(page.getByText('SSO-связки пользователя')).toBeVisible({ timeout: 30000 });

        trackAction = true;
        await clickUnlinkForRow(page, links[0].emailAtLink);
        await confirmAdminUnlink(page);

        const modal = page.locator('.ant-modal').filter({ hasText: 'Отвязать SSO-вход пользователя' });
        await expect(
            modal.getByText('Нельзя отвязать SSO: вход по паролю для этой учётной записи отключён.'),
        ).toBeVisible();
        await expect(page.locator('tr', { hasText: links[0].emailAtLink })).toHaveCount(1);
        await expect(page.locator('tr', { hasText: links[1].emailAtLink })).toHaveCount(1);
        assertSingleUnlink(
            actionEvents,
            `/api/v1/auth/workos/admin/users/${managedUserId}/links/${links[0].identityId}`,
        );
    });

    test('admin user show keeps the link and shows not found on 404', async ({ page }) => {
        const adminUser = {
            ...MOCK_USER,
            permissions: [...MOCK_USER.permissions, 'users.manage_sso'],
        };
        await mockRuntimeConfig(page, { backendAuth: true, workosAuth: true, backendUsers: true });

        const actionEvents: string[] = [];
        let trackAction = false;
        await mockLoggedInApp(page, {
            user: adminUser,
            onRefresh: () => {
                if (trackAction) {
                    actionEvents.push('refresh');
                }
            },
        });

        const links = makeWorkosLinks();
        const managedUserId = 79;
        await page.route(new RegExp(`/api/v1/users/${managedUserId}$`), async (route) => {
            await fulfillJson(route, {
                user: {
                    id: managedUserId,
                    username: 'managed-user-404',
                    email: 'managed-user-404@example.test',
                    fullName: 'Managed User 404',
                    role: 'manager',
                    permissions: ['orders.view'],
                    employeeId: null,
                    isActive: true,
                    createdAt: '2026-06-01T10:00:00.000Z',
                    updatedAt: '2026-06-02T10:00:00.000Z',
                },
            });
        });
        await page.route(new RegExp(`/api/v1/auth/workos/admin/users/${managedUserId}/links$`), async (route) => {
            await fulfillJson(route, { links });
        });
        await page.route(
            new RegExp(`/api/v1/auth/workos/admin/users/${managedUserId}/links/[^/]+$`),
            async (route) => {
                const pathname = new URL(route.request().url()).pathname;
                actionEvents.push(`delete:${pathname}`);
                await fulfillJson(
                    route,
                    {
                        error: {
                            code: 'LINK_NOT_FOUND',
                            message: 'link not found',
                        },
                    },
                    404,
                );
            },
        );

        await page.goto(`/users/show/${managedUserId}`);
        await expect(page.getByText('SSO-связки пользователя')).toBeVisible({ timeout: 30000 });

        trackAction = true;
        await clickUnlinkForRow(page, links[0].emailAtLink);
        await confirmAdminUnlink(page);

        const modal = page.locator('.ant-modal').filter({ hasText: 'Отвязать SSO-вход пользователя' });
        await expect(modal.getByText('линк не найден')).toBeVisible();
        await expect(page.locator('tr', { hasText: links[0].emailAtLink })).toHaveCount(1);
        await expect(page.locator('tr', { hasText: links[1].emailAtLink })).toHaveCount(1);
        assertSingleUnlink(
            actionEvents,
            `/api/v1/auth/workos/admin/users/${managedUserId}/links/${links[0].identityId}`,
        );
    });
});

/**
 * Loads /login and reloads once after the app is up. On a cold Vite dev server
 * the first page load spends longer transforming modules than the 1.5s
 * runtime-config fetch budget, so the mocked feature flags silently fall back
 * to build-time defaults; the reload re-fetches the config on a warm server.
 */
/**
 * Anti-replay invariant for a granular unlink: the destructive DELETE fires
 * EXACTLY ONCE and only for the targeted identity, and a session refresh
 * precedes it (R17/R9 anti-stale-token). Incidental app-lifecycle refreshes
 * (session keep-alive on navigation) may also appear — only the single delete
 * and the refresh→delete ordering are load-bearing, so we assert those rather
 * than an exact event sequence that a background refresh would flake.
 */
function assertSingleUnlink(actionEvents: string[], deletePath: string): void {
    const deletes = actionEvents.filter((event) => event.startsWith('delete:'));
    expect(deletes).toEqual([`delete:${deletePath}`]);
    const firstRefresh = actionEvents.indexOf('refresh');
    const deleteIndex = actionEvents.indexOf(`delete:${deletePath}`);
    expect(firstRefresh).toBeGreaterThanOrEqual(0);
    expect(firstRefresh).toBeLessThan(deleteIndex);
}

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

async function mockLoggedInApp(
    page: Page,
    options: {
        user?: typeof MOCK_USER;
        onRefresh?: () => void;
    } = {},
): Promise<void> {
    const user = options.user ?? MOCK_USER;
    const loginResponse = { ...LOGIN_RESPONSE, user };

    await page.route(/\/api\/v1\/auth\/refresh$/, async (route) => {
        options.onRefresh?.();
        await fulfillJson(route, loginResponse);
    });
    await page.route(/\/api\/v1\/me$/, async (route) => {
        await fulfillJson(route, { user });
    });
    await page.route(/\/api\/v1\/me\/preferences$/, async (route) => {
        await fulfillJson(route, { preferences: { themeMode: 'light' } });
    });
    await page.route(/\/v1\/graphql$/, async (route) => {
        await fulfillJson(route, { data: {} });
    });
}

function makeWorkosLinks() {
    return [
        {
            identityId: 'identity-google-primary',
            authMethod: 'google',
            emailAtLink: 'primary-link@example.test',
            linkedAt: '2026-06-01T12:00:00.000Z',
            lastLoginAt: '2026-06-10T08:30:00.000Z',
        },
        {
            identityId: 'identity-microsoft-secondary',
            authMethod: 'microsoft',
            emailAtLink: 'secondary-link@example.test',
            linkedAt: '2026-06-02T13:00:00.000Z',
            lastLoginAt: '2026-06-11T09:45:00.000Z',
        },
    ];
}

async function clickUnlinkForRow(page: Page, emailAtLink: string): Promise<void> {
    await page.locator('tr', { hasText: emailAtLink }).getByRole('button', { name: 'Отвязать' }).click();
}

async function confirmProfileUnlink(page: Page, password: string): Promise<void> {
    const modal = page.locator('.ant-modal').filter({ hasText: 'Отвязать вход через SSO' });
    await expect(modal).toBeVisible();
    await modal.getByPlaceholder('Пароль').fill(password);
    await modal.getByRole('button', { name: 'Отвязать', exact: true }).click();
}

async function confirmAdminUnlink(page: Page): Promise<void> {
    const modal = page.locator('.ant-modal').filter({ hasText: 'Отвязать SSO-вход пользователя' });
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Отвязать', exact: true }).click();
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
    await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
    });
}
