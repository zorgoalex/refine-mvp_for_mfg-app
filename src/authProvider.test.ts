import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('authProvider backend cutover mode', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_URL', '');
    vi.stubEnv('VITE_USE_BACKEND_AUTH', 'true');
    vi.stubGlobal('localStorage', createLocalStorageMock());
    vi.stubGlobal('fetch', vi.fn());
    vi.doMock('./config/featureFlags', () => ({
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.doUnmock('./config/featureFlags');
    vi.resetModules();
  });

  it('logs in through /api/v1/auth/login and stores no refresh token in localStorage', async () => {
    const fetchMock = mockFetch({
      accessToken: 'access-token',
      refreshToken: 'must-not-be-used',
      user: {
        id: '1',
        username: 'admin',
        role: 'superadmin',
        roleId: 2,
        permissions: ['orders.view', 'settings.manage'],
      },
    });
    const { authProvider } = await import('./authProvider');
    const { authSession } = await import('./api/authSession');

    await expect(
      authProvider.login?.({ username: 'admin', password: 'secret' }),
    ).resolves.toMatchObject({
      success: true,
      redirectTo: '/',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ username: 'admin', password: 'secret' }),
      }),
    );
    expect(authSession.getAccessToken()).toBe('access-token');
    expect(authSession.getUser()).toMatchObject({
      username: 'admin',
      permissions: ['orders.view', 'settings.manage'],
    });
    expect(localStorage.getItem('refresh_token')).toBeNull();
    expect(localStorage.getItem('access_token')).toBeNull();
  });

  it('restores a reloaded session through /api/v1/auth/refresh', async () => {
    const fetchMock = mockFetch({
      accessToken: 'new-access-token',
      user: {
        id: '10',
        username: 'manager',
        role: 'manager',
        roleId: 10,
        permissions: ['orders.view'],
      },
    });
    const { authProvider } = await import('./authProvider');
    const { authSession } = await import('./api/authSession');

    await expect(authProvider.check?.()).resolves.toMatchObject({
      authenticated: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/refresh',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    );
    expect(authSession.getAccessToken()).toBe('new-access-token');
  });

  it('returns backend permissions from authSession', async () => {
    const { authProvider } = await import('./authProvider');
    const { authSession } = await import('./api/authSession');
    authSession.setUser({
      id: '1',
      username: 'admin',
      role: 'admin',
      permissions: ['users.view', 'settings.manage'],
    });

    await expect(authProvider.getPermissions?.()).resolves.toEqual([
      'users.view',
      'settings.manage',
    ]);
  });

  it('keeps the session when backend logout fails — no fake logged-out state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'logout failed' },
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { authProvider } = await import('./authProvider');
    const { authSession } = await import('./api/authSession');
    authSession.setAccessToken('access-token');
    authSession.setUser({
      id: '1',
      username: 'admin',
      role: 'admin',
      permissions: ['orders.view'],
    });

    // The backend did not confirm the logout: the HttpOnly refresh cookie is
    // still alive, so the UI must keep the session and surface the failure.
    await expect(authProvider.logout?.({})).resolves.toMatchObject({
      success: false,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/logout',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    );
    expect(authSession.getAccessToken()).toBe('access-token');
    expect(authSession.getUser()).toMatchObject({ username: 'admin' });
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
