import { describe, expect, it } from 'vitest';
import {
  buildStageCutoverEnv,
  parseDotenvFile,
  redactCommandForLog,
} from '../../scripts/stage-cutover-smoke-lib.js';
import { buildStageCutoverCommands, parseArgs } from '../../scripts/stage-cutover-smoke.js';

describe('stage cutover smoke helpers', () => {
  it('loads only allowlisted env values and keeps secrets available without logging them', () => {
    const parsed = parseDotenvFile([
      'VERCEL_AUTOMATION_BYPASS_SECRET=secret-value',
      'FRONTEND_PAGES_STAGE_CREATE_USER=true',
      'DATABASE_URL=postgres://must-not-load',
      'UNRELATED=value',
    ].join('\n'));

    const env = buildStageCutoverEnv(parsed, {
      frontendUrl: 'https://app-test.mebelkz.app',
      backendApiUrl: 'https://backend-test.mebelkz.app/api/v1',
      backendBaseUrl: 'https://backend-test.mebelkz.app',
      postgresContainer: 'erp_test-postgresdb-1',
    });

    expect(env.VERCEL_AUTOMATION_BYPASS_SECRET).toBe('secret-value');
    expect(env.FRONTEND_PAGES_STAGE_CREATE_USER).toBe('true');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.UNRELATED).toBeUndefined();
    expect(env.FRONTEND_PAGES_STAGE_FRONTEND_URL).toBe('https://app-test.mebelkz.app');
    expect(env.FRONTEND_PAGES_STAGE_BACKEND_API_URL).toBe('https://backend-test.mebelkz.app/api/v1');
    expect(env.FRONTEND_PAGES_STAGE_POSTGRES_CONTAINER).toBe('erp_test-postgresdb-1');
    expect(env.PAYMENTS_STAGE_POSTGRES_CONTAINER).toBe('erp_test-postgresdb-1');
    expect(env.PRODUCTION_ACTIONS_STAGE_POSTGRES_CONTAINER).toBe('erp_test-postgresdb-1');
    expect(env.CLIENT_PHONES_STAGE_POSTGRES_CONTAINER).toBe('erp_test-postgresdb-1');
    expect(env.DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER).toBe('erp_test-postgresdb-1');
    expect(env.PLAYWRIGHT_SKIP_WEB_SERVER).toBe('true');
  });

  it('redacts known secret values from logged commands', () => {
    const text = redactCommandForLog(
      'VERCEL_AUTOMATION_BYPASS_SECRET=secret-value npm run smoke:staging-gates',
      { VERCEL_AUTOMATION_BYPASS_SECRET: 'secret-value' },
    );

    expect(text).toContain('VERCEL_AUTOMATION_BYPASS_SECRET=[redacted]');
    expect(text).not.toContain('secret-value');
  });
});

describe('stage cutover smoke command plan', () => {
  it('runs gates before mutating canaries and local regression last', () => {
    const commands = buildStageCutoverCommands({
      frontendUrl: 'https://app-test.mebelkz.app',
      backendBaseUrl: 'https://backend-test.mebelkz.app',
      backendApiUrl: 'https://backend-test.mebelkz.app/api/v1',
    }).map((command) => command.label);

    expect(commands).toEqual([
      'runtime config all-on expectation',
      'staging runtime and health gates',
      'frontend pages stage canary',
      'payments stage canary',
      'production actions stage canary',
      'client phones stage canary',
      'deadline engine stage canary',
      'local cutover regression specs',
      'local order-save command boundary regression',
      'unit regression suite',
      'production build',
    ]);
  });

  it('runs local cutover regressions with all required backend flags', () => {
    const command = buildStageCutoverCommands({
      frontendUrl: 'https://app-test.mebelkz.app',
      backendBaseUrl: 'https://backend-test.mebelkz.app',
      backendApiUrl: 'https://backend-test.mebelkz.app/api/v1',
    }).find((step) => step.label === 'local cutover regression specs');

    expect(command).toMatchObject({
      command: 'npx',
      args: [
        'playwright',
        'test',
        'tests/users-backend-cutover.spec.ts',
        'tests/order-export-backend-cutover.spec.ts',
        'tests/vlm-backend-cutover.spec.ts',
        'tests/payments-backend-cutover.spec.ts',
        'tests/production-actions-backend-cutover.spec.ts',
        'tests/client-phones-backend-cutover.spec.ts',
        '--project=chromium',
      ],
      env: {
        PLAYWRIGHT_SKIP_WEB_SERVER: 'false',
        VITE_USE_BACKEND_AUTH: 'true',
        VITE_USE_BACKEND_PERMISSIONS: 'true',
        VITE_USE_BACKEND_USERS: 'true',
        VITE_USE_BACKEND_ORDER_EXPORT: 'true',
        VITE_USE_BACKEND_VLM: 'true',
        VITE_USE_BACKEND_PAYMENTS: 'true',
        VITE_USE_BACKEND_PRODUCTION_ACTIONS: 'true',
        VITE_USE_BACKEND_CLIENT_PHONES: 'true',
      },
    });
  });

  it('isolates the order-save command-boundary regression flag from other local specs', () => {
    const command = buildStageCutoverCommands({
      frontendUrl: 'https://app-test.mebelkz.app',
      backendBaseUrl: 'https://backend-test.mebelkz.app',
      backendApiUrl: 'https://backend-test.mebelkz.app/api/v1',
    }).find((step) => step.label === 'local order-save command boundary regression');

    expect(command).toMatchObject({
      command: 'npx',
      args: [
        'playwright',
        'test',
        'tests/order-save-backend-command-boundary.spec.ts',
        '--project=chromium',
      ],
      env: {
        PLAYWRIGHT_SKIP_WEB_SERVER: 'false',
        VITE_USE_BACKEND_ORDERS_WRITE: 'true',
      },
    });
  });
});

describe('stage cutover smoke argument parsing', () => {
  it('rejects missing values for options that require one', () => {
    expect(() => parseArgs(['--env-file'])).toThrow('Missing value for --env-file');
  });

  it('rejects flag-looking values for options that require one', () => {
    expect(() => parseArgs(['--frontend-url', '--dry-run'])).toThrow(
      'Missing value for --frontend-url',
    );
  });
});
