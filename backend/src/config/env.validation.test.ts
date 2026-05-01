import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation';

describe('backend env validation', () => {
  it('uses safe local defaults without DB settings', () => {
    expect(validateEnv({})).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      FRONTEND_ORIGIN: 'http://localhost:5173',
      LOG_LEVEL: 'info',
      TRUST_PROXY: false,
      REQUEST_ID_HEADER: 'x-request-id',
    });
  });

  it('parses numeric and boolean env values', () => {
    expect(
      validateEnv({
        NODE_ENV: 'test',
        PORT: '3100',
        FRONTEND_ORIGIN: 'http://localhost:5173',
        TRUST_PROXY: 'true',
        VLM_MAX_UPLOAD_MB: '25',
        VLM_ALLOWED_MIME_TYPES: 'image/png,image/jpeg',
      }),
    ).toMatchObject({
      NODE_ENV: 'test',
      PORT: 3100,
      TRUST_PROXY: true,
      VLM_MAX_UPLOAD_MB: 25,
      VLM_ALLOWED_MIME_TYPES: 'image/png,image/jpeg',
    });
  });

  it('requires explicit frontend origin in production', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow(
      /FRONTEND_ORIGIN is required in production/,
    );
  });

  it('rejects invalid port and origin values', () => {
    expect(() =>
      validateEnv({
        PORT: '70000',
        FRONTEND_ORIGIN: 'not-a-url',
      }),
    ).toThrow(/Invalid backend environment/);
  });

  it('rejects invalid VLM upload limits', () => {
    expect(() =>
      validateEnv({
        VLM_MAX_UPLOAD_MB: '0',
      }),
    ).toThrow(/VLM_MAX_UPLOAD_MB/);
    expect(() =>
      validateEnv({
        VLM_ALLOWED_MIME_TYPES: '',
      }),
    ).toThrow(/VLM_ALLOWED_MIME_TYPES/);
  });
});
