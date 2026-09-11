import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const source = process.cwd();
const gitBinary = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

// Synthetic repos only. Inner binaries model hook routing; the local test suite
// itself must run under the real shared-host resource guard, never this stub.
export function createGitGateFixture() {
  const owner = mkdtempSync(path.join(tmpdir(), 'erp-git-gate-'));
  const cwd = path.join(owner, 'repo with spaces');
  const bin = path.join(owner, 'bin with spaces');
  mkdirSync(cwd);
  mkdirSync(bin);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Тест gate', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Тест gate', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    CI: 'false', GITHUB_ACTIONS: 'false', VERCEL: 'false',
  });
  const checker = path.join(source, 'scripts/typecheck-ratchet.mjs');
  function run(command, args, options = {}) {
    return spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 20_000, ...options });
  }
  function git(args, options = {}) {
    const result = run(gitBinary, args, options);
    if (result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
    return result.stdout.trim();
  }
  function write(file, content) {
    const target = path.join(cwd, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  function binary(name, content) {
    writeFileSync(path.join(bin, name), '#!/bin/sh\n' + content + '\n');
    chmodSync(path.join(bin, name), 0o755);
  }
  binary('git', `exec "${gitBinary}" "$@"`);
  binary('rtk', 'shift 3\nif [ "$1" != "$EXPECTED_GUARD" ]; then echo UNEXPECTED_GUARD >&2; exit 97; fi\nexec "$@"');
  binary('guard', 'echo GUARD_CALLED\nif [ "${GUARD_EXIT:-0}" -ne 0 ]; then exit "$GUARD_EXIT"; fi\nshift\nexec "$@"');
  binary('npm', 'printf "CHECKER_CALLED %s\\n" "$*"\nif [ "${REAL_CHECKER:-0}" = 1 ]; then exec "$NODE_BINARY" "$CHECKER_SCRIPT"; fi\nexit "${CHECKER_EXIT:-0}"');
  const hookEnv = {
    ...env, PATH: bin, RTK_HEAVY_GUARD: path.join(bin, 'guard'),
    // Git prepends its exec-path before invoking hooks. Keep the controlled Git
    // wrapper first so config-failure tests also exercise a real git commit.
    GIT_EXEC_PATH: bin,
    NODE_BINARY: process.execPath, CHECKER_SCRIPT: checker,
    EXPECTED_GUARD: path.join(bin, 'guard'),
    GUARD_EXIT: '0', CHECKER_EXIT: '0', REAL_CHECKER: '0',
  };
  for (const file of ['.githooks/pre-commit', '.githooks/pre-push', '.githooks/run-heavy.sh', 'scripts/install-git-hooks.js']) {
    const original = path.join(source, file);
    if (!existsSync(original)) continue; // Allows RED against the old hooks.
    write(file, readFileSync(original));
    chmodSync(path.join(cwd, file), statSync(original).mode & 0o777);
  }
  write('scripts/typecheck-baseline.json', '{}');
  write('tsconfig.app.json', JSON.stringify({ compilerOptions: {
    noEmit: true, strict: true, skipLibCheck: true, types: [], lib: ['ES2022'],
  }, files: ['probe.ts'] }));
  write('probe.ts', 'const value: number = 1;\n');
  git(['init', '--quiet']);
  git(['add', '.']);
  // Bootstrap before hooks installation; no --no-verify or hooksPath override.
  git(['commit', '--quiet', '-m', 'Тест fixture bootstrap']);
  return {
    owner, cwd, bin, env, hookEnv, run, git, write, binary, gitBinary,
    cleanup: () => rmSync(owner, { recursive: true, force: true }),
    install: (where = cwd) => run(process.execPath, [path.join(where, 'scripts/install-git-hooks.js')], { cwd: where }),
    head: () => git(['rev-parse', 'HEAD']),
    commit: (overrides = {}) => run(gitBinary, ['commit', '--allow-empty', '--quiet', '-m', 'Тест hook'], { env: { ...hookEnv, ...overrides } }),
    hook: (name, overrides = {}) => run('/bin/sh', [path.join(cwd, '.githooks', name)], { env: { ...hookEnv, ...overrides } }),
    policy: (ref, args = [], options = {}) => run(process.execPath, [checker, '--verify-baseline-against', ref, ...args], options),
    target: (content, mode = '100644') => {
      let tree;
      if (content === undefined) tree = git(['mktree'], { input: '' });
      else {
        const blob = git(['hash-object', '-w', '--stdin'], { input: content });
        const scriptsTree = git(['mktree'], { input: `${mode} blob ${blob}\ttypecheck-baseline.json\n` });
        tree = git(['mktree'], { input: `040000 tree ${scriptsTree}\tscripts\n` });
      }
      return git(['commit-tree', tree, '-m', 'Тест baseline target']);
    },
  };
}
