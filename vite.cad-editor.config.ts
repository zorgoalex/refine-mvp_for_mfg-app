import { defineConfig, mergeConfig } from 'vite';
import { resolve } from 'node:path';
import base from './vite.config';
// Isolate optimizer writes when dependencies are shared with another worktree.
export default defineConfig(env => mergeConfig(base(env), { cacheDir: resolve(__dirname, '.cache/cad-editor-vite') }));
