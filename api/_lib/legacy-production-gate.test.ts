import type { VercelRequest, VercelResponse } from '@vercel/node';
import { describe, expect, it, vi } from 'vitest';
import {
  handleDisabledLegacyVercelFunction,
  LEGACY_DISABLED_CODE,
  LEGACY_DISABLED_STATUS,
  shouldDisableLegacyVercelFunction,
} from './legacy-production-gate';

describe('legacy Vercel Function production gate', () => {
  it('allows local and test environments by default', () => {
    expect(shouldDisableLegacyVercelFunction({ NODE_ENV: 'test' })).toBe(false);
    expect(shouldDisableLegacyVercelFunction({ NODE_ENV: 'development' })).toBe(false);
    expect(shouldDisableLegacyVercelFunction({})).toBe(false);
  });

  it('disables production and staging-like environments unless explicitly enabled', () => {
    expect(shouldDisableLegacyVercelFunction({ NODE_ENV: 'production' })).toBe(true);
    expect(shouldDisableLegacyVercelFunction({ VERCEL_ENV: 'production' })).toBe(true);
    expect(shouldDisableLegacyVercelFunction({ VERCEL_ENV: 'preview' })).toBe(true);
    expect(shouldDisableLegacyVercelFunction({ APP_ENV: 'staging' })).toBe(true);
    expect(shouldDisableLegacyVercelFunction({ BACKEND_ENV: 'stage' })).toBe(true);

    expect(
      shouldDisableLegacyVercelFunction({
        VERCEL_ENV: 'production',
        ENABLE_LEGACY_VERCEL_FUNCTIONS: 'true',
      }),
    ).toBe(false);
    expect(
      shouldDisableLegacyVercelFunction({
        VERCEL_ENV: 'preview',
        ENABLE_LEGACY_API: '1',
      }),
    ).toBe(false);
  });

  it('returns stable disabled ApiError-like JSON without secret-bearing details', () => {
    const res = createResponse();

    const result = handleDisabledLegacyVercelFunction(
      {
        method: 'POST',
        headers: { 'x-request-id': 'req_legacy_disabled' },
      } as VercelRequest,
      res as unknown as VercelResponse,
      {
        VERCEL_ENV: 'production',
        GAS_API_KEY: 'must-not-leak',
        HASURA_GRAPHQL_ADMIN_SECRET: 'must-not-leak',
      },
    );

    expect(result).toEqual({ disabled: true, requestId: 'req_legacy_disabled' });
    expect(res.statusCode).toBe(LEGACY_DISABLED_STATUS);
    expect(res.headers['x-request-id']).toBe('req_legacy_disabled');
    expect(res.headers['Cache-Control']).toBe('no-store, max-age=0');
    expect(res.body).toEqual({
      error: {
        code: LEGACY_DISABLED_CODE,
        message: 'Legacy Vercel Function is disabled. Use the NestJS backend API.',
        requestId: 'req_legacy_disabled',
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('must-not-leak');
  });

  it('keeps CORS preflight available without executing legacy logic', () => {
    const res = createResponse();

    const result = handleDisabledLegacyVercelFunction(
      {
        method: 'OPTIONS',
        headers: {},
      } as VercelRequest,
      res as unknown as VercelResponse,
      { VERCEL_ENV: 'production' },
    );

    expect(result.disabled).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();
  });
});

export function createResponse() {
  const response = {
    headers: {} as Record<string, string>,
    statusCode: 0,
    body: undefined as unknown,
    setHeader: vi.fn((key: string, value: string) => {
      response.headers[key] = value;
      return response;
    }),
    status: vi.fn((statusCode: number) => {
      response.statusCode = statusCode;
      return response;
    }),
    json: vi.fn((body: unknown) => {
      response.body = body;
      return response;
    }),
    end: vi.fn(() => response),
  };

  return response;
}
