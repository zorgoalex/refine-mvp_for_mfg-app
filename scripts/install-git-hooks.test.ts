import { createRequire } from 'node:module';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { installGitHooks, isCiEnvironment } = require('./install-git-hooks.js');

describe('installGitHooks', () => {
  it('configures repository hooks outside CI', () => {
    const run = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: 'true\n' })
      .mockReturnValueOnce({ status: 0, stdout: '' });

    expect(installGitHooks({ env: {}, run })).toEqual({ installed: true });
    expect(run).toHaveBeenNthCalledWith(
      2,
      'git',
      ['config', 'core.hooksPath', '.githooks'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it.each([
    { CI: 'true' },
    { CI: '1' },
    { CI: 'YES' },
    { GITHUB_ACTIONS: 'true' },
    { VERCEL: '1' },
  ])('does not mutate Git configuration in CI: %o', (env) => {
    const run = vi.fn();

    expect(isCiEnvironment(env)).toBe(true);
    expect(installGitHooks({ env, run })).toEqual({ installed: false, reason: 'ci' });
    expect(run).not.toHaveBeenCalled();
  });

  it('does not treat explicit false values as CI', () => {
    expect(isCiEnvironment({ CI: 'false', GITHUB_ACTIONS: '0', VERCEL: '' })).toBe(false);
  });

  it('does nothing outside a Git worktree', () => {
    const run = vi.fn().mockReturnValue({ status: 128, stdout: '' });

    expect(installGitHooks({ env: {}, run })).toEqual({
      installed: false,
      reason: 'not-a-git-worktree',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(['.githooks/pre-commit', '.githooks/pre-push'])(
    'preserves Git configuration when %s is unavailable',
    (missingHook) => {
      const run = vi.fn().mockReturnValue({ status: 0, stdout: 'true\n' });

      expect(installGitHooks({
        env: {},
        run,
        exists: (path: string) => path !== missingHook,
      })).toEqual({
        installed: false,
        reason: 'hooks-not-found',
      });
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it('reports a failed Git configuration update', () => {
    const run = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: 'true\n' })
      .mockReturnValueOnce({ status: 1, stdout: '' });

    expect(() => installGitHooks({ env: {}, run })).toThrow('Failed to configure core.hooksPath');
  });
});

describe('pre-commit hook', () => {
  it('falls back to npm when RTK guard is unavailable', () => {
    const sandbox = mkdtempSync(resolve(tmpdir(), 'erp-pre-commit-'));
    const npmPath = resolve(sandbox, 'npm');
    const markerPath = resolve(sandbox, 'npm-args');
    writeFileSync(npmPath, `#!/bin/sh\nprintf '%s' "$*" > "${markerPath}"\n`);
    chmodSync(npmPath, 0o755);

    try {
      const result = spawnSync('/bin/sh', [resolve('.githooks/pre-commit')], {
        env: {
          PATH: sandbox,
          HOME: sandbox,
          RTK_HEAVY_GUARD: resolve(sandbox, 'missing-guard'),
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(readFileSync(markerPath, 'utf8')).toBe('run typecheck:ratchet');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('pre-push hook', () => {
  it('falls back to npm when RTK guard is unavailable', () => {
    const sandbox = mkdtempSync(resolve(tmpdir(), 'erp-pre-push-'));
    const npmPath = resolve(sandbox, 'npm');
    const markerPath = resolve(sandbox, 'npm-args');
    writeFileSync(npmPath, `#!/bin/sh\nprintf '%s' "$*" > "${markerPath}"\n`);
    chmodSync(npmPath, 0o755);

    try {
      const result = spawnSync('/bin/sh', [resolve('.githooks/pre-push')], {
        env: {
          PATH: sandbox,
          HOME: sandbox,
          RTK_HEAVY_GUARD: resolve(sandbox, 'missing-guard'),
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(readFileSync(markerPath, 'utf8')).toBe('run test:business-references');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
