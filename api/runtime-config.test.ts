import type { VercelRequest, VercelResponse } from '@vercel/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from './runtime-config';

const RUNTIME_CONFIG_ENV_KEYS = [
  'RUNTIME_CONFIG_API_URL',
  'RUNTIME_CONFIG_HASURA_URL',
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
  'RUNTIME_CONFIG_BAZIS_CUT',
  'RUNTIME_CONFIG_ORDER_STATUS_BOARD',
  'RUNTIME_CONFIG_ORDER_REALTIME',
  'RUNTIME_CONFIG_CNC_TELEGRAM',
  'RUNTIME_CONFIG_ENABLE_LEGACY_HASURA',
  'RUNTIME_CONFIG_UI_EVOLUTION',
  'RUNTIME_CONFIG_UI_FORCE_LEGACY',
  'VERCEL_ENV',
  'VERCEL_GIT_COMMIT_REF',
  'RUNTIME_CONFIG_BUILD_SHA',
  'RUNTIME_CONFIG_PERFORMANCE_RUM',
  'RUNTIME_CONFIG_ORDER_LIFECYCLE_ENABLED',
  'RUNTIME_CONFIG_ORDER_LIFECYCLE_PERCENT',
  'RUNTIME_CONFIG_ORDER_LIFECYCLE_SALT',
  'RUNTIME_CONFIG_ORDER_LIFECYCLE_VERSION',
  'VERCEL_GIT_COMMIT_SHA',
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
      deployment: { gitCommitSha: null },
      apiUrl: '',
      build: { sha: '' },
      hasuraUrl: '',
      ui: {
        evolutionEnabled: false,
        forceLegacy: false,
      },
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
        bazisCut: false,
        bazisImport: false,
        cncTelegram: false,
        orderRealtime: false,
        enableLegacyHasura: true,
      },
      observability: { performanceRum: false },
      rollouts: {
        orderLifecycleV2: {
          enabled: false,
          percent: 0,
          allocationSalt: '',
          configVersion: '',
        },
      },
    });
  });

  it('publishes only a valid immutable Vercel commit SHA', () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'A154FEF554948D9643630A827CB1AA4795117E54');
    const validRes = createResponse();
    handler({ method: 'GET' } as VercelRequest, validRes as unknown as VercelResponse);
    expect(validRes.body).toMatchObject({
      deployment: { gitCommitSha: 'a154fef554948d9643630a827cb1aa4795117e54' },
    });

    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'not-an-immutable-sha');
    const invalidRes = createResponse();
    handler({ method: 'GET' } as VercelRequest, invalidRes as unknown as VercelResponse);
    expect(invalidRes.body).toMatchObject({ deployment: { gitCommitSha: null } });
  });

  it('uses runtime env when explicitly set', () => {
    vi.stubEnv('RUNTIME_CONFIG_API_URL', 'https://api.example.test/');
    vi.stubEnv('RUNTIME_CONFIG_HASURA_URL', 'https://hasura.example.test/v1/graphql/');
    vi.stubEnv('RUNTIME_CONFIG_BACKEND_AUTH', 'true');
    vi.stubEnv('RUNTIME_CONFIG_BACKEND_DEADLINES', 'true');
    vi.stubEnv('RUNTIME_CONFIG_BAZIS_CUT', 'true');
    vi.stubEnv('RUNTIME_CONFIG_CNC_TELEGRAM', 'true');
    vi.stubEnv('RUNTIME_CONFIG_ORDER_REALTIME', 'true');
    vi.stubEnv('RUNTIME_CONFIG_ENABLE_LEGACY_HASURA', 'false');
    vi.stubEnv('RUNTIME_CONFIG_UI_EVOLUTION', 'true');
    vi.stubEnv('RUNTIME_CONFIG_BUILD_SHA', 'abcdef123456');
    vi.stubEnv('RUNTIME_CONFIG_PERFORMANCE_RUM', 'true');
    vi.stubEnv('RUNTIME_CONFIG_ORDER_LIFECYCLE_ENABLED', 'true');
    vi.stubEnv('RUNTIME_CONFIG_ORDER_LIFECYCLE_PERCENT', '5');
    vi.stubEnv('RUNTIME_CONFIG_ORDER_LIFECYCLE_SALT', 'salt-v1');
    vi.stubEnv('RUNTIME_CONFIG_ORDER_LIFECYCLE_VERSION', 'lifecycle-v1');

    const res = createResponse();

    handler({ method: 'GET' } as VercelRequest, res as unknown as VercelResponse);

    expect(res.body).toMatchObject({
      apiUrl: 'https://api.example.test',
      build: { sha: 'abcdef123456' },
      hasuraUrl: 'https://hasura.example.test/v1/graphql',
      ui: {
        evolutionEnabled: true,
        forceLegacy: false,
      },
      features: {
        backendAuth: true,
        backendDeadlines: true,
        bazisCut: true,
        cncTelegram: true,
        orderRealtime: true,
        enableLegacyHasura: false,
      },
      observability: { performanceRum: true },
      rollouts: {
        orderLifecycleV2: {
          enabled: true,
          percent: 5,
          allocationSalt: 'salt-v1',
          configVersion: 'lifecycle-v1',
        },
      },
    });
  });

  it('uses the stage backend when stage runtime env is missing', () => {
    const res = createResponse();

    handler(
      { method: 'GET', headers: { host: 'app-test.mebelkz.app' } } as VercelRequest,
      res as unknown as VercelResponse,
    );

    expect(res.body).toMatchObject({
      apiUrl: 'https://backend-test.mebelkz.app',
      hasuraUrl: 'https://hasura-test.mebelkz.app/v1/graphql',
    });
  });

  it('uses the stage backend for Vercel previews without overriding explicit env', () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const previewRes = createResponse();
    handler({ method: 'GET', headers: {} } as VercelRequest, previewRes as unknown as VercelResponse);
    expect(previewRes.body).toMatchObject({ apiUrl: 'https://backend-test.mebelkz.app' });

    vi.stubEnv('RUNTIME_CONFIG_API_URL', 'https://explicit.example.test/');
    const explicitRes = createResponse();
    handler({ method: 'GET', headers: {} } as VercelRequest, explicitRes as unknown as VercelResponse);
    expect(explicitRes.body).toMatchObject({ apiUrl: 'https://explicit.example.test' });
  });

  it('uses production Hasura for the production host', () => {
    const res = createResponse();
    handler(
      { method: 'GET', headers: { host: 'mebelkz.app' } } as VercelRequest,
      res as unknown as VercelResponse,
    );

    expect(res.body).toMatchObject({
      hasuraUrl: 'https://hasura-ovh.mebelkz.app/v1/graphql',
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
