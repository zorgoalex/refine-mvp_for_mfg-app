import { expect, test, type Page, type Route } from '@playwright/test';

const usersCutoverEnabled =
    process.env.VITE_USE_BACKEND_AUTH === 'true' &&
    process.env.VITE_USE_BACKEND_PERMISSIONS === 'true' &&
    process.env.VITE_USE_BACKEND_USERS === 'true';

test.describe('Users backend cutover', () => {
    test.skip(!usersCutoverEnabled, 'Run with VITE_USE_BACKEND_AUTH/PERMISSIONS/USERS=true');
    test.setTimeout(90000);

    test('uses /api/v1 users for list, create, update, and password change', async ({ page }) => {
        const api = await setupUsersBackendCutoverMock(page);

        await page.goto('/login');
        await page.locator('#username').fill('admin');
        await page.locator('#password').fill('admin123');
        await page.getByRole('button', { name: 'Войти' }).click();
        await expect(page).toHaveURL(/\//, { timeout: 15000 });

        await page.goto('/users');
        await expect.poll(() => api.listCalls.length).toBeGreaterThan(0);
        expect(api.graphqlCalls).toBe(0);

        await page.getByRole('button', { name: 'Создать' }).click();
        await page.locator('#username').fill('stage1_user');
        await page.locator('#email').fill('stage1_user@example.test');
        await page.locator('#password').fill('Stage1Pass!');
        await page.locator('#full_name').fill('Stage 1 User');
        await page.getByRole('button', { name: 'Сохранить' }).click();
        await expect.poll(() => api.createBodies.length).toBe(1);
        expect(api.createBodies[0]).toMatchObject({
            username: 'stage1_user',
            email: 'stage1_user@example.test',
            password: 'Stage1Pass!',
            role: 'viewer',
            fullName: 'Stage 1 User',
            isActive: true,
        });
        expect(api.createBodies[0]).not.toHaveProperty('role_id');

        await page.goto('/users/edit/11');
        await expect.poll(() => api.getCalls).toContain(11);
        await page.locator('#full_name').fill('Manager Updated');
        await page.getByRole('button', { name: 'Сохранить' }).click();
        await expect.poll(() => api.updateBodies.length).toBe(1);
        expect(api.updateBodies[0]).toMatchObject({
            email: 'manager@example.test',
            role: 'manager',
            fullName: 'Manager Updated',
            isActive: true,
        });
        expect(api.updateBodies[0]).not.toHaveProperty('role_id');

        await page.locator('#new_password').fill('ChangedPass1!');
        await page.getByRole('button', { name: 'Изменить пароль' }).click();
        await expect.poll(() => api.passwordBodies.length).toBe(1);
        expect(api.passwordBodies[0]).toEqual({
            newPassword: 'ChangedPass1!',
            revokeExistingSessions: true,
        });
    });
});

async function setupUsersBackendCutoverMock(page: Page) {
    const users = [
        backendUser({
            id: 1,
            username: 'admin',
            email: 'admin@example.test',
            fullName: 'Admin User',
            role: 'admin',
        }),
        backendUser({
            id: 11,
            username: 'manager',
            email: 'manager@example.test',
            fullName: 'Manager User',
            role: 'manager',
        }),
    ];
    const api = {
        listCalls: [] as string[],
        getCalls: [] as number[],
        createBodies: [] as Array<Record<string, unknown>>,
        updateBodies: [] as Array<Record<string, unknown>>,
        passwordBodies: [] as Array<Record<string, unknown>>,
        graphqlCalls: 0,
    };

    await page.route(/\/api\/v1\/auth\/login$/, async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        if (body.username !== 'admin' || body.password !== 'admin123') {
            await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
            return;
        }

        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                accessToken: 'backend-cutover-token',
                accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
                user: {
                    id: '1',
                    username: 'admin',
                    role: 'admin',
                    roleId: 1,
                    permissions: [
                        'users.view',
                        'users.create',
                        'users.update',
                        'users.change_password',
                        'users.deactivate',
                        'users.activate',
                        'settings.view',
                    ],
                },
            }),
        });
    });

    await page.route(/\/api\/v1\/auth\/refresh$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                accessToken: 'backend-cutover-token',
                accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
                user: {
                    id: '1',
                    username: 'admin',
                    role: 'admin',
                    roleId: 1,
                    permissions: ['users.view', 'users.create', 'users.update', 'users.change_password'],
                },
            }),
        });
    });

    await page.route(/\/api\/v1\/me$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                user: {
                    id: '1',
                    username: 'admin',
                    role: 'admin',
                    roleId: 1,
                    permissions: ['users.view', 'users.create', 'users.update', 'users.change_password'],
                },
            }),
        });
    });

    await page.route(/\/api\/v1\/users(?:\?.*)?$/, async (route) => {
        const request = route.request();
        if (request.method() === 'GET') {
            api.listCalls.push(request.url());
            await fulfillJson(route, {
                data: users,
                pagination: { page: 1, pageSize: 10, total: users.length, totalPages: 1 },
            });
            return;
        }

        if (request.method() === 'POST') {
            const body = JSON.parse(request.postData() || '{}');
            api.createBodies.push(body);
            const created = backendUser({
                id: 12,
                username: body.username,
                email: body.email,
                fullName: body.fullName,
                role: body.role,
            });
            users.push(created);
            await fulfillJson(route, { user: created });
            return;
        }

        await route.fallback();
    });

    await page.route(/\/api\/v1\/users\/(\d+)$/, async (route) => {
        const request = route.request();
        const userId = Number(new URL(request.url()).pathname.split('/').pop());
        const user = users.find((item) => item.id === userId);

        if (!user) {
            await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
            return;
        }

        if (request.method() === 'GET') {
            api.getCalls.push(userId);
            await fulfillJson(route, { user });
            return;
        }

        if (request.method() === 'PATCH') {
            const body = JSON.parse(request.postData() || '{}');
            api.updateBodies.push(body);
            Object.assign(user, {
                email: body.email ?? user.email,
                fullName: body.fullName ?? user.fullName,
                role: body.role ?? user.role,
                isActive: body.isActive ?? user.isActive,
                updatedAt: '2026-05-02T00:00:00.000Z',
            });
            await fulfillJson(route, { user });
            return;
        }

        await route.fallback();
    });

    await page.route(/\/api\/v1\/users\/(\d+)\/change-password$/, async (route) => {
        api.passwordBodies.push(JSON.parse(route.request().postData() || '{}'));
        await fulfillJson(route, { success: true, revokedSessions: 0 });
    });

    await page.route(/\/v1\/graphql$/, async (route) => {
        api.graphqlCalls += 1;
        await fulfillJson(route, { data: {} });
    });

    return api;
}

function backendUser(overrides: Record<string, any>) {
    return {
        id: 1,
        username: 'admin',
        email: 'admin@example.test',
        fullName: 'Admin User',
        role: 'admin',
        permissions: ['users.view'],
        employeeId: null,
        isActive: true,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
        ...overrides,
    };
}

async function fulfillJson(route: Route, body: unknown) {
    await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
    });
}
