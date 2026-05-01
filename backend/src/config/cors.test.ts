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
      origins: ['http://localhost:5173'],
      credentials: true,
    });
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
