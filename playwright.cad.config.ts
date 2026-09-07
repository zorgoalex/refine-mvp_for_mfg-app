import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'cad-order-variants.spec.ts', workers: 1, retries: 0,
  timeout: 120000, expect: { timeout: 15000 }, reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5187', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  // Test a production bundle: no dev optimizer/HMR resets during editing.
  // Build once with `vite build` before running this config.
  webServer: { command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5187 --strictPort', port: 5187, reuseExistingServer: false, timeout: 120000 },
});
