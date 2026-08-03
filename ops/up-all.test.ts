import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';

const script = resolve(__dirname, 'up-all.sh');
const source = readFileSync(script, 'utf8');
const deploySource = readFileSync(resolve(__dirname, 'deploy-stack.sh'), 'utf8');
const setupSource = readFileSync(resolve(__dirname, 'setup-vps.sh'), 'utf8');
const checkEnvSource = readFileSync(resolve(__dirname, 'check-env.sh'), 'utf8');
const cncWorkerSource = readFileSync(resolve(__dirname, 'cnc-telegram-worker.sh'), 'utf8');
const composeSource = readFileSync(resolve(__dirname, 'templates/docker-compose.vps.yml'), 'utf8');
function run(args: string[]) {
  return execFileSync('bash', [script, ...args], { encoding: 'utf8' });
}

function runCncWorker(
  role: string,
  stackEnv = 'test',
  allowNonProdWriter = 'false',
  args = ['up'],
) {
  const tempDir = mkdtempSync(resolve(tmpdir(), 'cnc-worker-test-'));
  const fakeBinDir = resolve(tempDir, 'bin');
  const envFile = resolve(tempDir, '.env');
  const fakeDocker = resolve(fakeBinDir, 'docker');
  mkdirSync(fakeBinDir);
  writeFileSync(envFile, [
    `ERP_STACK_ENV=${stackEnv}`,
    `CNC_TELEGRAM_WORKER_ROLE=${role}`,
    `CNC_TELEGRAM_ALLOW_NON_PROD_WRITER=${allowNonProdWriter}`,
    'COMPOSE_PROJECT_NAME=erp_test',
  ].join('\n'));
  writeFileSync(fakeDocker, '#!/usr/bin/env bash\nprintf \'docker %s\\n\' "$*"\n');
  chmodSync(fakeDocker, 0o755);
  try {
    return spawnSync('bash', [resolve(__dirname, 'cnc-telegram-worker.sh'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ENV_FILE: envFile,
        VPS_FILE: resolve(__dirname, 'templates/docker-compose.vps.yml'),
        PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ''}`,
      },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('up-all.sh provision', () => {
  it('--dry-run prints the ordered plan and runs nothing destructive', () => {
    const out = run(['provision', '--dry-run']);
    expect(out).toMatch(/update-build-repos/);
    expect(out).toMatch(/check-env/);
    expect(out).toMatch(/compose up/);
    expect(out).toMatch(/apply-migrations/);
    expect(out).toMatch(/smoke/);
    expect(out).toMatch(/dry-run/i);
  });

  it('defaults migrate to skip and hasura to the bundled baseline', () => {
    const out = run(['provision', '--dry-run']);
    expect(out).toMatch(/migrate:\s*skip/i);
    expect(out).toMatch(/hasura:\s*bundled/i);
  });

  it('still refuses a bare down on the merged stack', () => {
    expect(() => run(['down'])).toThrow();
  });

  it('rejects an unknown provision flag', () => {
    expect(() => run(['provision', '--bogus', '--dry-run'])).toThrow();
  });

  it('updates and verifies build repositories before provision builds', () => {
    expect(source).toMatch(/ensure-build-repos\.sh" --update[\s\S]*compose up -d --build/);
  });

  it('updates Freecut before rebuilding it, including a multi-service rebuild', () => {
    expect(source).toMatch(/for service in "\$@"[\s\S]*--update --only repo_freecut[\s\S]*compose build "\$@"[\s\S]*verify_freecut_sha[\s\S]*compose up -d --no-build --no-deps/);
  });

  it('holds a deployment lock and re-verifies Freecut after build', () => {
    expect(source).toContain('.freecut-deploy.lock');
    expect(source).toMatch(/flock 9[\s\S]*compose build[\s\S]*verify_freecut_sha/);
  });

  it('setup-vps updates and verifies Freecut under the same deployment lock', () => {
    expect(setupSource).toMatch(/flock 9[\s\S]*ensure_freecut_repo_if_missing[\s\S]*run_deploy[\s\S]*Freecut build source verified/);
    expect(setupSource).toMatch(/remote get-url origin[\s\S]*FREECUT_REPO_URL/);
  });

  it('fixes compose Freecut build context to the verified checkout', () => {
    expect(composeSource).toMatch(/freecut:[\s\S]*build:[\s\S]*context: \.\/repo_freecut/);
    expect(composeSource).not.toContain('FREECUT_BUILD_CONTEXT');
  });

  it('exports COMPOSE_PROFILES from .env before compose up', () => {
    expect(source).toMatch(/load_compose_profiles[\s\S]*export COMPOSE_PROFILES/);
    expect(source).toMatch(/preflight\(\)[\s\S]*load_compose_profiles/);
    expect(source).toMatch(/config\)[\s\S]*preflight[\s\S]*compose config/);
  });

  it('loads the test Compose overlay for the local test stack', () => {
    expect(source).toContain('docker-compose.test.yml');
    expect(source).toMatch(/-f "\$VPS_FILE"[\s\S]*-f "\$TEST_OVERLAY"/);
    expect(source).toMatch(/test compose overlay not found/);
  });

  it('deploy-stack overlays CNC Telegram worker for existing live compose files', () => {
    expect(deploySource).toContain('docker-compose.cnc-telegram-worker.yml');
    expect(deploySource).toContain('docker-compose.${stack_env}.yml');
    expect(deploySource).toMatch(/COMPOSE_FILE_ARGS\+=\(-f "\$CNC_TELEGRAM_OVERLAY"\)[\s\S]*COMPOSE_FILE_ARGS\+=\(-f "\$STACK_ENV_OVERLAY"\)/);
    expect(deploySource).toMatch(/compose_profile_enabled cnc-telegram[\s\S]*cnc-telegram-worker/);
    expect(deploySource).toMatch(/COMPOSE_FILE_ARGS=\(-f "\$COMPOSE_FILE"\)/);
    expect(deploySource).toMatch(/docker compose --env-file "\$ENV_FILE" "\$\{COMPOSE_FILE_ARGS\[@\]\}"/);
  });

  it('requires an explicit stack env and blocks non-prod Telegram writers', () => {
    expect(checkEnvSource).toContain('require_var ERP_STACK_ENV');
    expect(checkEnvSource).toMatch(/ERP_STACK_ENV must be one of: test, prod, dev/);
    expect(checkEnvSource).toMatch(/CNC_TELEGRAM_WORKER_ROLE must be one of: disabled, reader, writer/);
    expect(checkEnvSource).toMatch(/CNC_TELEGRAM_WORKER_ROLE=writer requires ERP_STACK_ENV=prod/);
    expect(cncWorkerSource).toMatch(/stack_env" == "prod"[\s\S]*role="writer"/);
    expect(cncWorkerSource).toMatch(/reader\)[\s\S]*writer\)/);
    expect(cncWorkerSource).toMatch(/refusing Telegram writer on ERP_STACK_ENV=\$stack_env/);
  });

  it('runs Telegram reader backfill without chat-writer override', () => {
    const result = runCncWorker('reader', 'test', 'false', ['backfill', '3']);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/cnc-telegram-worker once --days 3/);
  });

  it('keeps disabled Telegram worker stopped without invoking Compose', () => {
    const result = runCncWorker('disabled');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/CNC Telegram worker is disabled/);
  });

  it('rejects non-prod Telegram writer and invalid roles', () => {
    const writer = runCncWorker('writer');
    const invalid = runCncWorker('observer');

    expect(writer.status).toBe(1);
    expect(writer.stderr).toMatch(/refusing Telegram writer on ERP_STACK_ENV=test/);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toMatch(/must be one of: disabled, reader, writer/);
  });

  it('allows Telegram writer on prod', () => {
    const result = runCncWorker('writer', 'prod');

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/cnc-telegram-worker/);
  });
});
