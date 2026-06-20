import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'backend/src/modules/sheet-materials/adapters/*.integration.ts',
      // SP3: order-side sheet-material write/read + migration 029 apply coverage live
      // under the orders module adapters; same SHEET_INTEGRATION_DATABASE_URL runner.
      'backend/src/modules/orders/adapters/*.integration.ts',
    ],
    env: {
      JWT_SECRET: 'test-secret-test-secret-test-secret',
      JWT_REFRESH_SECRET: 'test-refresh-test-refresh-test-refresh',
      // Dedicated run -> a missing SHEET_INTEGRATION_DATABASE_URL is a hard error, not a silent skip.
      SHEET_INTEGRATION_REQUIRED: '1',
    },
  },
});
