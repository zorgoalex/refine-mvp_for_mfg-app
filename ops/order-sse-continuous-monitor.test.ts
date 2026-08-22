import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');

describe('Order SSE continuous monitor installer', () => {
  it('installs a repeatable exact-SHA bundle without enabling systemd', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'order-sse-monitor-'));
    const fixtureRepo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    const systemctlLog = path.join(root, 'systemctl.log');
    try {
      for (const directory of ['ops/systemd', 'scripts']) {
        mkdirSync(path.join(fixtureRepo, directory), { recursive: true });
      }
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      for (const relativePath of [
        'ops/install-order-sse-continuous-monitor.sh',
        'ops/order-sse-continuous-once.sh',
        'ops/systemd/order-sse-continuous-monitor.service',
        'ops/systemd/order-sse-continuous-monitor.timer',
        'scripts/order-sse-guarded-run.sh',
        'scripts/order-sse-rollout.js',
        'scripts/order-sse-rollout-lib.js',
      ]) {
        copyFileSync(path.join(repoRoot, relativePath), path.join(fixtureRepo, relativePath));
      }
      const systemctl = path.join(bin, 'systemctl');
      writeFileSync(systemctl, [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >>"$SYSTEMCTL_LOG"',
        'if [[ "$1 $2" == "--user is-enabled" ]]; then',
        '  [[ "${SYSTEMCTL_TIMER_ENABLED:-false}" == "true" ]] && exit 0',
        '  exit 1',
        'fi',
        'if [[ "$1 $2" == "--user is-active" ]]; then exit 3; fi',
        'exit 0',
        '',
      ].join('\n'));
      chmodSync(systemctl, 0o755);

      runGit(fixtureRepo, ['init', '-q']);
      runGit(fixtureRepo, ['config', 'user.name', 'Order SSE Test']);
      runGit(fixtureRepo, ['config', 'user.email', 'order-sse@example.invalid']);
      runGit(fixtureRepo, ['add', '.']);
      runGit(fixtureRepo, ['commit', '-qm', 'fixture']);
      const sha = runGit(fixtureRepo, ['rev-parse', 'HEAD']).trim();
      const installer = path.join(fixtureRepo, 'ops/install-order-sse-continuous-monitor.sh');
      chmodSync(installer, 0o755);
      const env = {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        SYSTEMCTL_LOG: systemctlLog,
      };

      execFileSync(installer, [sha], { cwd: fixtureRepo, env });
      execFileSync(installer, [sha], { cwd: fixtureRepo, env });
      const enabledTimer = spawnSync(installer, [sha], {
        cwd: fixtureRepo,
        env: { ...env, SYSTEMCTL_TIMER_ENABLED: 'true' },
      });
      expect(enabledTimer.status).toBe(75);

      const candidateDir = path.join(home, '.local/libexec/erp-order-sse/candidates', sha);
      expect(readFileSync(path.join(candidateDir, 'candidate.sha'), 'utf8')).toBe(`${sha}\n`);
      expect(statSync(path.join(candidateDir, 'order-sse-guarded-run.sh')).mode & 0o777).toBe(0o555);
      expect(statSync(path.join(candidateDir, 'order-sse-rollout-lib.js')).mode & 0o777).toBe(0o444);
      expect(readFileSync(
        path.join(home, '.local/state/erp-order-sse/continuous.env'),
        'utf8',
      )).toBe(`ORDER_SSE_EXPECTED_STAGE_SHA=${sha}\nORDER_SSE_RUNNER_DIR=${candidateDir}\n`);
      expect(readFileSync(
        path.join(home, '.config/systemd/user/order-sse-continuous-monitor.service'),
        'utf8',
      )).toContain('ExecStart=%h/.local/libexec/erp-order-sse/order-sse-continuous-once.sh');
      const systemctlCalls = readFileSync(systemctlLog, 'utf8');
      expect(systemctlCalls).toContain('--user daemon-reload');
      expect(systemctlCalls).not.toMatch(/--user (?:enable|start)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
