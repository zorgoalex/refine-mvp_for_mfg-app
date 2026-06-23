import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // These files are real-Postgres integration tests sharing ONE database. Running them
    // CONCURRENTLY caused two flakes: (1) the lock-sequenced reverse-concurrency test could not
    // observe its blocked session in time under connection/CPU contention, and (2) migration-029
    // bootstraps in the shared `public` schema and a concurrent 034-apply/rollback file would drop/
    // recreate those tables mid-run, wiping 029's asserted FK constraints. Run the files
    // SEQUENTIALLY (no two touch the shared DB at once) — the correct model for one-DB integration
    // suites; eliminates both races at the root. Generous timeouts kept as a safety margin.
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
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
