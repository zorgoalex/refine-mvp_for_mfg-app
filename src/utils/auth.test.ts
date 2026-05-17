import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacyApiRoutes } from '../api/legacyApiRoutes';

describe('auth refresh cutover behavior', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('localStorage', createLocalStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses backend cookie refresh and never calls legacy refresh endpoint in backend auth mode', async () => {
    vi.doMock('../config/featureFlags', () => ({
      featureFlags: {
        useBackendAuth: true,
        useBackendPermissions: true,
        useBackendOrdersRead: false,
        useBackendOrdersWrite: false,
        useBackendPayments: false,
        useBackendClientPhones: false,
        useBackendProductionActions: false,
        useBackendOrderExport: false,
        useBackendUsers: false,
        useBackendVlm: false,
        useBackendReferences: false,
        enableLegacyHasura: true,
      },
    }));
    const fetchMock = mockFetch({
      accessToken: 'backend-access-token',
      user: {
        id: '1',
        username: 'admin',
        role: 'admin',
        permissions: ['orders.view'],
      },
    });
    const { refreshAccessToken } = await import('./auth');
    const { authSession } = await import('../api/authSession');

    await expect(refreshAccessToken()).resolves.toBe('backend-access-token');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/refresh',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(legacyApiRoutes.auth.refresh);
    expect(authSession.getAccessToken()).toBe('backend-access-token');
    expect(localStorage.getItem('refresh_token')).toBeNull();
  });
});

function mockFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function createLocalStorageMock(): Storage {
  const storage = new Map<string, string>();

  return {
    get length() {
      return storage.size;
    },
    clear: vi.fn(() => storage.clear()),
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(storage.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, String(value));
    }),
  };
}
