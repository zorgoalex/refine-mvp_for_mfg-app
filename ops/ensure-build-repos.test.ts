import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(__dirname, 'ensure-build-repos.sh');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRemote(): { remote: string; author: string } {
  const root = mkdtempSync(join(tmpdir(), 'ebr-git-'));
  const remote = join(root, 'remote.git');
  const author = join(root, 'author');
  mkdirSync(author);
  git(root, 'init', '--bare', remote);
  git(author, 'init', '-b', 'main');
  git(author, 'config', 'user.email', 'test@example.invalid');
  git(author, 'config', 'user.name', 'Test');
  writeFileSync(join(author, 'revision.txt'), 'one\n');
  git(author, 'add', 'revision.txt');
  git(author, 'commit', '-m', 'one');
  git(author, 'remote', 'add', 'origin', remote);
  git(author, 'push', '-u', 'origin', 'main');
  return { remote, author };
}

describe('ensure-build-repos.sh', () => {
  it('--dry-run reports both target repos and clones nothing', () => {
    const out = execFileSync('bash', [script, '--dry-run'], { encoding: 'utf8' });
    expect(out).toContain('repo_freecut');
    expect(out).toContain('repo_svgdxf');
    expect(out).toMatch(/dry-run/i);
  });

  it('rejects an unknown option', () => {
    expect(() => execFileSync('bash', [script, '--bogus'], { encoding: 'utf8' })).toThrow();
  });

  it('--dry-run against an empty root reports clones and creates nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebr-'));
    const out = execFileSync('bash', [script, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root },
    });
    expect(out).toMatch(/would clone.*repo_freecut/);
    expect(out).toMatch(/would clone.*repo_svgdxf/);
    expect(existsSync(join(root, 'repo_freecut'))).toBe(false);
    expect(existsSync(join(root, 'repo_svgdxf'))).toBe(false);
  });

  it('fails when a target path exists but is not a git checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebr-'));
    mkdirSync(join(root, 'repo_freecut'));
    expect(() =>
      execFileSync('bash', [script], {
        encoding: 'utf8',
        env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root },
      }),
    ).toThrow();
  });

  // Regression: the normal (non-dry-run) path with both repos already present
  // MUST exit 0. A trailing `[ "$DRY" -eq 1 ] && echo` returned 1 here, which
  // under `set -e` silently aborted callers (provision) right after this step.
  it('exits 0 on the normal path when both repos are already present', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebr-'));
    mkdirSync(join(root, 'repo_freecut', '.git'), { recursive: true });
    mkdirSync(join(root, 'repo_svgdxf', '.git'), { recursive: true });
    const out = execFileSync('bash', [script], {
      encoding: 'utf8',
      env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root },
    });
    expect(out).toMatch(/repo_freecut present/);
    expect(out).toMatch(/repo_svgdxf present/);
    // execFileSync throws on non-zero exit, so reaching here proves exit 0.
  });

  it('--update fast-forwards a clean checkout and verifies the remote revision', () => {
    const { remote, author } = makeRemote();
    const root = mkdtempSync(join(tmpdir(), 'ebr-root-'));
    execFileSync('bash', [script, '--only', 'repo_freecut'], {
      env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root, FREECUT_REPO_URL: remote },
    });
    writeFileSync(join(author, 'revision.txt'), 'two\n');
    git(author, 'add', 'revision.txt');
    git(author, 'commit', '-m', 'two');
    git(author, 'push');

    const out = execFileSync('bash', [script, '--update', '--only', 'repo_freecut'], {
      encoding: 'utf8',
      env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root, FREECUT_REPO_URL: remote },
    });

    expect(out).toMatch(/verified at [0-9a-f]+/);
    expect(git(join(root, 'repo_freecut'), 'rev-parse', 'HEAD')).toBe(git(author, 'rev-parse', 'HEAD'));
  });

  it('--update refuses a dirty checkout instead of overwriting local work', () => {
    const { remote } = makeRemote();
    const root = mkdtempSync(join(tmpdir(), 'ebr-root-'));
    execFileSync('bash', [script, '--only', 'repo_freecut'], {
      env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root, FREECUT_REPO_URL: remote },
    });
    writeFileSync(join(root, 'repo_freecut', 'local.txt'), 'local\n');

    expect(() => execFileSync('bash', [script, '--update', '--only', 'repo_freecut'], {
      env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root, FREECUT_REPO_URL: remote },
    })).toThrow();
  });

  it('--update refuses a checkout on the wrong branch', () => {
    const { remote } = makeRemote();
    const root = mkdtempSync(join(tmpdir(), 'ebr-root-'));
    execFileSync('bash', [script, '--only', 'repo_freecut'], { env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root, FREECUT_REPO_URL: remote } });
    git(join(root, 'repo_freecut'), 'switch', '-c', 'other');
    expect(() => execFileSync('bash', [script, '--update', '--only', 'repo_freecut'], {
      env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root, FREECUT_REPO_URL: remote },
    })).toThrow();
  });

  it('--update refuses a local-ahead checkout that does not equal remote head', () => {
    const { remote } = makeRemote();
    const root = mkdtempSync(join(tmpdir(), 'ebr-root-'));
    execFileSync('bash', [script, '--only', 'repo_freecut'], { env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root, FREECUT_REPO_URL: remote } });
    const checkout = join(root, 'repo_freecut');
    git(checkout, 'config', 'user.email', 'test@example.invalid');
    git(checkout, 'config', 'user.name', 'Test');
    writeFileSync(join(checkout, 'local.txt'), 'committed\n');
    git(checkout, 'add', 'local.txt');
    git(checkout, 'commit', '-m', 'local ahead');
    expect(() => execFileSync('bash', [script, '--update', '--only', 'repo_freecut'], {
      env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root, FREECUT_REPO_URL: remote },
    })).toThrow();
  });

  it('--update refuses an unexpected origin URL', () => {
    const { remote } = makeRemote();
    const root = mkdtempSync(join(tmpdir(), 'ebr-root-'));
    execFileSync('bash', [script, '--only', 'repo_freecut'], { env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root, FREECUT_REPO_URL: remote } });
    expect(() => execFileSync('bash', [script, '--update', '--only', 'repo_freecut'], {
      env: { ...process.env, ENSURE_BUILD_REPOS_ROOT: root, FREECUT_REPO_URL: `${remote}-other` },
    })).toThrow();
  });
});
