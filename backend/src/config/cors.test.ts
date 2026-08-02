import { describe, expect, it } from 'vitest';
import { createCorsRuntimeOptions, isOriginAllowed, parseCorsOrigins } from './cors';
import { validateEnv } from './env.validation';

describe('backend CORS config', () => {
  it('parses comma-separated allowlist', () => {
    expect(parseCorsOrigins('http://localhost:5173, https://erp.example.com')).toEqual([
      'http://localhost:5173',
      'https://erp.example.com',
    ]);
  });

  it('uses frontend origin as default allowlist', () => {
    const env = validateEnv({
      FRONTEND_ORIGIN: 'http://localhost:5173',
    });

    expect(createCorsRuntimeOptions(env)).toEqual({
      origins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
      credentials: true,
    });
  });

  it('allows local Vite origins for stage diagnostics', () => {
    const env = validateEnv({
      NODE_ENV: 'production',
      FRONTEND_ORIGIN: 'https://app-test.mebelkz.app',
      CORS_ALLOWED_ORIGINS: 'https://app-test.mebelkz.app',
      BACKEND_RATE_LIMIT_STORE: 'redis',
      RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
    });

    expect(createCorsRuntimeOptions(env).origins).toEqual([
      'https://app-test.mebelkz.app',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
  });

  it('does not add local origins to production frontends', () => {
    const env = validateEnv({
      NODE_ENV: 'production',
      FRONTEND_ORIGIN: 'https://app.mebelkz.app',
      CORS_ALLOWED_ORIGINS: 'https://app.mebelkz.app',
      BACKEND_RATE_LIMIT_STORE: 'redis',
      RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
    });

    expect(createCorsRuntimeOptions(env).origins).toEqual(['https://app.mebelkz.app']);
  });

  it('rejects wildcard origin when credentials are enabled', () => {
    expect(() =>
      validateEnv({
        CORS_ALLOWED_ORIGINS: '*',
        CORS_ALLOW_CREDENTIALS: 'true',
      }),
    ).toThrow(/cannot contain \*/);
  });

  it('checks request origin against allowlist', () => {
    const allowedOrigins = ['http://localhost:5173'];

    expect(isOriginAllowed(undefined, allowedOrigins)).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', allowedOrigins)).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', allowedOrigins)).toBe(false);
  });
});
