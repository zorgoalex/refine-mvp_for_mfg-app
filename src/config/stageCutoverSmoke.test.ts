import { describe, expect, it } from 'vitest';
import {
  buildStageCutoverEnv,
  parseDotenvFile,
  redactCommandForLog,
} from '../../scripts/stage-cutover-smoke-lib.js';

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
