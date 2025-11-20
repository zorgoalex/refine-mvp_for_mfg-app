import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
    test.beforeEach(async ({ page }) => {
        // Очищаем localStorage
        await page.goto('/');
        await page.evaluate(() => localStorage.clear());

        // Mock API /api/login
        await page.route(/\/api\/login$/, async (route) => {
            const postData = JSON.parse(route.request().postData() || '{}');
            const username = postData.username || postData.email;

            // Принимаем username='admin' или email='admin@mebelkz.local'
            if ((username === 'admin' || username === 'admin@mebelkz.local') && postData.password === 'admin123') {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwidXNlcm5hbWUiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiIsImh0dHBzOi8vaGFzdXJhLmlvL2p3dC9jbGFpbXMiOnsiWC1IYXN1cmEtQWxsb3dlZC1Sb2xlcyI6WyJhZG1pbiJdLCJYLUhhc3VyYS1EZWZhdWx0LVJvbGUiOiJhZG1pbiIsIlgtSGFzdXJhLVVzZXItSWQiOiIxIn0sImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ.test',
                        refreshToken: 'mock-refresh-token',
                        user: {
                            id: '1',
                            username: 'admin',
                            role: 'admin',
                        },
                    }),
                });
            } else {
                await route.fulfill({
                    status: 401,
                    contentType: 'application/json',
                    body: JSON.stringify({ error: 'Invalid credentials' }),
                });
            }
        });

        // Mock GraphQL
        await page.route(/\/v1\/graphql$/, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    data: {
                        orders_view: [],
                        orders_view_aggregate: { aggregate: { count: 0 } },
                    },
                }),
            });
        });
    });

    test('should redirect to login page when accessing protected route', async ({ page }) => {
        await page.goto('/orders');
        await expect(page).toHaveURL(/.*\/login/, { timeout: 10000 });
    });

    test('should login successfully', async ({ page }) => {
        await page.goto('/login');
        await page.waitForSelector('form', { timeout: 10000 });

        // Заполняем форму валидным username
        await page.fill('#username', 'admin');
        await page.fill('#password', 'admin123');

        // Кликаем на кнопку Войти
        await page.click('button:has-text("Войти")');

        // Ждем редирект
        await expect(page).toHaveURL(/\//, { timeout: 15000 });

        // Проверяем что токены сохранены
        const hasToken = await page.evaluate(() => {
            return localStorage.getItem('access_token') !== null;
        });
        expect(hasToken).toBeTruthy();
    });

    test('should logout successfully', async ({ page }) => {
        // Логинимся
        await page.goto('/login');
        await page.waitForSelector('form');
        await page.fill('#username', 'admin');
        await page.fill('#password', 'admin123');
        await page.click('button:has-text("Войти")');

        // Ждем успешного логина
        await expect(page).toHaveURL(/\//, { timeout: 15000 });

        // Находим и кликаем на dropdown пользователя
        const userDropdown = page.locator('.ant-dropdown-trigger').first();
        await userDropdown.waitFor({ state: 'visible', timeout: 5000 });
        await userDropdown.click();

        // Кликаем Выйти
        await page.click('text=Выйти');

        // Проверяем редирект на login
        await expect(page).toHaveURL(/.*\/login/, { timeout: 10000 });

        // Проверяем что токены очищены
        const hasToken = await page.evaluate(() => {
            return localStorage.getItem('access_token') === null;
        });
        expect(hasToken).toBeTruthy();
    });
});
