import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'scripts/typecheck-ratchet.test.js',
    ],
    exclude: ['node_modules/**', 'dist/**', '.worktrees/**', 'tests/**', 'backend/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, 'backend/src/shared'),
    },
  },
});
