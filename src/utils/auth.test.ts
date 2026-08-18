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
    vi.restoreAllMocks();
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

  it('keeps a newer login when proactive refresh of the older session fails', async () => {
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
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await refreshBlocked;
      return new Response(
        JSON.stringify({ error: { code: 'REFRESH_TOKEN_INVALID', message: 'Invalid refresh' } }),
        { status: 401, statusText: 'Unauthorized', headers: { 'Content-Type': 'application/json' } },
      );
    }));
    const { refreshAccessToken } = await import('./auth');
    const { authSession } = await import('../api/authSession');
    authSession.setAccessToken('old-token');
    authSession.setUser({ id: '1', username: 'old-user', role: 'admin' });

    const refresh = refreshAccessToken();
    authSession.setAccessToken('new-login-token');
    authSession.setUser({ id: '2', username: 'new-user', role: 'manager' });
    releaseRefresh();

    await expect(refresh).resolves.toBe('new-login-token');
    expect(authSession.getAccessToken()).toBe('new-login-token');
    expect(authSession.getUser()).toMatchObject({ id: '2', username: 'new-user' });
  });

  it('publishes session expiry when proactive backend refresh fails', async () => {
    vi.doMock('../config/featureFlags', () => ({
      featureFlags: {
        useBackendAuth: true,
        useBackendPermissions: true,
        enableLegacyHasura: true,
      },
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'REFRESH_TOKEN_EXPIRED', message: 'Expired' } }),
        { status: 401, statusText: 'Unauthorized', headers: { 'Content-Type': 'application/json' } },
      ),
    ));
    const { refreshAccessToken } = await import('./auth');
    const { authSession } = await import('../api/authSession');
    const expiredListener = vi.fn();
    authSession.subscribeExpired(expiredListener);
    authSession.setAccessToken('expired-access-token');

    await expect(refreshAccessToken()).resolves.toBeNull();

    expect(authSession.getAccessToken()).toBeNull();
    expect(expiredListener).toHaveBeenCalledTimes(1);
  });

  it('validates base64url JWT payloads without console validation noise', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { isTokenExpired } = await import('./auth');
      const token = jwtWithPayload({ exp: Math.floor(Date.now() / 1000) + 60, filler: 'о' });

      expect(isTokenExpired(token)).toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('treats malformed JWTs as expired without console validation noise', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { isTokenExpired } = await import('./auth');

      expect(isTokenExpired('not-a-jwt')).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
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

function jwtWithPayload(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}
