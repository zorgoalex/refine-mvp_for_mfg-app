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
  hasGlmContainer = false,
  renderedCommand = 'serve',
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
  writeFileSync(fakeDocker, [
    '#!/usr/bin/env bash',
    'if [[ " $* " == *" config --format json "* ]]; then',
    '  printf \'{"services":{"cnc-telegram-worker":{"command":["%s"]}}}\n\' "${FAKE_WORKER_COMMAND:-serve}"',
    '  exit 0',
    'fi',
    'if [[ " $* " == *" ps -aq glm-ocr-model-init "* ]]; then',
    '  [[ "${FAKE_GLM_CONTAINER:-false}" == "true" ]] && printf \'legacy-glm-container\\n\'',
    '  exit 0',
    'fi',
    'printf \'profiles=%s glm=%s timeout=%s ocr=%s docker %s\\n\' "${COMPOSE_PROFILES:-}" "${CNC_ENABLE_GLM_OCR:-false}" "${CNC_OCR_COMMAND_TIMEOUT_SECONDS:-}" "${CNC_OCR_COMMAND:-}" "$*"',
  ].join('\n'));
  chmodSync(fakeDocker, 0o755);
  try {
    return spawnSync('bash', [resolve(__dirname, 'cnc-telegram-worker.sh'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ENV_FILE: envFile,
        VPS_FILE: resolve(__dirname, 'templates/docker-compose.vps.yml'),
        FAKE_GLM_CONTAINER: String(hasGlmContainer),
        FAKE_WORKER_COMMAND: renderedCommand,
        PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ''}`,
      },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runCheckEnv(overrides: Record<string, string>) {
  const tempDir = mkdtempSync(resolve(tmpdir(), 'check-env-test-'));
  const envFile = resolve(tempDir, '.env');
  const values: Record<string, string> = {
    COMPOSE_PROJECT_NAME: 'erp_test',
    ERP_STACK_ENV: 'prod',
    EDGE_NETWORK_NAME: 'erp_edge',
    HASURA_FQDN: 'hasura.example.test',
    BACKEND_FQDN: 'api.example.test',
    FRONTEND_ORIGIN: 'https://app.example.test',
    LETSENCRYPT_EMAIL: 'ops@example.test',
    PG_DB: 'erpdb',
    PG_USER: 'erp',
    PG_PASSWORD: 'test-password',
    HASURA_GRAPHQL_DATABASE_URL: 'postgres://erp:test-password@postgresdb:5432/erpdb',
    HASURA_MD_DB: 'metadata',
    HASURA_MD_USER: 'metadata',
    HASURA_MD_PASSWORD: 'metadata-password',
    HASURA_ADMIN_SECRET: 'test-admin-secret',
    HASURA_JWT_SECRET: '12345678901234567890123456789012',
    HASURA_GRAPHQL_CORS_DOMAIN: 'https://app.example.test',
    BACKEND_REFRESH_TOKEN_PEPPER: '12345678901234567890123456789012',
    BACKEND_CORS_ALLOWED_ORIGINS: 'https://app.example.test',
    BACKEND_ENABLE_ORDER_EXPORT: 'false',
    BACKEND_ENABLE_VLM: 'false',
    BACKEND_ENABLE_CNC_TELEGRAM: 'true',
    COMPOSE_PROFILES: 'cnc-telegram',
    CNC_TELEGRAM_WORKER_ROLE: 'writer',
    TELEGRAM_API_ID: '12345',
    TELEGRAM_API_HASH: 'test-hash',
    TELEGRAM_CHAT: '-100123',
    TELEGRAM_ALLOWED_CHAT_ID: '-100123',
    ERP_WORKER_LOGIN: 'worker',
    ERP_WORKER_PASSWORD: 'worker-password',
    CNC_ENABLE_GLM_OCR: 'false',
    ...overrides,
  };
  writeFileSync(envFile, Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n'));
  try {
    return spawnSync('bash', [resolve(__dirname, 'check-env.sh'),
      '--env-file', envFile,
      '--compose-file', resolve(tempDir, 'missing-compose.yml')], { encoding: 'utf8' });
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
    expect(deploySource).toMatch(
      /compose_profile_enabled cnc-telegram; then[\s\S]*COMPOSE_FILE_ARGS\+=\(-f "\$CNC_TELEGRAM_OVERLAY"\)/,
    );
    expect(deploySource).not.toMatch(/compose_profile_enabled cnc-telegram && ! grep/);
    expect(deploySource).toContain('docker compose >= 2.24.4 is required');
    expect(deploySource).toMatch(/compose_profile_enabled cnc-telegram; then[\s\S]*require_compose_override_support/);
    expect(readFileSync(resolve(__dirname, 'templates/docker-compose.cnc-telegram-worker.yml'), 'utf8'))
      .toContain('profiles: !override ["cnc-telegram-glm"]');
    expect(deploySource).toMatch(/COMPOSE_FILE_ARGS=\(-f "\$COMPOSE_FILE"\)/);
    expect(deploySource).toMatch(/docker compose --env-file "\$ENV_FILE" "\$\{COMPOSE_FILE_ARGS\[@\]\}"/);
    expect(deploySource).toMatch(/git -C "\$REPO_DIR" rev-parse --verify HEAD/);
    expect(deploySource).toMatch(/export CNC_TELEGRAM_WORKER_IMAGE_REVISION="\$revision"/);
    expect(deploySource).toMatch(/docker_compose config --format json/);
    expect(deploySource).toContain('command != ["serve"]');
    expect(deploySource).toMatch(/ensure_worker_image_revision[\s\S]*assert_rendered_worker_serve_command/);
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

  it('fails closed instead of exposing unrestricted Telegram backfill helper', () => {
    const result = runCncWorker('reader', 'test', 'false', ['backfill', '3']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/backfill helper is disabled after Phase A/);
    expect(result.stdout).not.toMatch(/once --days/);
  });

  it('keeps disabled Telegram worker stopped without invoking Compose', () => {
    const result = runCncWorker('disabled');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/CNC Telegram worker is disabled/);
  });

  it('cleans up legacy GLM containers even when the worker role is disabled', () => {
    const result = runCncWorker('disabled', 'test', 'false', ['up'], true);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/stop glm-ocr-runner glm-ocr-llama glm-ocr-model-init/);
    expect(result.stdout).toMatch(/rm -f glm-ocr-runner glm-ocr-llama glm-ocr-model-init/);
    expect(result.stdout).not.toMatch(/up -d --build cnc-telegram-worker/);
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

  it('refuses a daemon worker command in the deploy helper source', () => {
    expect(cncWorkerSource).toContain('command daemon is forbidden after Phase A');
    expect(composeSource).toContain('command: ["serve"]');
    expect(composeSource).not.toContain('command: ["daemon"]');
  });

  it('refuses a daemon worker command in rendered Compose config', () => {
    const result = runCncWorker('reader', 'test', 'false', ['up'], false, 'daemon');

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/rendered worker command must be exactly serve/);
    expect(result.stdout).not.toMatch(/up -d --build cnc-telegram-worker/);
  });

  it('keeps GLM stopped by default and starts it only through explicit fallback', () => {
    const normal = runCncWorker('writer', 'prod');
    const legacy = runCncWorker('writer', 'prod', 'false', ['up'], true);
    const fallback = runCncWorker('writer', 'prod', 'false', ['up-glm']);

    expect(normal.status).toBe(0);
    expect(normal.stdout).toContain('profiles=cnc-telegram');
    expect(normal.stdout).toMatch(/up -d --build cnc-telegram-worker/);
    expect(normal.stdout).not.toMatch(/up -d --build glm-ocr-model-init/);
    expect(legacy.stderr).toContain('model cache is preserved');
    expect(legacy.stdout).toMatch(/stop glm-ocr-runner glm-ocr-llama glm-ocr-model-init/);
    expect(legacy.stdout).toMatch(/rm -f glm-ocr-runner glm-ocr-llama glm-ocr-model-init/);
    expect(legacy.stdout).toMatch(/up -d --build cnc-telegram-worker/);
    expect(fallback.status).toBe(0);
    expect(fallback.stdout).toContain('profiles=cnc-telegram,cnc-telegram-glm');
    expect(fallback.stdout).toContain('glm=true');
    expect(fallback.stdout).toContain('timeout=720');
    expect(fallback.stdout).toContain(
      'ocr=python -m cnc_telegram_worker.glm_ocr_client --image {image}',
    );
    expect(fallback.stdout).toMatch(
      /up -d --build --wait --wait-timeout 1800 glm-ocr-runner/,
    );
    expect(fallback.stdout).toMatch(
      /--wait-timeout 1800 glm-ocr-runner[\s\S]*up -d --build cnc-telegram-worker/,
    );
  });

  it('validates that a persisted GLM profile also selects the GLM client', () => {
    expect(checkEnvSource).toContain('COMPOSE_PROFILES=cnc-telegram-glm requires cnc-telegram');
    expect(checkEnvSource).toContain(
      'COMPOSE_PROFILES=cnc-telegram-glm requires CNC_OCR_COMMAND to use cnc_telegram_worker.glm_ocr_client',
    );
    expect(checkEnvSource).toContain(
      'COMPOSE_PROFILES=cnc-telegram-glm requires CNC_ENABLE_GLM_OCR=true',
    );
    expect(checkEnvSource).toContain(
      'COMPOSE_PROFILES=cnc-telegram-glm requires CNC_OCR_ENGINE=glm-ocr* for truthful source fingerprints',
    );
    const reverseInvalid = runCheckEnv({ CNC_ENABLE_GLM_OCR: 'true' });
    expect(reverseInvalid.status).toBe(1);
    expect(reverseInvalid.stderr).toContain(
      'CNC_ENABLE_GLM_OCR=true requires COMPOSE_PROFILES to include cnc-telegram-glm',
    );

    const valid = runCheckEnv({
      COMPOSE_PROFILES: 'cnc-telegram,cnc-telegram-glm',
      CNC_ENABLE_GLM_OCR: 'true',
      CNC_OCR_COMMAND: 'python -m cnc_telegram_worker.glm_ocr_client --image {image}',
      CNC_OCR_COMMAND_TIMEOUT_SECONDS: '720',
      CNC_OCR_ENGINE: 'glm-ocr-0.9b-q8',
    });
    expect(valid.status).toBe(0);

    const invalidTimeoutOrder = runCheckEnv({
      COMPOSE_PROFILES: 'cnc-telegram,cnc-telegram-glm',
      CNC_ENABLE_GLM_OCR: 'true',
      CNC_OCR_COMMAND: 'python -m cnc_telegram_worker.glm_ocr_client --image {image}',
      GLM_OCR_TIMEOUT_SECONDS: '700',
      GLM_OCR_CLIENT_TIMEOUT_SECONDS: '660',
      CNC_OCR_COMMAND_TIMEOUT_SECONDS: '720',
      CNC_OCR_ENGINE: 'glm-ocr-0.9b-q8',
    });
    expect(invalidTimeoutOrder.status).toBe(1);
    expect(invalidTimeoutOrder.stderr).toContain(
      'GLM_OCR_CLIENT_TIMEOUT_SECONDS must exceed GLM_OCR_TIMEOUT_SECONDS',
    );
  });
});
