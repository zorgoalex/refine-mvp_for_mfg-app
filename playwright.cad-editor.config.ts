import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: ['cad-editor-ux.spec.ts', 'cad-order-variants.spec.ts'], fullyParallel: false, workers: 1, retries: 0,
  timeout: 90000, expect: { timeout: 20000 }, reporter: 'list', outputDir: './test-results/cad-editor-ux',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5187', trace: 'retain-on-failure',
    // The shared-host resource guard uses LC_ALL=C for parsing. Chromium needs
    // UTF-8 for Cyrillic filenames; only the browser child gets this override.
    launchOptions: { env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' } } },
  webServer: { command: process.env.CAD_BROWSER_BUILT === 'true'
    ? 'npm run preview -- --host 127.0.0.1 --port 5187 --strictPort'
    : 'npm run dev -- --config vite.cad-editor.config.ts --host 127.0.0.1 --port 5187 --strictPort',
    port: 5187, reuseExistingServer: false, timeout: 120000 },
});
