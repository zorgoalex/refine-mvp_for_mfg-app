import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright Configuration
 *
 * Использует Vite dev server (5173) + Vercel Functions (3001) через proxy
 * Это обеспечивает полноценную работу фронтенда и API endpoints
 *
 * Для тестирования:
 * 1. npm run test:e2e - автоматически запустит оба сервера
 * 2. Или запустите вручную: npm run dev:full
 */
export default defineConfig({
    testDir: './tests',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: 'list',
    use: {
        baseURL: 'http://localhost:5173',
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        command: 'npm run dev:full',
        port: 5173,
        reuseExistingServer: !process.env.CI,
        timeout: 120000, // 2 минуты на запуск (оба сервера)
    },
});
