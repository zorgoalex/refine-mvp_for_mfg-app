#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  buildStageCutoverEnv,
  readDotenvFile,
  redactCommandForLog,
} = require('./stage-cutover-smoke-lib');

function buildStageCutoverCommands(options) {
  const runtimeUrl = `${options.frontendUrl}/runtime-config.json`;
  return [
    {
      label: 'runtime config all-on expectation',
      command: 'npm',
      args: [
        'run',
        'smoke:runtime-config',
        '--',
        '--url',
        runtimeUrl,
        '--expect',
        'docs/runtime-config/canary/11-deadlines.json',
      ],
    },
    {
      label: 'staging runtime and health gates',
      command: 'npm',
      args: [
        'run',
        'smoke:staging-gates',
        '--',
        '--frontend-url',
        options.frontendUrl,
        '--backend-url',
        options.backendBaseUrl,
        '--expect',
        'docs/runtime-config/canary/11-deadlines.json',
      ],
    },
    {
      label: 'frontend pages stage canary',
      command: 'npm',
      args: ['run', 'test:e2e:frontend-pages-stage-canary'],
    },
    {
      label: 'payments stage canary',
      command: 'npm',
      args: ['run', 'test:e2e:payments-stage-canary'],
    },
    {
      label: 'production actions stage canary',
      command: 'npm',
      args: ['run', 'test:e2e:production-actions-stage-canary'],
    },
    {
      label: 'client phones stage canary',
      command: 'npm',
      args: ['run', 'test:e2e:client-phones-stage-canary'],
    },
    {
      label: 'deadline engine stage canary',
      command: 'npm',
      args: ['run', 'test:e2e:deadline-engine-stage-canary'],
    },
    {
      label: 'local cutover regression specs',
      command: 'npx',
      args: [
        'playwright',
        'test',
        'tests/users-backend-cutover.spec.ts',
        'tests/order-export-backend-cutover.spec.ts',
        'tests/vlm-backend-cutover.spec.ts',
        'tests/payments-backend-cutover.spec.ts',
        'tests/production-actions-backend-cutover.spec.ts',
        'tests/order-save-backend-command-boundary.spec.ts',
        '--project=chromium',
      ],
    },
    {
      label: 'unit regression suite',
      command: 'npm',
      args: ['test'],
    },
    {
      label: 'production build',
      command: 'npm',
      args: ['run', 'build'],
    },
  ];
}

function parseArgs(rawArgs) {
  const options = {
    frontendUrl: 'https://app-test.mebelkz.app',
    backendBaseUrl: 'https://backend-test.mebelkz.app',
    backendApiUrl: 'https://backend-test.mebelkz.app/api/v1',
    postgresContainer: 'erp_test-postgresdb-1',
    envFile: '/home/ovhtest/projects/erp_dev/.env',
    dryRun: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    const readValue = () => rawArgs[++index];
    if (arg === '--frontend-url') options.frontendUrl = readValue();
    else if (arg.startsWith('--frontend-url=')) options.frontendUrl = arg.slice(15);
    else if (arg === '--backend-base-url') options.backendBaseUrl = readValue();
    else if (arg.startsWith('--backend-base-url=')) options.backendBaseUrl = arg.slice(19);
    else if (arg === '--backend-api-url') options.backendApiUrl = readValue();
    else if (arg.startsWith('--backend-api-url=')) options.backendApiUrl = arg.slice(18);
    else if (arg === '--postgres-container') options.postgresContainer = readValue();
    else if (arg.startsWith('--postgres-container=')) options.postgresContainer = arg.slice(21);
    else if (arg === '--env-file') options.envFile = readValue();
    else if (arg.startsWith('--env-file=')) options.envFile = arg.slice(11);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') usageAndExit(0);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  for (const key of ['frontendUrl', 'backendBaseUrl', 'backendApiUrl', 'postgresContainer']) {
    if (!options[key]) throw new Error(`Missing ${key}`);
  }

  options.frontendUrl = trimTrailingSlash(options.frontendUrl);
  options.backendBaseUrl = trimTrailingSlash(options.backendBaseUrl);
  options.backendApiUrl = trimTrailingSlash(options.backendApiUrl);
  return options;
}

function run(options) {
  const dotenvValues = readDotenvFile(options.envFile);
  const childEnv = {
    ...process.env,
    ...buildStageCutoverEnv(dotenvValues, options),
  };
  const commands = buildStageCutoverCommands(options);

  for (const step of commands) {
    const printable = redactCommandForLog(`${step.command} ${step.args.join(' ')}`, childEnv);
    console.log(`\n== ${step.label} ==`);
    console.log(printable);
    if (options.dryRun) continue;
    const result = spawnSync(step.command, step.args, {
      cwd: path.resolve(__dirname, '..'),
      env: childEnv,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      throw new Error(`${step.label} failed with exit code ${result.status}`);
    }
  }
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function usageAndExit(code = 1) {
  console.error([
    'Usage:',
    '  node scripts/stage-cutover-smoke.js [options]',
    '',
    'Options:',
    '  --frontend-url https://app-test.mebelkz.app',
    '  --backend-base-url https://backend-test.mebelkz.app',
    '  --backend-api-url https://backend-test.mebelkz.app/api/v1',
    '  --postgres-container erp_test-postgresdb-1',
    '  --env-file /home/ovhtest/projects/erp_dev/.env',
    '  --dry-run',
  ].join('\n'));
  process.exit(code);
}

if (require.main === module) {
  try {
    run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`Stage cutover smoke failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildStageCutoverCommands,
  parseArgs,
  run,
};
