import { createRequire } from 'node:module';
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

  it.each(['.githooks/pre-commit', '.githooks/pre-push', '.githooks/run-heavy.sh'])(
    'fails installation without changing Git configuration when %s is unavailable',
    (missingHook) => {
      const run = vi.fn().mockReturnValue({ status: 0, stdout: 'true\n' });

      expect(() => installGitHooks({
        env: {},
        run,
        exists: (path: string) => path !== missingHook,
      })).toThrow(/missing/i);
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it('reports a failed Git configuration update', () => {
    const run = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: 'true\n' })
      .mockReturnValueOnce({ status: 1, stdout: '' });

    expect(() => installGitHooks({ env: {}, run })).toThrow('Failed to configure core.hooksPath');
  });

  it('rejects directories in place of required files', () => {
    const run = vi.fn().mockReturnValue({ status: 0, stdout: 'true\n' });
    expect(() => installGitHooks({ env: {}, run, stat: () => ({ isFile: () => false }) })).toThrow(/regular file/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('fails when the runner cannot be read, before configuring Git', () => {
    const run = vi.fn().mockReturnValue({ status: 0, stdout: 'true\n' });
    const access = (file: string) => { if (file.endsWith('run-heavy.sh')) throw new Error('EACCES'); };
    expect(() => installGitHooks({ env: {}, run, access })).toThrow(/runner must be readable/);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
