#!/usr/bin/env node

const {
  compareRuntimeConfigFeatures,
  formatEnabledFeatures,
  readJsonFile,
  validateRuntimeConfig,
} = require('./runtime-config-canary-lib');

const SECRET_PATTERN =
  /(DATABASE_URL|JWT_|SECRET|TOKEN|PASSWORD|PEPPER|API_KEY|CLIENT_SECRET|AUTH0_|GAS_|VLM_API_URL|HASURA_ADMIN_SECRET)/i;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.frontendUrl) {
    usageAndExit();
  }

  const frontendUrl = normalizeBaseUrl(args.frontendUrl);
  const runtimeConfigUrl = `${frontendUrl}/runtime-config.json`;
  const runtimeConfig = await fetchJson(runtimeConfigUrl, 'runtime config');
  const runtimeErrors = validateRuntimeConfig(runtimeConfig, {
    label: runtimeConfigUrl,
    requireCompleteFeatures: true,
  });

  if (args.expect) {
    const expected = readJsonFile(args.expect);
    runtimeErrors.push(
      ...compareRuntimeConfigFeatures(runtimeConfig, expected, runtimeConfigUrl),
    );
  }

  assertNoErrors(runtimeErrors, 'Runtime config gate failed');
  assertNoSecretLikeBody(runtimeConfig, runtimeConfigUrl);

  console.log(`Runtime config ok: ${runtimeConfigUrl}`);
  console.log(`Enabled features: ${formatEnabledFeatures(runtimeConfig)}`);

  const backendUrl = normalizeBaseUrl(args.backendUrl || runtimeConfig.apiUrl || '');
  if (!backendUrl) {
    console.log('Backend health skipped: pass --backend-url or set runtime config apiUrl.');
  } else {
    await smokeHealth(`${backendUrl}/health/live`, 'live health');
    await smokeHealth(`${backendUrl}/health/ready`, 'ready health');
  }

  if (args.checkLegacy) {
    await smokeLegacyRollbackPaths(frontendUrl);
  }

  console.log('Staging gates smoke ok.');
}

async function smokeHealth(url, label) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`${label} failed at ${url}: HTTP ${response.status}`);
  }

  const body = await response.json().catch(() => ({}));
  assertNoSecretLikeBody(body, url);

  const status = typeof body.status === 'string' ? body.status : 'ok';
  console.log(`${label} ok: ${url} (${status})`);
}

async function smokeLegacyRollbackPaths(frontendUrl) {
  const paths = [
    '/api/login',
    '/api/refresh',
    '/api/users/create',
    '/api/users/change-password',
    '/api/order-export-to-drive',
    '/api/vlm/health',
    '/api/vlm/upload',
    '/api/vlm/analyze',
  ];

  for (const path of paths) {
    const url = `${frontendUrl}${path}`;
    const response = await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
    }).catch(async () => fetch(url, { method: 'OPTIONS', cache: 'no-store' }));

    if (response.status === 404) {
      throw new Error(`legacy rollback path missing: ${url}`);
    }

    console.log(`legacy rollback path reachable: ${path} (HTTP ${response.status})`);
  }
}

async function fetchJson(url, label) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`${label} request failed at ${url}: HTTP ${response.status}`);
  }

  return response.json();
}

function assertNoSecretLikeBody(body, source) {
  const serialized = JSON.stringify(body);
  if (SECRET_PATTERN.test(serialized)) {
    throw new Error(`${source}: response contains secret-like field or value`);
  }
}

function assertNoErrors(errors, message) {
  if (errors.length === 0) return;

  console.error(message);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

function parseArgs(rawArgs) {
  const result = {
    checkLegacy: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg.startsWith('--frontend-url=')) {
      result.frontendUrl = arg.slice('--frontend-url='.length);
    } else if (arg === '--frontend-url') {
      result.frontendUrl = rawArgs[index + 1];
      index += 1;
    } else if (arg.startsWith('--backend-url=')) {
      result.backendUrl = arg.slice('--backend-url='.length);
    } else if (arg === '--backend-url') {
      result.backendUrl = rawArgs[index + 1];
      index += 1;
    } else if (arg.startsWith('--expect=')) {
      result.expect = arg.slice('--expect='.length);
    } else if (arg === '--expect') {
      result.expect = rawArgs[index + 1];
      index += 1;
    } else if (arg === '--check-legacy') {
      result.checkLegacy = true;
    } else if (arg === '--help' || arg === '-h') {
      usageAndExit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      usageAndExit(1);
    }
  }

  return result;
}

function normalizeBaseUrl(value) {
  if (!value || typeof value !== 'string') return '';

  return value.trim().replace(/\/+$/, '');
}

function usageAndExit(code = 1) {
  console.error(
    [
      'Usage:',
      '  node scripts/smoke-staging-gates.js --frontend-url <url> --backend-url <url> --expect <example-json>',
      '',
      'Optional:',
      '  --check-legacy   HEAD/OPTIONS check legacy rollback paths are not 404',
    ].join('\n'),
  );
  process.exit(code);
}

main().catch((error) => {
  console.error(`Staging gates smoke failed: ${error.message}`);
  process.exit(1);
});
