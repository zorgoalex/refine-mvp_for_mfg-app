import { defineConfig } from 'vitest/config';
import path from 'path';

// Doweling writes on a real PostgreSQL (DOWELING_INTEGRATION_DATABASE_URL — a scratch database with the ERP schema).
// Sequential: the concurrency cases hold row locks across connections.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['backend/src/modules/doweling/adapters/*.integration.ts'],
        fileParallelism: false,
        testTimeout: 30000,
        env: {
            JWT_SECRET: 'test-secret-key-for-unit-tests-only-must-be-256-bits-long',
            JWT_REFRESH_SECRET: 'test-refresh-secret-key-for-unit-tests-only-must-be-256-bits-long',
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
});
