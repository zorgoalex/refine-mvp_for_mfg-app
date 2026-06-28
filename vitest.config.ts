import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
        exclude: [
            'node_modules',
            '**/node_modules/**',
            'dist',
            '**/dist/**',
            '.idea',
            '.git',
            '.worktrees/**',
            '.cache',
            'ai_docs/**',
            'tests/**',
            'e2e/**',
        ],
        env: {
            JWT_SECRET: 'test-secret-key-for-unit-tests-only-must-be-256-bits-long',
            JWT_REFRESH_SECRET: 'test-refresh-secret-key-for-unit-tests-only-must-be-256-bits-long',
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            // Shared pure-TS geometry module (same alias as vite.config.ts).
            '@shared': path.resolve(__dirname, 'backend/src/shared'),
        },
    },
});
