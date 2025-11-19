import { test, expect } from '@playwright/test';

test.describe('Authentication API', () => {
    test('POST /api/login should return tokens for valid credentials', async ({ request }) => {
        const response = await request.post('/api/login', {
            data: {
                username: 'admin',
                password: 'admin123'
            }
        });

        expect(response.ok()).toBeTruthy();
        const body = await response.json();
        expect(body).toHaveProperty('accessToken');
        expect(body).toHaveProperty('refreshToken');
        expect(body.user).toHaveProperty('username', 'admin');
    });

    test('POST /api/login should fail for invalid credentials', async ({ request }) => {
        const response = await request.post('/api/login', {
            data: {
                username: 'admin',
                password: 'wrongpassword'
            }
        });

        expect(response.status()).toBe(401);
    });
});

test.describe('Authentication UI', () => {
    test('should redirect to login page when accessing protected route', async ({ page }) => {
        await page.goto('/orders');
        await expect(page).toHaveURL(/.*\/login/);
    });

    test('should login successfully', async ({ page }) => {
        await page.goto('/login');

        await page.fill('input[name="username"]', 'admin');
        await page.fill('input[name="password"]', 'admin123');
        await page.click('button[type="submit"]');

        // Should redirect to home or orders
        await expect(page).toHaveURL(/\/orders/);

        // Check if header contains user info
        await expect(page.getByText('Администратор')).toBeVisible();
    });

    test('should logout successfully', async ({ page }) => {
        // Login first
        await page.goto('/login');
        await page.fill('input[name="username"]', 'admin');
        await page.fill('input[name="password"]', 'admin123');
        await page.click('button[type="submit"]');
        await expect(page).toHaveURL(/\/orders/);

        // Logout
        await page.click('.ant-dropdown-trigger'); // Click user menu
        await page.click('text=Выйти');

        await expect(page).toHaveURL(/.*\/login/);
    });
});
