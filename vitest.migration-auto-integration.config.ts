import { defineConfig } from 'vitest/config';

// Real-DB rehearsal of `ops/apply-migrations.sh auto` against a SCRATCH
// database inside the erp_test postgres container. Run explicitly:
//   npx vitest run --config vitest.migration-auto-integration.config.ts
export default defineConfig({
    test: {
        environment: 'node',
        include: ['ops/migration-auto.integration.ts'],
        fileParallelism: false,
        testTimeout: 600_000,
        hookTimeout: 600_000,
    },
});
