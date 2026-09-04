import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'db/migrations/**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    env: {
      JWT_SECRET: 'test-secret-key-for-unit-tests-only-must-be-256-bits-long',
      JWT_REFRESH_SECRET: 'test-refresh-secret-key-for-unit-tests-only-must-be-256-bits-long',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../src'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
