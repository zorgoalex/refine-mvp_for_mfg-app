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
      'unit regression suite',
      'production build',
    ]);
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
