import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright Configuration
 *
 * Использует vercel dev для запуска сервера (порт 3000 по умолчанию, или 3001 если 3000 занят)
 * Это позволяет тестировать Vercel Functions локально
 *
 * ВАЖНО: Текущая конфигурация использует порт 3001
 * Если ваш vercel dev запускается на другом порту - обновите baseURL и port ниже
 *
 * Для тестирования:
 * 1. npm run test:e2e - автоматически запустит vercel dev
 * 2. Или запустите вручную: npm run dev:vercel
 */
export default defineConfig({
    testDir: './tests',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: 'list',
    use: {
        baseURL: 'http://localhost:3001',
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        command: 'npm run dev:vercel',
        port: 3001,
        reuseExistingServer: !process.env.CI,
        timeout: 120000, // 2 минуты на запуск (vercel dev медленнее чем vite)
    },
});
