import type { VercelRequest, VercelResponse } from '@vercel/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from './runtime-config';

const RUNTIME_CONFIG_ENV_KEYS = [
  'RUNTIME_CONFIG_API_URL',
  'RUNTIME_CONFIG_BACKEND_AUTH',
  'RUNTIME_CONFIG_BACKEND_PERMISSIONS',
  'RUNTIME_CONFIG_BACKEND_ORDERS',
  'RUNTIME_CONFIG_BACKEND_ORDERS_READ',
  'RUNTIME_CONFIG_BACKEND_ORDERS_WRITE',
  'RUNTIME_CONFIG_BACKEND_PAYMENTS',
  'RUNTIME_CONFIG_BACKEND_CLIENT_PHONES',
  'RUNTIME_CONFIG_BACKEND_PRODUCTION_ACTIONS',
  'RUNTIME_CONFIG_BACKEND_DEADLINES',
  'RUNTIME_CONFIG_BACKEND_ORDER_EXPORT',
  'RUNTIME_CONFIG_BACKEND_USERS',
  'RUNTIME_CONFIG_BACKEND_VLM',
  'RUNTIME_CONFIG_BACKEND_REFERENCES',
  'RUNTIME_CONFIG_BACKEND_BAZIS',
  'RUNTIME_CONFIG_ENABLE_LEGACY_HASURA',
];

describe('runtime-config handler', () => {
  beforeEach(() => {
    for (const key of RUNTIME_CONFIG_ENV_KEYS) {
      vi.stubEnv(key, '');
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('serves fail-closed runtime config without caching', () => {
    const res = createResponse();

    handler({ method: 'GET' } as VercelRequest, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store, max-age=0');
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(res.body).toMatchObject({
      apiUrl: '',
      features: {
        backendAuth: false,
        backendPermissions: false,
        backendOrdersRead: false,
        backendOrdersWrite: false,
        backendPayments: false,
        backendClientPhones: false,
        backendProductionActions: false,
        backendDeadlines: false,
        backendOrderExport: false,
        backendUsers: false,
        backendVlm: false,
        backendReferences: false,
        backendCut: false,
        bazisImport: false,
        enableLegacyHasura: true,
      },
    });
  });

  it('uses runtime env when explicitly set', () => {
    vi.stubEnv('RUNTIME_CONFIG_API_URL', 'https://api.example.test/');
    vi.stubEnv('RUNTIME_CONFIG_BACKEND_AUTH', 'true');
    vi.stubEnv('RUNTIME_CONFIG_BACKEND_DEADLINES', 'true');
    vi.stubEnv('RUNTIME_CONFIG_ENABLE_LEGACY_HASURA', 'false');

    const res = createResponse();

    handler({ method: 'GET' } as VercelRequest, res as unknown as VercelResponse);

    expect(res.body).toMatchObject({
      apiUrl: 'https://api.example.test',
      features: {
        backendAuth: true,
        backendDeadlines: true,
        enableLegacyHasura: false,
      },
    });
  });

  it('supports HEAD and rejects unsupported methods', () => {
    const headRes = createResponse();
    handler({ method: 'HEAD' } as VercelRequest, headRes as unknown as VercelResponse);
    expect(headRes.statusCode).toBe(200);
    expect(headRes.body).toBeUndefined();

    const postRes = createResponse();
    handler({ method: 'POST' } as VercelRequest, postRes as unknown as VercelResponse);
    expect(postRes.statusCode).toBe(405);
    expect(postRes.headers.Allow).toBe('GET, HEAD, OPTIONS');
    expect(postRes.body).toEqual({ error: 'Method not allowed' });
  });
});

function createResponse() {
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
