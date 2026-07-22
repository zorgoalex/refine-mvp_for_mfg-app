import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        environment: 'node',
        include: [
            'backend/src/modules/cut/adapters/*.integration.ts',
            'backend/src/modules/labels/adapters/label-cut-map-migration.integration.ts',
        ],
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
